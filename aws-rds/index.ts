import { createHash, randomBytes } from "node:crypto";

import { InfraComponent, connectionHandler } from "@sdlcworks/components";

import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";
import { z } from "zod";

import { MysqlCI, PostgresCI } from "../_internal/interfaces";

const POSTGRES_ENGINE = "postgres";
const MYSQL_ENGINE = "mysql";
const ENGINES = [POSTGRES_ENGINE, MYSQL_ENGINE] as const;
const STORAGE_TYPES = ["gp3", "gp2", "io1", "io2"] as const;
const POSTGRES_PORT = 5432;
const MYSQL_PORT = 3306;
const DEFAULT_POSTGRES_VERSION = "16";
const DEFAULT_MYSQL_VERSION = "8.0";
const DEFAULT_INSTANCE_CLASS = "db.t4g.micro";
const DEFAULT_ALLOCATED_GB = 20;
const DEFAULT_STORAGE_TYPE = "gp3";
const DEFAULT_DATABASE_NAME = "app";
const DEFAULT_MASTER_USERNAME = "sdlc_admin";
const DEFAULT_BACKUP_RETENTION_DAYS = 7;
const DEFAULT_SECRET_RECOVERY_WINDOW_DAYS = 7;
const PERFORMANCE_INSIGHTS_RETENTION_DAYS = [7, 731] as const;
const MAX_BACKUP_RETENTION_DAYS = 35;
const MAX_SECRET_RECOVERY_WINDOW_DAYS = 30;
const MIN_SUBNET_COUNT = 2;
const OPEN_CIDRS = new Set(["0.0.0.0/0", "::/0"]);
const PASSWORD_BYTE_LENGTH = 24;
const IDENTIFIER_MAX_LENGTH = 63;
const RESOURCE_NAME_MAX_LENGTH = 255;
const IDENTIFIER_HASH_LENGTH = 8;
const IDENTIFIER_FALLBACK = "db";
const FINAL_SNAPSHOT_SUFFIX = "final";
const REPLICA_IDENTIFIER_INFIX = "ro";
const PARAMETER_APPLY_METHOD_PENDING_REBOOT = "pending-reboot";
const TCP_PROTOCOL = "tcp";
const DATABASE_APP_COMPONENT_TYPE = "database";
const POSTGRES_URI_SCHEME = "postgresql";
const MYSQL_URI_SCHEME = "mysql";
const POSTGRES_TLS_QUERY = "sslmode=require";
const MYSQL_TLS_QUERY = "ssl-mode=REQUIRED";
const MANAGED_DESCRIPTION = "Managed by sdlc.works aws-rds component";
const SUBNET_COUNT_ERROR =
  "aws-rds: subnetIds must name at least two subnets so the DB subnet group spans two availability zones.";
const INSTANCES_REQUIRED_ERROR =
  "aws-rds: instances must declare at least one database instance.";
const ACCESS_REQUIRED_ERROR =
  "aws-rds: access must declare at least one CIDR or security group; a database no source may reach serves nothing.";
const ENGINE_FINGERPRINT_ERROR_PREFIX = "aws-rds: engine change refused";
const ENGINE_FINGERPRINT_ERROR_MESSAGE =
  "Changing the engine field would replace the database and risk total data loss. Declare a new instance key and migrate data explicitly.";
const CONFIG_SNAPSHOT_MISSING_ERROR =
  "aws-rds: instance snapshot missing from state; pulumi() must run before allocateWithPulumiCtx.";

const StorageSchema = z.object({
  allocatedGb: z.number().int().min(DEFAULT_ALLOCATED_GB).default(DEFAULT_ALLOCATED_GB),
  maxAllocatedGb: z.number().int().positive().optional(),
  type: z.enum(STORAGE_TYPES).default(DEFAULT_STORAGE_TYPE),
  iops: z.number().int().positive().optional(),
}).strict();

