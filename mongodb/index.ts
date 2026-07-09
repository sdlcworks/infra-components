import { createHash, randomBytes } from "node:crypto";

import {
  CloudProvider,
  InfraComponent,
  connectionHandler,
  type CloudCredentialMongoDBAtlas,
} from "@sdlcworks/components";
import * as mongodbatlas from "@pulumi/mongodbatlas";
import * as pulumi from "@pulumi/pulumi";
import { z } from "zod";

import { MongoCI } from "../_internal/interfaces";

const CLOUD_BACKENDS = ["AWS", "GCP", "AZURE"] as const;
const DATABASE_ROLES = ["read", "readWrite"] as const;
const SYSTEM_DATABASES = new Set(["admin", "local", "config"]);
const SHARED_TIERS = new Set(["M0", "FLEX"]);
const CLUSTER_TYPE_REPLICASET = "REPLICASET";
const NETWORK_ACCESS_MODE_IP_ACCESS_LIST = "ip-access-list";
const DEFAULT_NODE_COUNT = 3;
const AUTH_DATABASE_ADMIN = "admin";
const CLUSTER_SCOPE_TYPE = "CLUSTER";
const CONNECTION_QUERY = "retryWrites=true&w=majority";
const PASSWORD_BYTE_LENGTH = 36;
const NAME_HASH_LENGTH = 8;
const DEFAULT_CLUSTER_NAME = "mongodb-cluster";
const DEFAULT_PROJECT_NAME = "mongodb-project";
const DEFAULT_CIDR_NAME = "cidr";
const DEFAULT_USER_NAME = "app-user";
const MAX_CLUSTER_NAME_LENGTH = 64;
const MAX_USERNAME_LENGTH = 63;
const MONGODB_SRV_SCHEME = "mongodb+srv://";
const MONGODB_ATLAS_PROVIDER = (
  CloudProvider.mongodbatlas ?? "mongodbatlas"
) as CloudProvider;
const CONFIG_SNAPSHOT_MISSING_ERROR =
  "mongodb: config snapshot missing from state; pulumi() must run before allocateWithPulumiCtx.";
const REPLACEMENT_FINGERPRINT_ERROR =
  "mongodb: replacement refused because project identity, cloud backend, or cluster region changed. This would replace or re-anchor the Atlas cluster and risk total data loss; create a new component instance and migrate explicitly.";
const CREDENTIAL_SHAPE_ERROR =
  "mongodb: Atlas credentials must include MONGODB_ATLAS_PUBLIC_KEY and MONGODB_ATLAS_PRIVATE_KEY.";
const ORG_ID_REQUIRED_ERROR =
  "mongodb: project creation requires MONGODB_ATLAS_ORG_ID in the mongodbatlas credential; supply it or set projectId to adopt an existing project.";

const AutoscalingComputeSchema = z.object({
  enabled: z.boolean(),
  minInstanceSize: z.string().min(1).optional(),
  maxInstanceSize: z.string().min(1).optional(),
}).strict();

const AutoscalingSchema = z.object({
  compute: AutoscalingComputeSchema.optional(),
  diskGbEnabled: z.boolean().optional(),
}).strict();

const ClusterSchema = z.object({
  region: z.string().min(1),
  instanceSize: z.string().min(1),
  nodeCount: z.number().int().min(1).default(DEFAULT_NODE_COUNT),
  diskGb: z.number().positive().optional(),
  autoscaling: AutoscalingSchema.optional(),
}).strict();

const NetworkAccessSchema = z.object({
  mode: z.literal(NETWORK_ACCESS_MODE_IP_ACCESS_LIST),
  cidrs: z.array(z.string().min(1)).min(
    1,
    "mongodb: networkAccess.cidrs must include at least one CIDR; use 0.0.0.0/0 explicitly for fully-open admission.",
  ),
}).strict();

