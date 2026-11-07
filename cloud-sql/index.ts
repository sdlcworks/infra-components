import { randomBytes } from "node:crypto";
import { z } from "zod";

import {
  InfraComponent,
  connectionHandler,
} from "@sdlcworks/components";

import * as gcp from "@pulumi/gcp";
import * as pulumi from "@pulumi/pulumi";

import { MysqlCI, PostgresCI } from "../_internal/interfaces";

const SOCKET_ROOT = "/cloudsql";
const OPEN_INTERNET = new Set(["0.0.0.0/0", "::/0"]);
const SERVICE_NETWORKING = "servicenetworking.googleapis.com";

export type Engine = "postgres" | "mysql";

const NetworkSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("connector") }).strict(),
  z
    .object({
      mode: z.literal("private"),
      network: z.string().min(1),
      allocatedIpRange: z.string().optional(),
      createPeering: z.boolean().default(true),
      peeringPrefixLength: z.number().int().min(8).max(29).default(16),
    })
    .strict(),
  z
    .object({
      mode: z.literal("authorized-networks"),
      cidrs: z
        .array(z.object({ name: z.string().min(1), cidr: z.string().min(1) }).strict())
        .min(1),
    })
    .strict(),
]);

const ReplicaSchema = z
  .object({
    tier: z.string().optional(),
    region: z.string().optional(),
    highAvailability: z.boolean().default(false),
  })
  .strict();

export const InstanceSchema = z
  .object({
    version: z.string().regex(/^(POSTGRES|MYSQL)_/).default("POSTGRES_16"),
    name: z.string().regex(/^[a-z][a-z0-9-]{0,79}$/).optional(),
    edition: z.enum(["ENTERPRISE", "ENTERPRISE_PLUS"]).default("ENTERPRISE"),
    tier: z.string().default("db-custom-1-3840"),
    storage: z
      .object({
        sizeGb: z.number().int().min(10).default(10),
        type: z.enum(["PD_SSD", "PD_HDD"]).default("PD_SSD"),
        autoResize: z.boolean().default(true),
        autoResizeLimitGb: z.number().int().min(0).default(0),
      })
      .strict()
      .prefault({}),
    highAvailability: z.boolean().default(false),
    network: NetworkSchema.prefault({ mode: "connector" }),
    sslMode: z
      .enum(["ENCRYPTED_ONLY", "TRUSTED_CLIENT_CERTIFICATE_REQUIRED"])
      .default("ENCRYPTED_ONLY"),
    backups: z
      .object({
        enabled: z.boolean().default(true),
        pointInTimeRecovery: z.boolean().default(true),
        retainedBackups: z.number().int().min(1).max(365).default(7),
        transactionLogRetentionDays: z.number().int().min(1).max(35).default(7),
        startTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
      })
      .strict()
      .prefault({}),
    maintenanceWindow: z
      .object({
        day: z.number().int().min(1).max(7),
        hour: z.number().int().min(0).max(23),
        updateTrack: z.enum(["canary", "stable", "week5"]).optional(),
      })
      .strict()
      .optional(),
    queryInsights: z.boolean().default(true),
    flags: z.record(z.string(), z.string()).default({}),
    deletionProtection: z.boolean().default(true),
    encryptionKeyName: z.string().optional(),
    labels: z.record(z.string(), z.string()).default({}),
    readReplicas: z.record(z.string(), ReplicaSchema).default({}),
  })
  .strict()
  .superRefine((spec, ctx) => {
    if (spec.network.mode === "authorized-networks") {
      for (const entry of spec.network.cidrs) {
        if (OPEN_INTERNET.has(entry.cidr.trim())) {
          ctx.addIssue({
            code: "custom",
            path: ["network", "cidrs"],
            message: `cloud-sql: authorized network "${entry.name}" opens the database to the whole internet; use network mode "connector" for clients without fixed addresses`,
          });
        }
      }
    }
    if (spec.edition === "ENTERPRISE_PLUS" && !spec.tier.startsWith("db-perf-optimized-")) {
      ctx.addIssue({
        code: "custom",
        path: ["tier"],
        message: `cloud-sql: edition ENTERPRISE_PLUS accepts only db-perf-optimized-* tiers, got "${spec.tier}"`,
      });
    }
    if (spec.backups.pointInTimeRecovery && !spec.backups.enabled) {
      ctx.addIssue({
        code: "custom",
        path: ["backups", "pointInTimeRecovery"],
        message: "cloud-sql: point-in-time recovery requires backups to be enabled",
      });
    }
  });