const BackupSchema = z.object({
  retentionDays: z
    .number()
    .int()
    .min(0)
    .max(MAX_BACKUP_RETENTION_DAYS)
    .default(DEFAULT_BACKUP_RETENTION_DAYS),
  window: z.string().min(1).optional(),
  copyTagsToSnapshot: z.boolean().default(true),
}).strict();

const PerformanceInsightsSchema = z.object({
  enabled: z.boolean().default(false),
  retentionDays: z
    .union([
      z.literal(PERFORMANCE_INSIGHTS_RETENTION_DAYS[0]),
      z.literal(PERFORMANCE_INSIGHTS_RETENTION_DAYS[1]),
    ])
    .optional(),
}).strict();

const ReadReplicaSchema = z.object({
  instanceClass: z.string().min(1).optional(),
  publiclyAccessible: z.boolean().optional(),
}).strict();

const SecretSchema = z.object({
  enabled: z.boolean().default(true),
  recoveryWindowDays: z
    .number()
    .int()
    .min(0)
    .max(MAX_SECRET_RECOVERY_WINDOW_DAYS)
    .refine((days) => days === 0 || days >= 7, {
      message: "aws-rds: secret.recoveryWindowDays must be 0 (delete immediately) or between 7 and 30",
    })
    .default(DEFAULT_SECRET_RECOVERY_WINDOW_DAYS),
}).strict();

const InstanceSchema = z.object({
  engine: z.enum(ENGINES).default(POSTGRES_ENGINE),
  engineVersion: z.string().min(1).optional(),
  instanceClass: z.string().min(1).default(DEFAULT_INSTANCE_CLASS),
  storage: StorageSchema.default({
    allocatedGb: DEFAULT_ALLOCATED_GB,
    type: DEFAULT_STORAGE_TYPE,
  }),
  multiAz: z.boolean().default(false),
  publiclyAccessible: z.boolean().default(false),
  databaseName: z.string().min(1).default(DEFAULT_DATABASE_NAME),
  masterUsername: z.string().min(1).default(DEFAULT_MASTER_USERNAME),
  backup: BackupSchema.default({
    retentionDays: DEFAULT_BACKUP_RETENTION_DAYS,
    copyTagsToSnapshot: true,
  }),
  maintenanceWindow: z.string().min(1).optional(),
  autoMinorVersionUpgrade: z.boolean().default(true),
  allowMajorVersionUpgrade: z.boolean().default(false),
  applyImmediately: z.boolean().default(false),
  deletionProtection: z.boolean().default(true),
  finalSnapshot: z.boolean().default(true),
  kmsKeyArn: z.string().min(1).optional(),
  performanceInsights: PerformanceInsightsSchema.default({ enabled: false }),
  iamAuthentication: z.boolean().default(false),
  logExports: z.array(z.string().min(1)).default([]),
  parameters: z.record(z.string(), z.string()).default({}),
  readReplicas: z.record(z.string(), ReadReplicaSchema).default({}),
  secret: SecretSchema.default({
    enabled: true,
    recoveryWindowDays: DEFAULT_SECRET_RECOVERY_WINDOW_DAYS,
  }),
}).strict();

const AccessSchema = z.object({
  cidrs: z.array(z.string().min(1)).default([]),
  securityGroupIds: z.array(z.string().min(1)).default([]),
}).strict();

