import { z } from "zod";

import {
  CloudProvider,
  InfraComponent,
  connectionHandler,
} from "@sdlcworks/components";

import * as gcp from "@pulumi/gcp";
import * as pulumi from "@pulumi/pulumi";

import { PostgresCI } from "../_internal/interfaces";

const InstanceConfigSchema = z.object({
  dbName: z.string(),
  dbUser: z.string(),
  dbPassword: z.string(),
});

// State per declared SQL instance (instance-level, keyed by instance name)
const SqlInstanceStateSchema = z.object({
  instanceName: z.string(),
  host: z.string(),
  port: z.number(),
  dbPassword: z.string(),
});

// State per app-component target (allocation, keyed by app component name)
const AllocationSchema = z.object({
  instanceKey: z.string(),
  dbName: z.string(),
  dbUser: z.string(),
});

const component = new InfraComponent({
  metadata: {
    stateful: true,
    proxiable: false,
  },
  connectionTypes: {
    postgres: {
      description: "Postgres connection URI for a logical database in a Cloud SQL instance",
      interface: PostgresCI,
    },
  } as const,
  connectionInterfaces: [PostgresCI],
  configSchema: z.object({
    provider: z.literal("gcloud").optional(),
    projectId: z.string().optional(),
    region: z.string().default("us-central1"),
    version: z.string().default("POSTGRES_16"),
    // Cloud SQL edition. db-custom-* tiers are valid on ENTERPRISE; on
    // ENTERPRISE_PLUS only db-perf-optimized-* tiers are valid. Default to
    // ENTERPRISE since it's cheaper and supports custom tiers; override in
    // TSC if you want ENTERPRISE_PLUS.
    edition: z.enum(["ENTERPRISE", "ENTERPRISE_PLUS"]).default("ENTERPRISE"),
    tier: z.string().default("db-custom-1-3840"),
    storageGb: z.number().default(20),
    highAvailability: z.boolean().default(false),
    instances: z.record(z.string(), InstanceConfigSchema).default({}),
  }),
  appComponentTypes: {
    postgres: z.object({
      instance: z.string(),
      dbName: z.string(),
      dbUser: z.string(),
    }),
  },
  outputSchema: z.object({}),
});

component.implement(CloudProvider.gcloud, {
  stateSchema: z.object({
    sqlInstances: z.record(z.string(), SqlInstanceStateSchema).default({}),
    allocations: z.record(z.string(), AllocationSchema).default({}),
  }),
  initialState: { sqlInstances: {}, allocations: {} },

  // Per-instance: create one Cloud SQL DatabaseInstance for each entry in the
  // declared instances map. Instance-level resources (the SQL server itself)
  // belong here; per-target Database + User are created in allocateWithPulumiCtx.
  pulumi: async ({
    $,
    inputs,
    state,
    gcp: gcpProvider,
  }) => {
    const { region, version, edition, tier, storageGb, highAvailability, instances } = inputs as any;

    const gcpOpts: pulumi.CustomResourceOptions = gcpProvider
      ? { provider: gcpProvider }
      : {};

    if (!(state as any).sqlInstances) {
      (state as any).sqlInstances = {};
    }
    const sqlInstances = (state as any).sqlInstances as Record<string, any>;

    const instancesMap = (instances ?? {}) as Record<
      string,
      { dbName: string; dbUser: string; dbPassword: string }
    >;

    for (const [instanceKey, instanceCfg] of Object.entries(instancesMap)) {
      const sqlInstance = new gcp.sql.DatabaseInstance(
        $`instance-${instanceKey}`,
        {
          databaseVersion: version,
          region,
          settings: {
            edition,
            tier,
            availabilityType: highAvailability ? "REGIONAL" : "ZONAL",
            diskSize: storageGb,
            diskType: "PD_SSD",
            ipConfiguration: {
              ipv4Enabled: true,
              authorizedNetworks: [{ name: "all", value: "0.0.0.0/0" }],
            },
            backupConfiguration: {
              enabled: true,
              pointInTimeRecoveryEnabled: true,
            },
          },
          deletionProtection: false,
        },
        gcpOpts,
      );

      sqlInstances[instanceKey] = {
        instanceName: sqlInstance.name,
        host: sqlInstance.publicIpAddress,
        port: 5432,
        dbPassword: instanceCfg.dbPassword,
      };
    }

    return {};
  },

  // Per-target: create the logical Database and SQL User on the referenced
  // SQL instance, then record the allocation for the connect handler.
  allocateWithPulumiCtx: async ({
    name,
    deploymentConfig,
    state,
    $,
    gcp: gcpProvider,
  }) => {
    const instanceKey: string = deploymentConfig.instance;
    const dbName: string = deploymentConfig.dbName;
    const dbUser: string = deploymentConfig.dbUser;

    const gcpOpts: pulumi.CustomResourceOptions = gcpProvider
      ? { provider: gcpProvider }
      : {};

    const sqlInstances = ((state as any).sqlInstances ?? {}) as Record<
      string,
      { instanceName: any; dbPassword: any }
    >;
    const sqlInstance = sqlInstances[instanceKey];
    if (!sqlInstance) {
      throw new Error(
        `cloud-sql(gcloud): app component '${name}' references SQL instance '${instanceKey}' which was not provisioned (have: ${Object.keys(sqlInstances).join(", ") || "<none>"})`,
      );
    }

    new gcp.sql.Database(
      $`db-${name}`,
      {
        instance: sqlInstance.instanceName,
        name: dbName,
      },
      gcpOpts,
    );

    new gcp.sql.User(
      $`user-${name}`,
      {
        instance: sqlInstance.instanceName,
        name: dbUser,
        password: sqlInstance.dbPassword,
      },
      gcpOpts,
    );

    if (!(state as any).allocations) {
      (state as any).allocations = {};
    }
    (state as any).allocations[name] = {
      instanceKey,
      dbName,
      dbUser,
    };
  },

  connect: (({ state, selfComponentName }: any) => [
    connectionHandler({
      interface: PostgresCI,
      handler: async (_ctx: any) => {
        const allocations = (state.allocations ?? {}) as Record<string, any>;
        const sqlInstances = (state.sqlInstances ?? {}) as Record<string, any>;
        const a = allocations[selfComponentName];
        if (!a) {
          throw new Error(
            `cloud-sql(gcloud): no allocation found for '${selfComponentName}' — was it allocated via allocateWithPulumiCtx?`,
          );
        }
        const inst = sqlInstances[a.instanceKey];
        if (!inst) {
          throw new Error(
            `cloud-sql(gcloud): allocation references instance '${a.instanceKey}' but it is not in state.sqlInstances`,
          );
        }
        const uri = pulumi
          .all([a.dbUser, inst.dbPassword, inst.host, inst.port ?? 5432, a.dbName])
          .apply(([user, pass, host, port, db]) => {
            const enc = (s: string) => encodeURIComponent(s);
            return `postgresql://${enc(user)}:${enc(pass)}@${host}:${port}/${enc(db)}?sslmode=require`;
          });
        return {
          uri,
          metadata: { uri },
        };
      },
    }),
  ]),
});

export default component;