export type InstanceSpec = z.infer<typeof InstanceSchema>;

export const ConfigSchema = z.object({
  provider: z.literal("gcloud").optional(),
  region: z.string().default("us-central1"),
  labels: z.record(z.string(), z.string()).default({}),
  instances: z.record(z.string(), InstanceSchema).default({}),
});

const DatabaseAllocationSchema = z
  .object({
    instance: z.string().min(1),
    dbName: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,62}$/).optional(),
    dbUser: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,31}$/).optional(),
  })
  .strict();

const EndpointStateSchema = z.object({
  instanceName: z.string(),
  connectionName: z.string(),
  publicIp: z.string().optional(),
  privateIp: z.string().optional(),
});

const SqlInstanceStateSchema = EndpointStateSchema.extend({
  engine: z.enum(["postgres", "mysql"]),
  networkMode: z.enum(["connector", "private", "authorized-networks"]),
  replicas: z.record(z.string(), EndpointStateSchema).default({}),
});

const AllocationSchema = z.object({
  instanceKey: z.string(),
  dbName: z.string(),
  dbUser: z.string(),
  password: z.string(),
});

export type SqlInstanceState = z.infer<typeof SqlInstanceStateSchema>;
export type AllocationState = z.infer<typeof AllocationSchema>;

export function engineOf(version: string): Engine {
  return version.startsWith("MYSQL_") ? "mysql" : "postgres";
}

export function defaultPort(engine: Engine): number {
  return engine === "mysql" ? 3306 : 5432;
}

export function identifierFor(componentName: string): string {
  const cleaned = componentName.toLowerCase().replace(/[^a-z0-9_]/g, "_").replace(/^[^a-z_]+/, "");
  return (cleaned || "app").slice(0, 31);
}

export function generatePassword(): string {
  return randomBytes(24).toString("base64url");
}

export function refuseEngineChange(key: string, recorded: Engine | undefined, declared: Engine): void {
  if (recorded !== undefined && recorded !== declared) {
    throw new Error(
      `cloud-sql: instance "${key}" was created as ${recorded} and is now declared as ${declared}; changing engine would replace the database`,
    );
  }
}

export function ipConfiguration(spec: InstanceSpec, peeringRange?: pulumi.Input<string>) {
  const network = spec.network;
  if (network.mode === "private") {
    return {
      ipv4Enabled: false,
      privateNetwork: network.network,
      allocatedIpRange: network.allocatedIpRange ?? peeringRange,
      sslMode: spec.sslMode,
    };
  }
  if (network.mode === "authorized-networks") {
    return {
      ipv4Enabled: true,
      authorizedNetworks: network.cidrs.map(({ name, cidr }) => ({ name, value: cidr })),
      sslMode: spec.sslMode,
    };
  }
  return { ipv4Enabled: true, authorizedNetworks: [], sslMode: spec.sslMode };
}