export const ConfigSchema = z.object({
  vpcId: z.string().min(1),
  subnetIds: z.array(z.string().min(1)).min(MIN_SUBNET_COUNT, SUBNET_COUNT_ERROR),
  access: AccessSchema,
  labels: z.record(z.string(), z.string()).default({}),
  instances: z.record(z.string(), InstanceSchema).refine(
    (instances) => Object.keys(instances).length > 0,
    INSTANCES_REQUIRED_ERROR,
  ),
}).strict().superRefine((value, ctx) => {
  if (
    value.access.cidrs.length === 0 &&
    value.access.securityGroupIds.length === 0
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["access"],
      message: ACCESS_REQUIRED_ERROR,
    });
  }

  const instances = Object.entries(value.instances);
  const everyInstanceIsPublic = instances.every(
    ([, instance]) => instance.publiclyAccessible,
  );

  for (const cidr of value.access.cidrs) {
    if (OPEN_CIDRS.has(cidr) && !everyInstanceIsPublic) {
      ctx.addIssue({
        code: "custom",
        path: ["access", "cidrs"],
        message:
          `aws-rds: access.cidrs entry "${cidr}" admits every source on the internet; it is refused unless every declared instance sets publiclyAccessible true.`,
      });
    }
  }

  for (const [instanceKey, instance] of instances) {
    const { allocatedGb, maxAllocatedGb } = instance.storage;
    if (maxAllocatedGb !== undefined && maxAllocatedGb <= allocatedGb) {
      ctx.addIssue({
        code: "custom",
        path: ["instances", instanceKey, "storage", "maxAllocatedGb"],
        message:
          `aws-rds: instance "${instanceKey}" storage.maxAllocatedGb must exceed storage.allocatedGb for storage autoscaling to have room to grow.`,
      });
    }
  }
});

const AppComponentSchema = z.object({
  instance: z.string().min(1),
}).strict();

const AllocationSchema = z.object({
  instanceKey: z.string(),
});

const InstanceStateSchema = z.object({
  identifier: z.string(),
  host: z.string(),
  port: z.number(),
  engine: z.enum(ENGINES),
  databaseName: z.string(),
  masterUsername: z.string(),
  password: z.string(),
  secretArn: z.string().optional(),
  replicaEndpoints: z.record(z.string(), z.string()).default({}),
});

const InstanceOutputSchema = z.object({
  endpoint: z.string(),
  port: z.number(),
  engine: z.string(),
  secretArn: z.string().optional(),
  replicaEndpoints: z.record(z.string(), z.string()),
});

export type Engine = (typeof ENGINES)[number];
type Config = z.infer<typeof ConfigSchema>;
type InstanceConfig = z.infer<typeof InstanceSchema>;
type AccessConfig = z.infer<typeof AccessSchema>;
type AppComponentConfig = z.infer<typeof AppComponentSchema>;
type Allocation = z.infer<typeof AllocationSchema>;
type InstanceState = z.infer<typeof InstanceStateSchema>;

type UriParts = {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
};

type InstanceOutput = {
  endpoint: pulumi.Output<string>;
  port: number;
  engine: Engine;
  secretArn: pulumi.Output<string | undefined>;
  replicaEndpoints: pulumi.Output<Record<string, string>>;
};

const component = new InfraComponent({
  metadata: {
    stateful: true,
    proxiable: false,
  },
  connectionTypes: {
    [POSTGRES_ENGINE]: {
      description: "credentialed Postgres URI for the app's allocated RDS instance",
      interface: PostgresCI,
    },
    [MYSQL_ENGINE]: {
      description: "credentialed MySQL URI for the app's allocated RDS instance",
      interface: MysqlCI,
    },
  } as const,
  connectionInterfaces: [PostgresCI, MysqlCI],
  configSchema: ConfigSchema,
  appComponentTypes: {
    [DATABASE_APP_COMPONENT_TYPE]: AppComponentSchema,
  },
  outputSchema: z.object({
    instances: z.record(z.string(), InstanceOutputSchema),
    securityGroupId: z.string(),
  }),
});

export function rdsIdentifier(
  raw: string,
  maxLength = IDENTIFIER_MAX_LENGTH,
): string {
  const sanitized = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  if (sanitized.length === 0) {
    return IDENTIFIER_FALLBACK;
  }

  const prefixed = /^[a-z]/.test(sanitized)
    ? sanitized
    : `${IDENTIFIER_FALLBACK}-${sanitized}`;

  if (prefixed.length <= maxLength) {
    return prefixed;
  }

  const suffix = createHash("sha1")
    .update(prefixed)
    .digest("hex")
    .slice(0, IDENTIFIER_HASH_LENGTH);

  return `${prefixed.slice(0, maxLength - suffix.length - 1).replace(/-+$/g, "")}-${suffix}`;
}