const ConfigSchema = z.object({
  projectId: z.string().min(1).optional(),
  cloudBackend: z.enum(CLOUD_BACKENDS).default("AWS"),
  cluster: ClusterSchema,
  clusterType: z.literal(CLUSTER_TYPE_REPLICASET).default(CLUSTER_TYPE_REPLICASET),
  mongoDbMajorVersion: z.string().min(1),
  backupEnabled: z.boolean(),
  pitEnabled: z.boolean().default(false),
  terminationProtectionEnabled: z.boolean().default(true),
  networkAccess: NetworkAccessSchema,
  labels: z.record(z.string(), z.string()).default({}),
}).strict().superRefine((value, ctx) => {
  if (value.pitEnabled && !value.backupEnabled) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["pitEnabled"],
      message:
        "mongodb: pitEnabled requires backupEnabled because point-in-time restore is a backup capability.",
    });
  }

  if (!isSharedTier(value.cluster.instanceSize)) {
    return;
  }

  const hasDedicatedOnlyKnob =
    value.backupEnabled ||
    value.pitEnabled ||
    value.cluster.nodeCount !== DEFAULT_NODE_COUNT ||
    value.cluster.diskGb !== undefined ||
    value.cluster.autoscaling !== undefined;

  if (hasDedicatedOnlyKnob) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["cluster", "instanceSize"],
      message:
        `mongodb: shared tier "${value.cluster.instanceSize}" cannot use backupEnabled, pitEnabled, nodeCount changes, diskGb, or autoscaling; use a dedicated tier for those capabilities.`,
    });
  }
});

const AppComponentSchema = z.object({
  dbName: z.string().min(1),
  roles: z.array(z.enum(DATABASE_ROLES)).default(["readWrite"]),
}).strict();

const AllocationSchema = z.object({
  dbName: z.string(),
  username: z.string(),
  password: z.string(),
  roles: z.array(z.enum(DATABASE_ROLES)),
});

type Config = z.infer<typeof ConfigSchema>;
type AppComponentConfig = z.infer<typeof AppComponentSchema>;
type Allocation = z.infer<typeof AllocationSchema>;
type AtlasCredentials = CloudCredentialMongoDBAtlas;

type ProviderNames = {
  providerName: string;
  backingProviderName?: string;
};

const component = new InfraComponent({
  metadata: {
    stateful: true,
    proxiable: false,
  },
  connectionTypes: {
    mongodb: {
      description: "credentialed MongoDB srv URI scoped to the app's logical database",
      interface: MongoCI,
    },
  } as const,
  connectionInterfaces: [MongoCI],
  configSchema: ConfigSchema,
  appComponentTypes: {
    mongodb: AppComponentSchema,
  },
  outputSchema: z.object({
    projectId: z.string(),
    clusterName: z.string(),
    srvHost: z.string(),
  }),
});

function credentialsFrom(getCredentials: () => unknown): AtlasCredentials {
  const creds = getCredentials() as Partial<AtlasCredentials> | undefined;

  if (
    !creds ||
    typeof creds.MONGODB_ATLAS_PUBLIC_KEY !== "string" ||
    creds.MONGODB_ATLAS_PUBLIC_KEY.length === 0 ||
    typeof creds.MONGODB_ATLAS_PRIVATE_KEY !== "string" ||
    creds.MONGODB_ATLAS_PRIVATE_KEY.length === 0
  ) {
    throw new Error(CREDENTIAL_SHAPE_ERROR);
  }

  return creds as AtlasCredentials;
}

function stableName(
  raw: string,
  fallback: string,
  maxLength = MAX_CLUSTER_NAME_LENGTH,
): string {
  const sanitized = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const baseName = sanitized || fallback;

  if (baseName.length <= maxLength) {
    return baseName;
  }

  const suffix = createHash("sha1")
    .update(baseName)
    .digest("hex")
    .slice(0, NAME_HASH_LENGTH);
  const prefixLength = maxLength - suffix.length - 1;

  return `${baseName.slice(0, prefixLength).replace(/-+$/g, "")}-${suffix}`;
}

function cidrResourceName(cidr: string): string {
  return `ip-${stableName(cidr, DEFAULT_CIDR_NAME)}`;
}

function isSharedTier(instanceSize: string): boolean {
  return SHARED_TIERS.has(instanceSize);
}

function providerNames(
  instanceSize: string,
  cloudBackend: Config["cloudBackend"],
): ProviderNames {
  if (instanceSize === "M0") {
    return { providerName: "TENANT", backingProviderName: cloudBackend };
  }

  if (instanceSize === "FLEX") {
    return { providerName: "FLEX", backingProviderName: cloudBackend };
  }

  return { providerName: cloudBackend };
}

function clusterFingerprint(config: Config): string {
  return JSON.stringify({
    projectMode: config.projectId ? "adopt" : "create",
    projectId: config.projectId ?? null,
    cloudBackend: config.cloudBackend,
    region: config.cluster.region,
  });
}

function assertReplacementFingerprint(
  stored: string | undefined,
  requested: string,
): void {
  if (stored && stored !== requested) {
    throw new Error(REPLACEMENT_FINGERPRINT_ERROR);
  }
}

function generatedPassword(): string {
  return randomBytes(PASSWORD_BYTE_LENGTH).toString("base64url");
}

