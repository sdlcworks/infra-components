import { z } from "zod";

import {
  CloudProvider,
  InfraComponent,
  connectionHandler,
} from "@sdlcworks/components";

import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";

import { DynamoTableCI } from "../_internal/interfaces";

const BILLING_MODES = ["PAY_PER_REQUEST", "PROVISIONED"] as const;
const KEY_ATTRIBUTE_TYPES = ["S", "N", "B"] as const;
const PROJECTION_TYPES = ["ALL", "INCLUDE", "KEYS_ONLY"] as const;
const STREAM_VIEW_TYPES = [
  "KEYS_ONLY",
  "NEW_IMAGE",
  "OLD_IMAGE",
  "NEW_AND_OLD_IMAGES",
] as const;
const TABLE_CLASS_STANDARD = "STANDARD";
const DYNAMO_TABLE_CONNECTION_TYPE = "dynamo-table";
const REPLACEMENT_FINGERPRINT_ERROR_PREFIX =
  "aws-dynamodb: key schema change refused";
const REPLACEMENT_FINGERPRINT_ERROR_MESSAGE =
  "Changing a table hash key, range key, or local secondary index would replace the DynamoDB table and risk total data loss. Create a new table and migrate data explicitly.";
const CONFIG_SNAPSHOT_MISSING_ERROR =
  "aws-dynamodb: config snapshot missing from state; pulumi() must run before allocateWithPulumiCtx.";

const KeyAttributeSchema = z.object({
  name: z.string().min(1),
  type: z.enum(KEY_ATTRIBUTE_TYPES),
});

const PointInTimeRecoverySchema = z.object({
  enabled: z.boolean(),
  recoveryPeriodInDays: z.number().int().min(1).max(35).optional(),
});

const SecondaryIndexBaseSchema = z.object({
  name: z.string().min(1),
  projectionType: z.enum(PROJECTION_TYPES),
  nonKeyAttributes: z.array(z.string().min(1)).optional(),
});

const GlobalSecondaryIndexSchema = SecondaryIndexBaseSchema.extend({
  hashKey: KeyAttributeSchema,
  rangeKey: KeyAttributeSchema.optional(),
  readCapacity: z.number().int().min(1).optional(),
  writeCapacity: z.number().int().min(1).optional(),
});

const LocalSecondaryIndexSchema = SecondaryIndexBaseSchema.extend({
  rangeKey: KeyAttributeSchema,
});

const TableSchema = z.object({
  hashKey: KeyAttributeSchema,
  rangeKey: KeyAttributeSchema.optional(),
  billingMode: z.enum(BILLING_MODES),
  pointInTimeRecovery: PointInTimeRecoverySchema,
  deletionProtection: z.boolean().default(true),
  globalSecondaryIndexes: z.array(GlobalSecondaryIndexSchema).default([]),
  localSecondaryIndexes: z.array(LocalSecondaryIndexSchema).default([]),
  ttlAttribute: z.string().min(1).optional(),
  streamView: z.enum(STREAM_VIEW_TYPES).optional(),
  kmsKeyArn: z.string().min(1).optional(),
  tableClass: z.literal(TABLE_CLASS_STANDARD).default(TABLE_CLASS_STANDARD),
  readCapacity: z.number().int().min(1).optional(),
  writeCapacity: z.number().int().min(1).optional(),
}).strict();

const ConfigSchema = z.object({
  tables: z.record(z.string(), TableSchema).refine(
    (tables) => Object.keys(tables).length > 0,
    "aws-dynamodb: tables must declare at least one table.",
  ),
});

const AccessSchema = z.enum(["read", "write"]);

const AppComponentSchema = z.object({
  tables: z.array(z.object({
    table: z.string(),
    access: AccessSchema,
  })).min(1),
});

const AllocationSchema = z.object({
  tables: z.array(z.object({
    logicalName: z.string(),
    tableName: z.string(),
    arn: z.string(),
    streamArn: z.string().optional(),
    access: AccessSchema,
  })),
});

type KeyAttribute = z.infer<typeof KeyAttributeSchema>;
type TableConfig = z.infer<typeof TableSchema>;
type Config = z.infer<typeof ConfigSchema>;
type AppComponentConfig = z.infer<typeof AppComponentSchema>;
type Allocation = z.infer<typeof AllocationSchema>;

type TableFingerprint = {
  hashKey: KeyAttribute;
  rangeKey: KeyAttribute | null;
  localSecondaryIndexes: Array<{
    name: string;
    rangeKey: KeyAttribute;
    projectionType: (typeof PROJECTION_TYPES)[number];
    nonKeyAttributes: string[];
  }>;
};