export function enginePort(engine: Engine): number {
  return engine === POSTGRES_ENGINE ? POSTGRES_PORT : MYSQL_PORT;
}

export function engineVersionFor(engine: Engine, engineVersion?: string): string {
  if (engineVersion !== undefined) {
    return engineVersion;
  }

  return engine === POSTGRES_ENGINE
    ? DEFAULT_POSTGRES_VERSION
    : DEFAULT_MYSQL_VERSION;
}

export function parameterGroupFamily(
  engine: Engine,
  engineVersion: string,
): string {
  const segments = engineVersion.split(".");

  if (engine === POSTGRES_ENGINE) {
    return `${POSTGRES_ENGINE}${segments[0]}`;
  }

  if (segments.length < 2) {
    throw new Error(
      `aws-rds: mysql engineVersion "${engineVersion}" must name a major and a minor version (for example "8.0") because a MySQL parameter group family is major.minor.`,
    );
  }

  return `${MYSQL_ENGINE}${segments[0]}.${segments[1]}`;
}

export function sqlUri(engine: Engine, parts: UriParts): string {
  const authority =
    `${encodeURIComponent(parts.user)}:${encodeURIComponent(parts.password)}@${parts.host}:${parts.port}`;
  const path = encodeURIComponent(parts.database);

  return engine === POSTGRES_ENGINE
    ? `${POSTGRES_URI_SCHEME}://${authority}/${path}?${POSTGRES_TLS_QUERY}`
    : `${MYSQL_URI_SCHEME}://${authority}/${path}?${MYSQL_TLS_QUERY}`;
}

export function firstReplicaKey(
  replicaEndpoints: Record<string, unknown>,
): string | undefined {
  return Object.keys(replicaEndpoints).sort()[0];
}

export function engineFingerprint(instance: InstanceConfig): string {
  return JSON.stringify({ engine: instance.engine });
}

export function assertEngineFingerprint(
  instanceKey: string,
  stored: string | undefined,
  requested: string,
): string {
  if (stored && stored !== requested) {
    throw new Error(
      `${ENGINE_FINGERPRINT_ERROR_PREFIX} for instance "${instanceKey}". ${ENGINE_FINGERPRINT_ERROR_MESSAGE}`,
    );
  }

  return requested;
}

export function ingressRules(
  ports: number[],
  access: AccessConfig,
): aws.types.input.ec2.SecurityGroupIngress[] {
  const ipv4Cidrs = access.cidrs.filter((cidr) => !cidr.includes(":"));
  const ipv6Cidrs = access.cidrs.filter((cidr) => cidr.includes(":"));

  return ports.flatMap((port) => {
    const rules: aws.types.input.ec2.SecurityGroupIngress[] = [];

    if (ipv4Cidrs.length > 0) {
      rules.push({
        protocol: TCP_PROTOCOL,
        fromPort: port,
        toPort: port,
        cidrBlocks: ipv4Cidrs,
      });
    }

    if (ipv6Cidrs.length > 0) {
      rules.push({
        protocol: TCP_PROTOCOL,
        fromPort: port,
        toPort: port,
        ipv6CidrBlocks: ipv6Cidrs,
      });
    }

    if (access.securityGroupIds.length > 0) {
      rules.push({
        protocol: TCP_PROTOCOL,
        fromPort: port,
        toPort: port,
        securityGroups: access.securityGroupIds,
      });
    }

    return rules;
  });
}

export function declaredEnginePorts(
  instances: Record<string, InstanceConfig>,
): number[] {
  const ports = new Set(
    Object.values(instances).map((instance) => enginePort(instance.engine)),
  );

  return Array.from(ports).sort((left, right) => left - right);
}

function generatedPassword(): string {
  return randomBytes(PASSWORD_BYTE_LENGTH).toString("base64url");
}