function stripSrvScheme(value: string): string {
  return value.startsWith(MONGODB_SRV_SCHEME)
    ? value.slice(MONGODB_SRV_SCHEME.length)
    : value;
}

function srvHostFrom(cluster: mongodbatlas.AdvancedCluster): pulumi.Output<string> {
  return cluster.connectionStrings.apply((connectionStrings) =>
    stripSrvScheme(connectionStrings.standardSrv)
  );
}

function autoscalingConfig(
  autoscaling: Config["cluster"]["autoscaling"],
): mongodbatlas.types.input.AdvancedClusterReplicationSpecRegionConfigAutoScaling | undefined {
  if (!autoscaling) {
    return undefined;
  }

  const compute = autoscaling.compute;

  return {
    computeEnabled: compute?.enabled,
    computeMinInstanceSize: compute?.minInstanceSize,
    computeMaxInstanceSize: compute?.maxInstanceSize,
    computeScaleDownEnabled: compute?.minInstanceSize !== undefined
      ? true
      : undefined,
    diskGbEnabled: autoscaling.diskGbEnabled,
  };
}

function autoscalingIgnoreChanges(
  autoscaling: Config["cluster"]["autoscaling"],
): string[] | undefined {
  if (!autoscaling) {
    return undefined;
  }

  const ignoreChanges: string[] = [];

  if (autoscaling.compute?.enabled) {
    ignoreChanges.push(
      "replicationSpecs[0].regionConfigs[0].electableSpecs.instanceSize",
    );
  }

  if (autoscaling.diskGbEnabled) {
    ignoreChanges.push(
      "replicationSpecs[0].regionConfigs[0].electableSpecs.diskSizeGb",
    );
  }

  return ignoreChanges.length > 0 ? ignoreChanges : undefined;
}