const component = new InfraComponent({
  metadata: {
    stateful: true,
    proxiable: false,
  },
  connectionTypes: {
    [DYNAMO_TABLE_CONNECTION_TYPE]: {
      description: "DynamoDB table coordinates for app access under ambient AWS credentials",
      interface: DynamoTableCI,
    },
  } as const,
  connectionInterfaces: [DynamoTableCI],
  configSchema: ConfigSchema,
  appComponentTypes: {
    default: AppComponentSchema,
  },
  outputSchema: z.object({
    region: z.string(),
    tableNames: z.record(z.string(), z.string()),
    tableArns: z.record(z.string(), z.string()),
    streamArns: z.record(z.string(), z.string().optional()),
  }),
});

function validateCapacityForBillingMode(tableKey: string, table: TableConfig): void {
  if (table.billingMode === "PAY_PER_REQUEST") {
    if (table.readCapacity !== undefined || table.writeCapacity !== undefined) {
      throw new Error(
        `aws-dynamodb: table "${tableKey}" uses PAY_PER_REQUEST billing and must omit readCapacity and writeCapacity.`,
      );
    }

    table.globalSecondaryIndexes.forEach((index) => {
      if (
        index.readCapacity !== undefined ||
        index.writeCapacity !== undefined
      ) {
        throw new Error(
          `aws-dynamodb: table "${tableKey}" globalSecondaryIndexes "${index.name}" uses PAY_PER_REQUEST table billing and must omit readCapacity and writeCapacity.`,
        );
      }
    });
    return;
  }

  if (table.readCapacity === undefined || table.writeCapacity === undefined) {
    throw new Error(
      `aws-dynamodb: table "${tableKey}" uses PROVISIONED billing and must set readCapacity and writeCapacity.`,
    );
  }

  table.globalSecondaryIndexes.forEach((index) => {
    if (index.readCapacity === undefined || index.writeCapacity === undefined) {
      throw new Error(
        `aws-dynamodb: table "${tableKey}" globalSecondaryIndexes "${index.name}" uses PROVISIONED table billing and must set readCapacity and writeCapacity.`,
      );
    }
  });
}

function addAttribute(
  attributes: Map<string, (typeof KEY_ATTRIBUTE_TYPES)[number]>,
  attribute: KeyAttribute | undefined,
): void {
  if (!attribute) {
    return;
  }

  const existingType = attributes.get(attribute.name);
  if (existingType && existingType !== attribute.type) {
    throw new Error(
      `aws-dynamodb: attribute "${attribute.name}" is declared with conflicting key types "${existingType}" and "${attribute.type}".`,
    );
  }

  attributes.set(attribute.name, attribute.type);
}

function deriveAttributes(table: TableConfig): Array<{ name: string; type: string }> {
  const attributes = new Map<string, (typeof KEY_ATTRIBUTE_TYPES)[number]>();

  addAttribute(attributes, table.hashKey);
  addAttribute(attributes, table.rangeKey);

  for (const index of table.globalSecondaryIndexes) {
    addAttribute(attributes, index.hashKey);
    addAttribute(attributes, index.rangeKey);
  }

  for (const index of table.localSecondaryIndexes) {
    addAttribute(attributes, index.rangeKey);
  }

  return Array.from(attributes.entries())
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, type]) => ({ name, type }));
}

function tableFingerprint(table: TableConfig): TableFingerprint {
  return {
    hashKey: table.hashKey,
    rangeKey: table.rangeKey ?? null,
    localSecondaryIndexes: table.localSecondaryIndexes
      .map((index) => ({
        name: index.name,
        rangeKey: index.rangeKey,
        projectionType: index.projectionType,
        nonKeyAttributes: [...(index.nonKeyAttributes ?? [])].sort(),
      }))
      .sort((left, right) => left.name.localeCompare(right.name)),
  };
}

function assertReplacementFingerprint(
  tableKey: string,
  storedFingerprint: string | undefined,
  requestedFingerprint: TableFingerprint,
): string {
  const requested = JSON.stringify(requestedFingerprint);

  if (storedFingerprint && storedFingerprint !== requested) {
    throw new Error(
      `${REPLACEMENT_FINGERPRINT_ERROR_PREFIX} for table "${tableKey}". ${REPLACEMENT_FINGERPRINT_ERROR_MESSAGE}`,
    );
  }

  return requested;
}

function globalSecondaryIndexes(table: TableConfig): aws.types.input.dynamodb.TableGlobalSecondaryIndex[] {
  return table.globalSecondaryIndexes.map((index) => ({
    name: index.name,
    hashKey: index.hashKey.name,
    rangeKey: index.rangeKey?.name,
    projectionType: index.projectionType,
    nonKeyAttributes: index.nonKeyAttributes,
    readCapacity: index.readCapacity,
    writeCapacity: index.writeCapacity,
  }));
}

function localSecondaryIndexes(table: TableConfig): aws.types.input.dynamodb.TableLocalSecondaryIndex[] {
  return table.localSecondaryIndexes.map((index) => ({
    name: index.name,
    rangeKey: index.rangeKey.name,
    projectionType: index.projectionType,
    nonKeyAttributes: index.nonKeyAttributes,
  }));
}