function connectionUri(
  engine: Engine,
  host: pulumi.Input<string>,
  instanceState: InstanceState,
): pulumi.Output<string> {
  return pulumi.secret(
    pulumi
      .all([
        host,
        instanceState.port,
        instanceState.databaseName,
        instanceState.masterUsername,
        instanceState.password,
      ])
      .apply(([resolvedHost, port, database, user, password]) =>
        sqlUri(engine, {
          host: resolvedHost as string,
          port: port as number,
          database: database as string,
          user: user as string,
          password: password as string,
        })
      ),
  );
}

function sqlConnection(
  state: any,
  selfComponentName: string,
  engine: Engine,
) {
  const allocations = (state.allocations ?? {}) as Record<string, Allocation>;
  const allocation = allocations[selfComponentName];

  if (!allocation) {
    throw new Error(
      `aws-rds: no allocation found for "${selfComponentName}"; allocation must run before connection.`,
    );
  }

  const instances = (state.instances ?? {}) as Record<string, InstanceState>;
  const instanceState = instances[allocation.instanceKey];

  if (!instanceState) {
    throw new Error(CONFIG_SNAPSHOT_MISSING_ERROR);
  }

  if (instanceState.engine !== engine) {
    throw new Error(
      `aws-rds: app component "${selfComponentName}" is allocated to instance "${allocation.instanceKey}" running engine "${instanceState.engine}" and cannot serve a "${engine}" connection.`,
    );
  }

  const uri = connectionUri(engine, instanceState.host, instanceState);
  const replicaEndpoints = instanceState.replicaEndpoints ?? {};
  const replicaKey = firstReplicaKey(replicaEndpoints);

  return {
    uri,
    metadata: {
      uri,
      ...(replicaKey === undefined
        ? {}
        : {
          readUri: connectionUri(
            engine,
            replicaEndpoints[replicaKey],
            instanceState,
          ),
        }),
      host: instanceState.host,
      port: instanceState.port,
      database: instanceState.databaseName,
      user: instanceState.masterUsername,
      password: pulumi.secret(instanceState.password),
      ...(instanceState.secretArn === undefined
        ? {}
        : { secretArn: instanceState.secretArn }),
    },
  };
}