export function instanceSettings(
  spec: InstanceSpec,
  labels: Record<string, string>,
  overrides: { tier?: string; highAvailability?: boolean; replica?: boolean },
  peeringRange?: pulumi.Input<string>,
) {
  const engine = engineOf(spec.version);
  const highAvailability = overrides.highAvailability ?? spec.highAvailability;
  return {
    edition: spec.edition,
    tier: overrides.tier ?? spec.tier,
    availabilityType: highAvailability ? "REGIONAL" : "ZONAL",
    diskSize: spec.storage.sizeGb,
    diskType: spec.storage.type,
    diskAutoresize: spec.storage.autoResize,
    diskAutoresizeLimit: spec.storage.autoResizeLimitGb,
    connectorEnforcement:
      spec.network.mode === "connector" && Object.keys(spec.readReplicas).length === 0 ? "REQUIRED" : "NOT_REQUIRED",
    ipConfiguration: ipConfiguration(spec, peeringRange),
    backupConfiguration: overrides.replica
      ? { enabled: false }
      : {
          enabled: spec.backups.enabled,
          pointInTimeRecoveryEnabled: engine === "postgres" ? spec.backups.pointInTimeRecovery : undefined,
          binaryLogEnabled: engine === "mysql" ? spec.backups.pointInTimeRecovery : undefined,
          startTime: spec.backups.startTime,
          transactionLogRetentionDays: spec.backups.transactionLogRetentionDays,
          backupRetentionSettings: { retainedBackups: spec.backups.retainedBackups, retentionUnit: "COUNT" },
        },
    maintenanceWindow: spec.maintenanceWindow,
    insightsConfig: { queryInsightsEnabled: spec.queryInsights },
    databaseFlags: Object.entries(spec.flags).map(([name, value]) => ({ name, value })),
    deletionProtectionEnabled: spec.deletionProtection,
    userLabels: { ...labels, ...spec.labels },
  };
}

function hostFor(endpoint: { publicIp?: string; privateIp?: string }, mode: SqlInstanceState["networkMode"]): string {
  return (mode === "private" ? endpoint.privateIp : endpoint.publicIp) ?? "";
}

export function connectionUri(
  engine: Engine,
  mode: SqlInstanceState["networkMode"],
  endpoint: { connectionName: string; publicIp?: string; privateIp?: string },
  allocation: { dbName: string; dbUser: string; password: string },
): string {
  const credentials = `${encodeURIComponent(allocation.dbUser)}:${encodeURIComponent(allocation.password)}`;
  const database = encodeURIComponent(allocation.dbName);
  const scheme = engine === "mysql" ? "mysql" : "postgresql";
  if (mode === "connector") {
    const socket = `${SOCKET_ROOT}/${endpoint.connectionName}`;
    return engine === "mysql"
      ? `${scheme}://${credentials}@localhost/${database}?socket=${socket}`
      : `${scheme}://${credentials}@localhost/${database}?host=${socket}`;
  }
  const tls = engine === "mysql" ? "ssl-mode=REQUIRED" : "sslmode=require";
  return `${scheme}://${credentials}@${hostFor(endpoint, mode)}:${defaultPort(engine)}/${database}?${tls}`;
}

export function connectionResult(instance: SqlInstanceState, allocation: AllocationState) {
  const uri = connectionUri(instance.engine, instance.networkMode, instance, allocation);
  const firstReplica = Object.keys(instance.replicas).sort()[0];
  const readUri =
    firstReplica === undefined
      ? undefined
      : connectionUri(instance.engine, instance.networkMode, instance.replicas[firstReplica], allocation);
  return {
    uri,
    readUri,
    host: instance.networkMode === "connector" ? "localhost" : hostFor(instance, instance.networkMode),
    port: defaultPort(instance.engine),
    database: allocation.dbName,
    user: allocation.dbUser,
    password: allocation.password,
    socketPath: instance.networkMode === "connector" ? `${SOCKET_ROOT}/${instance.connectionName}` : undefined,
    instanceConnectionName: instance.connectionName,
  };
}

function resolved<T>(value: T): pulumi.Output<pulumi.Unwrap<T>> {
  return pulumi.output(value) as pulumi.Output<pulumi.Unwrap<T>>;
}