component.implement(CloudProvider.aws, {
  stateSchema: z.object({
    region: z.string().optional(),
    tableFingerprints: z.record(z.string(), z.string()).default({}),
    tableNames: z.record(z.string(), z.string()).default({}),
    tableArns: z.record(z.string(), z.string()).default({}),
    streamArns: z.record(z.string(), z.string().optional()).default({}),
    allocations: z.record(z.string(), AllocationSchema).default({}),
  }),
  initialState: {
    tableFingerprints: {},
    tableNames: {},
    tableArns: {},
    streamArns: {},
    allocations: {},
  },

  pulumi: async ({ $, inputs, state, aws: provider }) => {
    const { tables } = inputs as Config;
    const awsOpts: pulumi.CustomResourceOptions = provider
      ? { provider }
      : {};

    const region = aws.getRegionOutput({}, awsOpts).name;
    const tableNames: Record<string, pulumi.Output<string>> = {};
    const tableArns: Record<string, pulumi.Output<string>> = {};
    const streamArns: Record<string, pulumi.Output<string | undefined>> = {};
    const tableFingerprints = (state.tableFingerprints ?? {}) as Record<string, string>;

    for (const [tableKey, table] of Object.entries(tables)) {
      validateCapacityForBillingMode(tableKey, table);

      const fingerprint = assertReplacementFingerprint(
        tableKey,
        tableFingerprints[tableKey],
        tableFingerprint(table),
      );

      const dynamoTable = new aws.dynamodb.Table(
        $`table-${tableKey}`,
        {
          billingMode: table.billingMode,
          hashKey: table.hashKey.name,
          rangeKey: table.rangeKey?.name,
          readCapacity: table.readCapacity,
          writeCapacity: table.writeCapacity,
          attributes: deriveAttributes(table),
          pointInTimeRecovery: table.pointInTimeRecovery,
          deletionProtectionEnabled: table.deletionProtection,
          globalSecondaryIndexes: globalSecondaryIndexes(table),
          localSecondaryIndexes: localSecondaryIndexes(table),
          ttl: table.ttlAttribute
            ? { enabled: true, attributeName: table.ttlAttribute }
            : undefined,
          streamEnabled: table.streamView !== undefined,
          streamViewType: table.streamView,
          serverSideEncryption: table.kmsKeyArn
            ? { enabled: true, kmsKeyArn: table.kmsKeyArn }
            : undefined,
          tableClass: table.tableClass,
        },
        awsOpts,
      );

      tableNames[tableKey] = dynamoTable.name;
      tableArns[tableKey] = dynamoTable.arn;
      streamArns[tableKey] = table.streamView
        ? dynamoTable.streamArn.apply((streamArn) => streamArn || undefined)
        : pulumi.output(undefined);
      tableFingerprints[tableKey] = fingerprint;
    }

    const outputs = {
      region,
      tableNames: pulumi.output(tableNames),
      tableArns: pulumi.output(tableArns),
      streamArns: pulumi.output(streamArns),
    };

    (state as any).tableNames = tableNames;
    (state as any).tableArns = tableArns;
    (state as any).streamArns = streamArns;
    state.tableFingerprints = tableFingerprints;
    state.region = outputs.region;

    return outputs;
  },

  allocateWithPulumiCtx: async ({ name, deploymentConfig, state }: any) => {
    const config = deploymentConfig as AppComponentConfig;
    const tableNames = (state.tableNames ?? {}) as Record<string, string>;
    const tableArns = (state.tableArns ?? {}) as Record<string, string>;
    const streamArns = (state.streamArns ?? {}) as Record<string, string | undefined>;

    if (!state.tableNames || !state.tableArns) {
      throw new Error(CONFIG_SNAPSHOT_MISSING_ERROR);
    }

    const allocation: Allocation = {
      tables: config.tables.map((selection) => {
        if (!(selection.table in tableNames)) {
          throw new Error(
            `aws-dynamodb: app component "${name}" requested unknown table "${selection.table}".`,
          );
        }

        return {
          logicalName: selection.table,
          tableName: tableNames[selection.table],
          arn: tableArns[selection.table],
          streamArn: streamArns[selection.table],
          access: selection.access,
        };
      }),
    };

    if (!state.allocations) {
      state.allocations = {};
    }
    state.allocations[name] = allocation;
  },

  connect: (({ state, selfComponentName }: any) => [
    connectionHandler({
      interface: DynamoTableCI,
      handler: async (_ctx: any) => {
        const allocations = (state.allocations ?? {}) as Record<string, Allocation>;
        const allocation = allocations[selfComponentName];

        if (!allocation) {
          throw new Error(
            `aws-dynamodb: no allocation found for "${selfComponentName}"; was it allocated via allocateWithPulumiCtx?`,
          );
        }

        return {
          uri: pulumi.interpolate`dynamodb://${selfComponentName}`,
          metadata: {
            region: state.region,
            tables: allocation.tables,
          },
        };
      },
    }),
  ]),
});

export default component;