component.implement("aws", {
  stateSchema: z.object({
    securityGroupId: z.string().optional(),
    engineFingerprints: z.record(z.string(), z.string()).default({}),
    instances: z.record(z.string(), InstanceStateSchema).default({}),
    allocations: z.record(z.string(), AllocationSchema).default({}),
  }),
  initialState: {
    engineFingerprints: {},
    instances: {},
    allocations: {},
  },

  pulumi: async ({ $, inputs, state, aws: provider }) => {
    const config = inputs as Config;
    const awsOpts: pulumi.CustomResourceOptions = provider ? { provider } : {};
    const engineFingerprints = (state.engineFingerprints ?? {}) as Record<string, string>;
    const storedInstances = (state.instances ?? {}) as Record<string, InstanceState>;

    const subnetGroup = new aws.rds.SubnetGroup(
      $`subnets`,
      {
        name: rdsIdentifier($`subnets`, RESOURCE_NAME_MAX_LENGTH),
        description: MANAGED_DESCRIPTION,
        subnetIds: config.subnetIds,
        tags: {
          ...config.labels,
          Name: $`subnets`,
        },
      },
      awsOpts,
    );

    const securityGroup = new aws.ec2.SecurityGroup(
      $`sg`,
      {
        name: $`sg`,
        description: MANAGED_DESCRIPTION,
        vpcId: config.vpcId,
        ingress: ingressRules(declaredEnginePorts(config.instances), config.access),
        egress: [],
        revokeRulesOnDelete: true,
        tags: {
          ...config.labels,
          Name: $`sg`,
        },
      },
      awsOpts,
    );

    const instanceStates: Record<string, unknown> = {};
    const instanceOutputs: Record<string, InstanceOutput> = {};

    for (const [instanceKey, instance] of Object.entries(config.instances)) {
      engineFingerprints[instanceKey] = assertEngineFingerprint(
        instanceKey,
        engineFingerprints[instanceKey],
        engineFingerprint(instance),
      );

      const engineVersion = engineVersionFor(instance.engine, instance.engineVersion);
      const identifier = rdsIdentifier($`db-${instanceKey}`);
      const password = storedInstances[instanceKey]?.password ?? generatedPassword();
      const port = enginePort(instance.engine);

      const parameterGroup = Object.keys(instance.parameters).length > 0
        ? new aws.rds.ParameterGroup(
          $`params-${instanceKey}`,
          {
            name: rdsIdentifier(
              $`params-${instanceKey}-${parameterGroupFamily(instance.engine, engineVersion)}`,
              RESOURCE_NAME_MAX_LENGTH,
            ),
            description: MANAGED_DESCRIPTION,
            family: parameterGroupFamily(instance.engine, engineVersion),
            parameters: Object.entries(instance.parameters).map(([name, value]) => ({
              name,
              value,
              applyMethod: PARAMETER_APPLY_METHOD_PENDING_REBOOT,
            })),
            tags: {
              ...config.labels,
              Name: $`params-${instanceKey}`,
            },
          },
          awsOpts,
        )
        : undefined;

      const database = new aws.rds.Instance(
        $`db-${instanceKey}`,
        {
          identifier,
          engine: instance.engine,
          engineVersion,
          instanceClass: instance.instanceClass,
          allocatedStorage: instance.storage.allocatedGb,
          maxAllocatedStorage: instance.storage.maxAllocatedGb,
          storageType: instance.storage.type,
          iops: instance.storage.iops,
          storageEncrypted: true,
          kmsKeyId: instance.kmsKeyArn,
          dbName: instance.databaseName,
          username: instance.masterUsername,
          password: pulumi.secret(password),
          port,
          dbSubnetGroupName: subnetGroup.name,
          vpcSecurityGroupIds: [securityGroup.id],
          parameterGroupName: parameterGroup?.name,
          multiAz: instance.multiAz,
          publiclyAccessible: instance.publiclyAccessible,
          backupRetentionPeriod: instance.backup.retentionDays,
          backupWindow: instance.backup.window,
          copyTagsToSnapshot: instance.backup.copyTagsToSnapshot,
          maintenanceWindow: instance.maintenanceWindow,
          autoMinorVersionUpgrade: instance.autoMinorVersionUpgrade,
          allowMajorVersionUpgrade: instance.allowMajorVersionUpgrade,
          applyImmediately: instance.applyImmediately,
          deletionProtection: instance.deletionProtection,
          skipFinalSnapshot: !instance.finalSnapshot,
          finalSnapshotIdentifier: instance.finalSnapshot
            ? `${identifier}-${FINAL_SNAPSHOT_SUFFIX}`
            : undefined,
          performanceInsightsEnabled: instance.performanceInsights.enabled,
          performanceInsightsRetentionPeriod: instance.performanceInsights.retentionDays,
          iamDatabaseAuthenticationEnabled: instance.iamAuthentication,
          enabledCloudwatchLogsExports: instance.logExports.length > 0
            ? instance.logExports
            : undefined,
          tags: {
            ...config.labels,
            Name: identifier,
          },
        },
        {
          ...awsOpts,
          additionalSecretOutputs: ["password"],
          ignoreChanges: instance.storage.maxAllocatedGb !== undefined ? ["allocatedStorage"] : [],
        },
      );

      const replicaEndpoints: Record<string, pulumi.Output<string>> = {};

      for (const [replicaKey, replica] of Object.entries(instance.readReplicas)) {
        const replicaInstance = new aws.rds.Instance(
          $`db-${instanceKey}-replica-${replicaKey}`,
          {
            identifier: rdsIdentifier(
              `${identifier}-${REPLICA_IDENTIFIER_INFIX}-${replicaKey}`,
            ),
            replicateSourceDb: database.identifier,
            instanceClass: replica.instanceClass ?? instance.instanceClass,
            publiclyAccessible: replica.publiclyAccessible ?? instance.publiclyAccessible,
            vpcSecurityGroupIds: [securityGroup.id],
            storageEncrypted: true,
            kmsKeyId: instance.kmsKeyArn,
            autoMinorVersionUpgrade: instance.autoMinorVersionUpgrade,
            applyImmediately: instance.applyImmediately,
            deletionProtection: instance.deletionProtection,
            skipFinalSnapshot: true,
            tags: {
              ...config.labels,
              Name: rdsIdentifier(
                `${identifier}-${REPLICA_IDENTIFIER_INFIX}-${replicaKey}`,
              ),
            },
          },
          awsOpts,
        );

        replicaEndpoints[replicaKey] = replicaInstance.address;
      }

      let secretArn: pulumi.Output<string> | undefined;

      if (instance.secret.enabled) {
        const secret = new aws.secretsmanager.Secret(
          $`secret-${instanceKey}`,
          {
            description: MANAGED_DESCRIPTION,
            recoveryWindowInDays: instance.secret.recoveryWindowDays,
            kmsKeyId: instance.kmsKeyArn,
            tags: {
              ...config.labels,
              Name: $`secret-${instanceKey}`,
            },
          },
          awsOpts,
        );

        new aws.secretsmanager.SecretVersion(
          $`secret-version-${instanceKey}`,
          {
            secretId: secret.arn,
            secretString: pulumi.secret(
              pulumi.all([database.address, database.port]).apply(([host, hostPort]) =>
                JSON.stringify({
                  engine: instance.engine,
                  host,
                  port: hostPort,
                  dbname: instance.databaseName,
                  username: instance.masterUsername,
                  password,
                  uri: sqlUri(instance.engine, {
                    host: host as string,
                    port: hostPort as number,
                    database: instance.databaseName,
                    user: instance.masterUsername,
                    password,
                  }),
                })
              ),
            ),
          },
          awsOpts,
        );

        secretArn = secret.arn;
      }

      instanceStates[instanceKey] = {
        identifier,
        host: database.address,
        port,
        engine: instance.engine,
        databaseName: instance.databaseName,
        masterUsername: instance.masterUsername,
        password,
        secretArn,
        replicaEndpoints,
      };

      instanceOutputs[instanceKey] = {
        endpoint: database.address,
        port,
        engine: instance.engine,
        secretArn: pulumi.output(secretArn),
        replicaEndpoints: pulumi.output(replicaEndpoints),
      };
    }

    (state as any).instances = instanceStates;
    state.engineFingerprints = engineFingerprints;
    state.securityGroupId = securityGroup.id;

    return {
      instances: pulumi.output(instanceOutputs),
      securityGroupId: securityGroup.id,
    };
  },

  allocateWithPulumiCtx: async ({ name, deploymentConfig, state }: any) => {
    const config = deploymentConfig as AppComponentConfig;
    const instances = (state.instances ?? {}) as Record<string, InstanceState>;

    if (!state.instances) {
      throw new Error(CONFIG_SNAPSHOT_MISSING_ERROR);
    }

    if (!(config.instance in instances)) {
      throw new Error(
        `aws-rds: app component "${name}" requested unknown instance "${config.instance}"; declared instances are ${Object.keys(instances).sort().map((key) => `"${key}"`).join(", ")}.`,
      );
    }

    const allocations = (state.allocations ?? {}) as Record<string, Allocation>;
    allocations[name] = { instanceKey: config.instance };
    state.allocations = allocations;
  },

  connect: (({ state, selfComponentName }: any) => [
    connectionHandler({
      interface: PostgresCI,
      handler: async (_ctx: any) =>
        sqlConnection(state, selfComponentName, POSTGRES_ENGINE),
    }),
    connectionHandler({
      interface: MysqlCI,
      handler: async (_ctx: any) =>
        sqlConnection(state, selfComponentName, MYSQL_ENGINE),
    }),
  ]),
});

export default component;