const component = new InfraComponent({
  metadata: {
    stateful: true,
    proxiable: false,
  },
  connectionTypes: {
    postgres: {
      description: "Postgres connection to a logical database in a Cloud SQL instance",
      interface: PostgresCI,
    },
    mysql: {
      description: "MySQL connection to a logical database in a Cloud SQL instance",
      interface: MysqlCI,
    },
  } as const,
  connectionInterfaces: [PostgresCI, MysqlCI],
  configSchema: ConfigSchema,
  appComponentTypes: {
    postgres: DatabaseAllocationSchema,
    mysql: DatabaseAllocationSchema,
  },
  outputSchema: z.object({
    connectionNames: z.record(z.string(), z.string()),
  }),
});

component.implement("gcloud", {
  stateSchema: z.object({
    sqlInstances: z.record(z.string(), SqlInstanceStateSchema).default({}),
    allocations: z.record(z.string(), AllocationSchema).default({}),
  }),
  initialState: { sqlInstances: {}, allocations: {} },

  pulumi: async ({ $, inputs, state }) => {
    const { region, labels, instances } = ConfigSchema.parse(inputs);
    const recorded = ((state as any).sqlInstances ?? {}) as Record<string, SqlInstanceState>;
    const next: Record<string, unknown> = {};
    const connectionNames: Record<string, pulumi.Output<string>> = {};
    const peerings = new Map<string, { range: pulumi.Output<string>; connection: gcp.servicenetworking.Connection }>();

    for (const [key, spec] of Object.entries(instances)) {
      const engine = engineOf(spec.version);
      refuseEngineChange(key, recorded[key]?.engine, engine);

      let peering: { range: pulumi.Output<string>; connection: gcp.servicenetworking.Connection } | undefined;
      if (spec.network.mode === "private" && spec.network.createPeering && spec.network.allocatedIpRange === undefined) {
        const network = spec.network.network;
        peering = peerings.get(network);
        if (peering === undefined) {
          const index = peerings.size;
          const address = new gcp.compute.GlobalAddress(
            $`sql-peering-range-${index}`,
            { purpose: "VPC_PEERING", addressType: "INTERNAL", prefixLength: spec.network.peeringPrefixLength, network },
          );
          const connection = new gcp.servicenetworking.Connection(
            $`sql-peering-${index}`,
            { network, service: SERVICE_NETWORKING, reservedPeeringRanges: [address.name] },
          );
          peering = { range: address.name, connection };
          peerings.set(network, peering);
        }
      }
      const dependsOn = peering ? { dependsOn: [peering.connection] } : undefined;

      const primary = new gcp.sql.DatabaseInstance(
        $`instance-${key}`,
        {
          name: spec.name,
          databaseVersion: spec.version,
          region,
          encryptionKeyName: spec.encryptionKeyName,
          deletionProtection: spec.deletionProtection,
          settings: instanceSettings(spec, labels, {}, peering?.range),
        },
        { ...dependsOn, ignoreChanges: spec.storage.autoResize ? ["settings.diskSize"] : [] },
      );

      const replicas: Record<string, unknown> = {};
      for (const [replicaKey, replica] of Object.entries(spec.readReplicas)) {
        const instance = new gcp.sql.DatabaseInstance(
          $`replica-${key}-${replicaKey}`,
          {
            databaseVersion: spec.version,
            region: replica.region ?? region,
            masterInstanceName: primary.name,
            encryptionKeyName: spec.encryptionKeyName,
            deletionProtection: spec.deletionProtection,
            replicaConfiguration: { failoverTarget: false },
            settings: instanceSettings(
              spec,
              labels,
              { tier: replica.tier, highAvailability: replica.highAvailability, replica: true },
              peering?.range,
            ),
          },
          { ...dependsOn, ignoreChanges: spec.storage.autoResize ? ["settings.diskSize"] : [] },
        );
        replicas[replicaKey] = {
          instanceName: instance.name,
          connectionName: instance.connectionName,
          publicIp: instance.publicIpAddress,
          privateIp: instance.privateIpAddress,
        };
      }

      next[key] = {
        engine,
        networkMode: spec.network.mode,
        instanceName: primary.name,
        connectionName: primary.connectionName,
        publicIp: primary.publicIpAddress,
        privateIp: primary.privateIpAddress,
        replicas,
      };
      connectionNames[key] = primary.connectionName;
    }

    (state as any).sqlInstances = next;
    return { connectionNames } as any;
  },

  allocateWithPulumiCtx: async ({ name, deploymentConfig, state, $ }) => {
    const request = DatabaseAllocationSchema.parse(deploymentConfig);
    const sqlInstances = ((state as any).sqlInstances ?? {}) as Record<string, SqlInstanceState>;
    const instance = sqlInstances[request.instance];
    if (!instance) {
      throw new Error(
        `cloud-sql: app component "${name}" references instance "${request.instance}", declared instances: ${Object.keys(sqlInstances).join(", ") || "<none>"}`,
      );
    }
    const allocations = (((state as any).allocations ??= {}) as Record<string, AllocationState>);
    const existing = allocations[name];
    const dbName = request.dbName ?? identifierFor(name);
    const dbUser = request.dbUser ?? identifierFor(name);
    const password = existing?.password ?? generatePassword();
    for (const [other, taken] of Object.entries(allocations)) {
      if (other === name || taken.instanceKey !== request.instance) continue;
      if (taken.dbName === dbName || taken.dbUser === dbUser) {
        throw new Error(
          `cloud-sql: "${name}" and "${other}" both resolve to database "${dbName}" or user "${dbUser}" on instance "${request.instance}"; set dbName and dbUser explicitly`,
        );
      }
    }

    new gcp.sql.Database(
      $`db-${name}`,
      { instance: instance.instanceName, name: dbName, deletionPolicy: "ABANDON" },
    );
    new gcp.sql.User(
      $`user-${name}`,
      {
        instance: instance.instanceName,
        name: dbUser,
        password: pulumi.secret(password),
        host: instance.engine === "mysql" ? "%" : undefined,
        deletionPolicy: instance.engine === "postgres" ? "ABANDON" : undefined,
      },
      { additionalSecretOutputs: ["password"] },
    );

    allocations[name] = { instanceKey: request.instance, dbName, dbUser, password };
  },

  connect: (({ state, selfComponentName }: any) => {
    const handlerFor = (engine: Engine) => async () => {
      const allocation = ((state.allocations ?? {}) as Record<string, AllocationState>)[selfComponentName];
      if (!allocation) {
        throw new Error(`cloud-sql: no allocation found for "${selfComponentName}"`);
      }
      const instance = ((state.sqlInstances ?? {}) as Record<string, SqlInstanceState>)[allocation.instanceKey];
      if (!instance) {
        throw new Error(`cloud-sql: allocation for "${selfComponentName}" references missing instance "${allocation.instanceKey}"`);
      }
      if (instance.engine !== engine) {
        throw new Error(
          `cloud-sql: "${selfComponentName}" connects as ${engine} but instance "${allocation.instanceKey}" runs ${instance.engine}`,
        );
      }
      const result = resolved(instance).apply((value) => connectionResult(value as SqlInstanceState, allocation));
      const field = <K extends keyof ReturnType<typeof connectionResult>>(key: K) => result.apply((value) => value[key]);
      const uri = pulumi.secret(field("uri"));
      const metadata = {
        uri,
        readUri: pulumi.secret(field("readUri")),
        host: field("host"),
        port: field("port"),
        database: field("database"),
        user: field("user"),
        password: pulumi.secret(field("password")),
        socketPath: field("socketPath"),
        instanceConnectionName: field("instanceConnectionName"),
      };
      return { uri, metadata };
    };
    return [
      connectionHandler({ interface: PostgresCI, handler: handlerFor("postgres") }),
      connectionHandler({ interface: MysqlCI, handler: handlerFor("mysql") }),
    ];
  }) as any,
});

export default component;