component.implement(MONGODB_ATLAS_PROVIDER, {
  stateSchema: z.object({
    projectId: z.string().optional(),
    projectOwned: z.boolean().default(false),
    clusterName: z.string().optional(),
    srvHost: z.string().optional(),
    clusterFingerprint: z.string().optional(),
    allocations: z.record(z.string(), AllocationSchema).default({}),
  }),
  initialState: {
    projectOwned: false,
    allocations: {},
  },

  pulumi: async ({
    $,
    inputs,
    state,
    mongodbatlas: provider,
    getCredentials,
  }) => {
    const config = inputs as Config;
    const creds = credentialsFrom(getCredentials);
    const atlasOpts: pulumi.CustomResourceOptions = provider
      ? { provider }
      : {};
    const requestedFingerprint = clusterFingerprint(config);

    assertReplacementFingerprint(
      state.clusterFingerprint as string | undefined,
      requestedFingerprint,
    );

    const clusterName = stableName(
      $`cluster`,
      DEFAULT_CLUSTER_NAME,
      MAX_CLUSTER_NAME_LENGTH,
    );
    const projectName = stableName(
      $`project`,
      DEFAULT_PROJECT_NAME,
      MAX_CLUSTER_NAME_LENGTH,
    );
    const projectOwned = !config.projectId;
    let projectId: pulumi.Input<string>;

    if (config.projectId) {
      projectId = config.projectId;
    } else {
      if (!creds.MONGODB_ATLAS_ORG_ID) {
        throw new Error(ORG_ID_REQUIRED_ERROR);
      }

      const project = new mongodbatlas.Project(
        $`project`,
        {
          name: projectName,
          orgId: creds.MONGODB_ATLAS_ORG_ID,
        },
        atlasOpts,
      );
      projectId = project.id;
    }

    const names = providerNames(config.cluster.instanceSize, config.cloudBackend);
    const ignoreChanges = autoscalingIgnoreChanges(config.cluster.autoscaling);
    const clusterOpts: pulumi.CustomResourceOptions = ignoreChanges
      ? { ...atlasOpts, ignoreChanges }
      : atlasOpts;
    const sharedTier = isSharedTier(config.cluster.instanceSize);

    const cluster = new mongodbatlas.AdvancedCluster(
      $`cluster`,
      {
        projectId,
        name: clusterName,
        clusterType: config.clusterType,
        mongoDbMajorVersion: config.mongoDbMajorVersion,
        backupEnabled: config.backupEnabled,
        retainBackupsEnabled: config.backupEnabled ? true : undefined,
        pitEnabled: config.pitEnabled,
        terminationProtectionEnabled: config.terminationProtectionEnabled,
        tags: config.labels,
        useEffectiveFields: config.cluster.autoscaling ? true : undefined,
        replicationSpecs: [
          {
            regionConfigs: [
              {
                priority: 7,
                regionName: config.cluster.region,
                providerName: names.providerName,
                backingProviderName: names.backingProviderName,
                electableSpecs: {
                  instanceSize: config.cluster.instanceSize,
                  nodeCount: sharedTier
                    ? undefined
                    : config.cluster.nodeCount,
                  diskSizeGb: config.cluster.diskGb,
                },
                autoScaling: autoscalingConfig(config.cluster.autoscaling),
              },
            ],
          },
        ],
      },
      clusterOpts,
    );

    for (const cidr of config.networkAccess.cidrs) {
      new mongodbatlas.ProjectIpAccessList(
        $`access-${cidrResourceName(cidr)}`,
        {
          projectId,
          cidrBlock: cidr,
        },
        atlasOpts,
      );
    }

    const srvHost = srvHostFrom(cluster);
    const outputs = {
      projectId: pulumi.output(projectId),
      clusterName: pulumi.output(clusterName),
      srvHost,
    };

    state.projectId = outputs.projectId;
    state.projectOwned = projectOwned;
    state.clusterName = clusterName;
    state.srvHost = srvHost;
    state.clusterFingerprint = requestedFingerprint;
    state.allocations = state.allocations ?? {};

    return outputs;
  },

  allocateWithPulumiCtx: async ({
    name,
    deploymentConfig,
    state,
    $,
    mongodbatlas: provider,
  }) => {
    const config = deploymentConfig as AppComponentConfig;
    const roles = config.roles ?? ["readWrite"];

    if (!state.projectId || !state.clusterName || !state.srvHost) {
      throw new Error(CONFIG_SNAPSHOT_MISSING_ERROR);
    }

    const projectId = state.projectId as pulumi.Input<string>;
    const clusterName = state.clusterName as pulumi.Input<string>;

    if (SYSTEM_DATABASES.has(config.dbName)) {
      throw new Error(
        `mongodb: dbName "${config.dbName}" is reserved for MongoDB system namespaces; choose an app-owned database name.`,
      );
    }

    state.allocations = state.allocations ?? {};

    for (const [owner, allocation] of Object.entries(
      state.allocations as Record<string, Allocation>,
    )) {
      if (owner !== name && allocation.dbName === config.dbName) {
        throw new Error(
          `mongodb: dbName "${config.dbName}" is already allocated to app component "${owner}"; each app must use a distinct logical database.`,
        );
      }
    }

    const existing = (state.allocations as Record<string, Allocation>)[name];
    const password = existing?.password ?? generatedPassword();
    const username = stableName(name, DEFAULT_USER_NAME, MAX_USERNAME_LENGTH);
    const atlasOpts: pulumi.CustomResourceOptions = provider
      ? { provider }
      : {};

    new mongodbatlas.DatabaseUser(
      $`user-${username}`,
      {
        projectId,
        username,
        authDatabaseName: AUTH_DATABASE_ADMIN,
        password: pulumi.secret(password),
        roles: roles.map((roleName) => ({
          roleName,
          databaseName: config.dbName,
        })),
        scopes: [
          {
            name: clusterName,
            type: CLUSTER_SCOPE_TYPE,
          },
        ],
      },
      {
        ...atlasOpts,
        additionalSecretOutputs: ["password"],
      },
    );

    (state.allocations as Record<string, Allocation>)[name] = {
      dbName: config.dbName,
      username,
      password,
      roles,
    };
  },

  connect: (({ state, selfComponentName }: any) => [
    connectionHandler({
      interface: MongoCI,
      handler: async (_ctx: any) => {
        const allocations = (state.allocations ?? {}) as Record<string, Allocation>;
        const allocation = allocations[selfComponentName];

        if (!allocation) {
          throw new Error(
            `mongodb: no allocation found for "${selfComponentName}"; allocation must run before connection.`,
          );
        }

        const uri = pulumi.secret(
          pulumi.all([
            allocation.username,
            allocation.password,
            state.srvHost,
            allocation.dbName,
          ]).apply(([user, pass, host, db]) => {
            const enc = (value: string) => encodeURIComponent(value);
            return `${MONGODB_SRV_SCHEME}${enc(user)}:${enc(pass)}@${host}/${enc(db)}?${CONNECTION_QUERY}`;
          }),
        );

        return {
          uri,
          metadata: {
            uri,
            dbName: allocation.dbName,
          },
        };
      },
    }),
  ]),
});

export default component;
