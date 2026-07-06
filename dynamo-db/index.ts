import { z } from "zod";

import {
  CloudProvider,
  InfraComponent,
  connectionHandler,
  defaultAppComponentType,
} from "@sdlcworks/components";

import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";

import { DynamoTableCI } from "../_internal/interfaces";

export const DEFAULT_TABLE_RESOURCE_NAME = "table";
export const TABLE_CONNECTION_TYPE = "table";
export const DEFAULT_BILLING_MODE = "PAY_PER_REQUEST";
export const DEFAULT_TABLE_CLASS = "STANDARD";
export const CONFIG_TABLE_CLASS_STANDARD_IA = "STANDARD_IA";
export const PULUMI_TABLE_CLASS_STANDARD_IA = "STANDARD_INFREQUENT_ACCESS";
export const DEFAULT_PITR_ENABLED = true;
export const DEFAULT_DELETION_PROTECTION = false;
export const DYNAMO_URI_SCHEME = "dynamodb";

const AttributeType = z.enum(["S", "N", "B"]);
const BillingMode = z.enum(["PROVISIONED", "PAY_PER_REQUEST"]);
const ProjectionType = z.enum(["ALL", "KEYS_ONLY", "INCLUDE"]);
const StreamViewType = z.enum([
  "KEYS_ONLY",
  "NEW_IMAGE",
  "OLD_IMAGE",
  "NEW_AND_OLD_IMAGES",
]);
const TableClass = z.enum(["STANDARD", "STANDARD_IA"]);

const AttributeSchema = z.object({
  name: z.string().min(1),
  type: AttributeType,
});

const OnDemandThroughputSchema = z.object({
  maxReadRequestUnits: z.number().optional(),
  maxWriteRequestUnits: z.number().optional(),
});

const WarmThroughputSchema = z.object({
  readUnitsPerSecond: z.number().optional(),
  writeUnitsPerSecond: z.number().optional(),
});

const GlobalSecondaryIndexSchema = z.object({
  name: z.string().min(1),
  hashKey: z.string().min(1),
  rangeKey: z.string().min(1).optional(),
  projectionType: ProjectionType,
  nonKeyAttributes: z.array(z.string().min(1)).optional(),
  readCapacity: z.number().optional(),
  writeCapacity: z.number().optional(),
  onDemandThroughput: OnDemandThroughputSchema.optional(),
});

const LocalSecondaryIndexSchema = z.object({
  name: z.string().min(1),
  rangeKey: z.string().min(1),
  projectionType: ProjectionType,
  nonKeyAttributes: z.array(z.string().min(1)).optional(),
});

const TtlSchema = z.object({
  attributeName: z.string().min(1),
  enabled: z.boolean().default(true),
});

const PointInTimeRecoverySchema = z.object({
  enabled: z.boolean().default(DEFAULT_PITR_ENABLED),
  recoveryPeriodInDays: z.number().max(35).optional(),
});

const ServerSideEncryptionSchema = z.object({
  enabled: z.boolean(),
  kmsKeyArn: z.string().optional(),
});

function addIssue(
  ctx: z.RefinementCtx,
  path: (string | number)[],
  message: string,
) {
  ctx.addIssue({ code: "custom", path, message });
}

function projectionPath(
  kind: "globalSecondaryIndexes" | "localSecondaryIndexes",
  index: number,
) {
  return `${kind}[${index}]`;
}

function isInteger(value: number) {
  return Number.isInteger(value);
}

function isPositiveInteger(value: number) {
  return isInteger(value) && value > 0;
}

function isOnDemandCap(value: number) {
  return isInteger(value) && (value === -1 || value >= 1);
}

export const DynamoDbConfigSchema = z
  .object({
    name: z.string().default(""),
    hashKey: z.string().min(1),
    rangeKey: z.string().min(1).optional(),
    attributes: z.array(AttributeSchema).min(1),

    billingMode: BillingMode.default(DEFAULT_BILLING_MODE),
    readCapacity: z.number().optional(),
    writeCapacity: z.number().optional(),
    onDemandThroughput: OnDemandThroughputSchema.optional(),
    warmThroughput: WarmThroughputSchema.optional(),

    globalSecondaryIndexes: z.array(GlobalSecondaryIndexSchema).default([]),
    localSecondaryIndexes: z.array(LocalSecondaryIndexSchema).default([]),

    streamEnabled: z.boolean().default(false),
    streamViewType: StreamViewType.optional(),

    ttl: TtlSchema.optional(),
    pointInTimeRecovery: PointInTimeRecoverySchema.default({
      enabled: DEFAULT_PITR_ENABLED,
    }),
    serverSideEncryption: ServerSideEncryptionSchema.optional(),
    tableClass: TableClass.default(DEFAULT_TABLE_CLASS),
    deletionProtection: z.boolean().default(DEFAULT_DELETION_PROTECTION),
    resourcePolicyJson: z.string().default(""),
    tags: z.record(z.string(), z.string()).default({}),
  })
  .superRefine((config, ctx) => {
    const declared = new Set<string>();
    for (const attr of config.attributes) {
      if (declared.has(attr.name)) {
        addIssue(ctx, ["attributes"], "attributes names must be unique");
      }
      declared.add(attr.name);
    }

    const used = new Set<string>();
    const requireDeclared = (
      key: string | undefined,
      path: (string | number)[],
      label: string,
    ) => {
      if (!key) return;
      used.add(key);
      if (!declared.has(key)) {
        addIssue(ctx, path, `${label} must reference a declared attribute`);
      }
    };

    requireDeclared(config.hashKey, ["hashKey"], "hashKey");
    requireDeclared(config.rangeKey, ["rangeKey"], "rangeKey");

    config.globalSecondaryIndexes.forEach((index, i) => {
      requireDeclared(
        index.hashKey,
        ["globalSecondaryIndexes", i, "hashKey"],
        `globalSecondaryIndexes[${i}].hashKey`,
      );
      requireDeclared(
        index.rangeKey,
        ["globalSecondaryIndexes", i, "rangeKey"],
        `globalSecondaryIndexes[${i}].rangeKey`,
      );
    });

    config.localSecondaryIndexes.forEach((index, i) => {
      requireDeclared(
        index.rangeKey,
        ["localSecondaryIndexes", i, "rangeKey"],
        `localSecondaryIndexes[${i}].rangeKey`,
      );
    });

    for (const attr of config.attributes) {
      if (!used.has(attr.name)) {
        addIssue(
          ctx,
          ["attributes"],
          `attributes[${attr.name}] is not used by the table key or any index key`,
        );
      }
    }

    const checkPositiveInteger = (
      value: number | undefined,
      path: (string | number)[],
      label: string,
    ) => {
      if (value != null && !isPositiveInteger(value)) {
        addIssue(ctx, path, `${label} must be a positive integer`);
      }
    };

    const checkOnDemandCap = (
      value: number | undefined,
      path: (string | number)[],
      label: string,
    ) => {
      if (value != null && !isOnDemandCap(value)) {
        addIssue(
          ctx,
          path,
          `${label} must be an integer greater than or equal to 1, or -1 to remove the cap`,
        );
      }
    };

    checkPositiveInteger(config.readCapacity, ["readCapacity"], "readCapacity");
    checkPositiveInteger(config.writeCapacity, ["writeCapacity"], "writeCapacity");
    checkOnDemandCap(
      config.onDemandThroughput?.maxReadRequestUnits,
      ["onDemandThroughput", "maxReadRequestUnits"],
      "onDemandThroughput.maxReadRequestUnits",
    );
    checkOnDemandCap(
      config.onDemandThroughput?.maxWriteRequestUnits,
      ["onDemandThroughput", "maxWriteRequestUnits"],
      "onDemandThroughput.maxWriteRequestUnits",
    );
    checkPositiveInteger(
      config.warmThroughput?.readUnitsPerSecond,
      ["warmThroughput", "readUnitsPerSecond"],
      "warmThroughput.readUnitsPerSecond",
    );
    checkPositiveInteger(
      config.warmThroughput?.writeUnitsPerSecond,
      ["warmThroughput", "writeUnitsPerSecond"],
      "warmThroughput.writeUnitsPerSecond",
    );
    if (
      config.pointInTimeRecovery.recoveryPeriodInDays != null &&
      (!isInteger(config.pointInTimeRecovery.recoveryPeriodInDays) ||
        config.pointInTimeRecovery.recoveryPeriodInDays < 1 ||
        config.pointInTimeRecovery.recoveryPeriodInDays > 35)
    ) {
      addIssue(
        ctx,
        ["pointInTimeRecovery", "recoveryPeriodInDays"],
        "pointInTimeRecovery.recoveryPeriodInDays must be an integer between 1 and 35",
      );
    }

    if (config.localSecondaryIndexes.length > 0 && !config.rangeKey) {
      addIssue(
        ctx,
        ["localSecondaryIndexes"],
        "localSecondaryIndexes require table rangeKey",
      );
    }

    if (config.billingMode === "PROVISIONED") {
      if (config.readCapacity == null) {
        addIssue(
          ctx,
          ["readCapacity"],
          "readCapacity is required when billingMode is PROVISIONED",
        );
      }
      if (config.writeCapacity == null) {
        addIssue(
          ctx,
          ["writeCapacity"],
          "writeCapacity is required when billingMode is PROVISIONED",
        );
      }
      if (config.onDemandThroughput != null) {
        addIssue(
          ctx,
          ["onDemandThroughput"],
          "onDemandThroughput is only valid when billingMode is PAY_PER_REQUEST",
        );
      }
    } else {
      if (config.readCapacity != null) {
        addIssue(
          ctx,
          ["readCapacity"],
          "readCapacity is only valid when billingMode is PROVISIONED",
        );
      }
      if (config.writeCapacity != null) {
        addIssue(
          ctx,
          ["writeCapacity"],
          "writeCapacity is only valid when billingMode is PROVISIONED",
        );
      }
    }

    config.globalSecondaryIndexes.forEach((index, i) => {
      checkPositiveInteger(
        index.readCapacity,
        ["globalSecondaryIndexes", i, "readCapacity"],
        `globalSecondaryIndexes[${i}].readCapacity`,
      );
      checkPositiveInteger(
        index.writeCapacity,
        ["globalSecondaryIndexes", i, "writeCapacity"],
        `globalSecondaryIndexes[${i}].writeCapacity`,
      );
      checkOnDemandCap(
        index.onDemandThroughput?.maxReadRequestUnits,
        ["globalSecondaryIndexes", i, "onDemandThroughput", "maxReadRequestUnits"],
        `globalSecondaryIndexes[${i}].onDemandThroughput.maxReadRequestUnits`,
      );
      checkOnDemandCap(
        index.onDemandThroughput?.maxWriteRequestUnits,
        ["globalSecondaryIndexes", i, "onDemandThroughput", "maxWriteRequestUnits"],
        `globalSecondaryIndexes[${i}].onDemandThroughput.maxWriteRequestUnits`,
      );
      if (config.billingMode === "PROVISIONED") {
        if (index.readCapacity == null) {
          addIssue(
            ctx,
            ["globalSecondaryIndexes", i, "readCapacity"],
            `globalSecondaryIndexes[${i}].readCapacity is required when billingMode is PROVISIONED`,
          );
        }
        if (index.writeCapacity == null) {
          addIssue(
            ctx,
            ["globalSecondaryIndexes", i, "writeCapacity"],
            `globalSecondaryIndexes[${i}].writeCapacity is required when billingMode is PROVISIONED`,
          );
        }
        if (index.onDemandThroughput != null) {
          addIssue(
            ctx,
            ["globalSecondaryIndexes", i, "onDemandThroughput"],
            `globalSecondaryIndexes[${i}].onDemandThroughput is only valid when billingMode is PAY_PER_REQUEST`,
          );
        }
      } else {
        if (index.readCapacity != null) {
          addIssue(
            ctx,
            ["globalSecondaryIndexes", i, "readCapacity"],
            `globalSecondaryIndexes[${i}].readCapacity is only valid when billingMode is PROVISIONED`,
          );
        }
        if (index.writeCapacity != null) {
          addIssue(
            ctx,
            ["globalSecondaryIndexes", i, "writeCapacity"],
            `globalSecondaryIndexes[${i}].writeCapacity is only valid when billingMode is PROVISIONED`,
          );
        }
      }
    });

    const checkProjection = (
      kind: "globalSecondaryIndexes" | "localSecondaryIndexes",
      index: number,
      projectionType: z.infer<typeof ProjectionType>,
      nonKeyAttributes: string[] | undefined,
    ) => {
      const label = projectionPath(kind, index);
      if (projectionType === "INCLUDE") {
        if (!nonKeyAttributes || nonKeyAttributes.length === 0) {
          addIssue(
            ctx,
            [kind, index, "nonKeyAttributes"],
            `${label}.nonKeyAttributes is required when projectionType is INCLUDE`,
          );
        }
      } else if (nonKeyAttributes != null) {
        addIssue(
          ctx,
          [kind, index, "nonKeyAttributes"],
          `${label}.nonKeyAttributes is only valid when projectionType is INCLUDE`,
        );
      }
    };

    config.globalSecondaryIndexes.forEach((index, i) => {
      checkProjection(
        "globalSecondaryIndexes",
        i,
        index.projectionType,
        index.nonKeyAttributes,
      );
    });
    config.localSecondaryIndexes.forEach((index, i) => {
      checkProjection(
        "localSecondaryIndexes",
        i,
        index.projectionType,
        index.nonKeyAttributes,
      );
    });

    if (config.streamEnabled && !config.streamViewType) {
      addIssue(
        ctx,
        ["streamViewType"],
        "streamViewType is required when streamEnabled is true",
      );
    }
    if (!config.streamEnabled && config.streamViewType) {
      addIssue(
        ctx,
        ["streamViewType"],
        "streamViewType is only valid when streamEnabled is true",
      );
    }
    if (config.resourcePolicyJson.trim() !== "") {
      try {
        JSON.parse(config.resourcePolicyJson);
      } catch {
        addIssue(
          ctx,
          ["resourcePolicyJson"],
          "resourcePolicyJson must be valid JSON",
        );
      }
    }
  });

export type DynamoDbConfig = z.infer<typeof DynamoDbConfigSchema>;

function tableClassForPulumi(tableClass: DynamoDbConfig["tableClass"]): string {
  if (tableClass === CONFIG_TABLE_CLASS_STANDARD_IA) {
    return PULUMI_TABLE_CLASS_STANDARD_IA;
  }
  return tableClass;
}

export function buildTableArgs(
  inputs: DynamoDbConfig,
  derivedTableName: string,
): aws.dynamodb.TableArgs {
  return {
    name: inputs.name || derivedTableName,
    hashKey: inputs.hashKey,
    rangeKey: inputs.rangeKey || undefined,
    attributes: inputs.attributes,
    billingMode: inputs.billingMode,
    readCapacity: inputs.readCapacity,
    writeCapacity: inputs.writeCapacity,
    onDemandThroughput: inputs.onDemandThroughput,
    warmThroughput: inputs.warmThroughput,
    globalSecondaryIndexes: inputs.globalSecondaryIndexes.map((index) => ({
      name: index.name,
      hashKey: index.hashKey,
      rangeKey: index.rangeKey,
      projectionType: index.projectionType,
      nonKeyAttributes: index.nonKeyAttributes,
      readCapacity: index.readCapacity,
      writeCapacity: index.writeCapacity,
      onDemandThroughput: index.onDemandThroughput,
    })),
    localSecondaryIndexes:
      inputs.localSecondaryIndexes.length > 0
        ? inputs.localSecondaryIndexes.map((index) => ({
            name: index.name,
            rangeKey: index.rangeKey,
            projectionType: index.projectionType,
            nonKeyAttributes: index.nonKeyAttributes,
          }))
        : undefined,
    streamEnabled: inputs.streamEnabled,
    streamViewType: inputs.streamEnabled ? inputs.streamViewType : undefined,
    ttl: inputs.ttl
      ? inputs.ttl.enabled === false
        ? { enabled: false }
        : inputs.ttl
      : undefined,
    pointInTimeRecovery: inputs.pointInTimeRecovery,
    serverSideEncryption: inputs.serverSideEncryption,
    tableClass: tableClassForPulumi(inputs.tableClass),
    deletionProtectionEnabled: inputs.deletionProtection,
    tags: inputs.tags,
  };
}

type DynamoTableState = {
  tableName?: string;
  tableArn?: string;
  streamArn?: string;
  region?: string;
};

export function requireDynamoTableIdentity(state: DynamoTableState) {
  if (!state.tableName || !state.tableArn || !state.region) {
    throw new Error(
      "dynamo-db(aws): missing table identity in state; expected tableName, tableArn, and region",
    );
  }
  return {
    tableName: state.tableName,
    tableArn: state.tableArn,
    region: state.region,
    streamArn: state.streamArn,
  };
}

const component = new InfraComponent({
  metadata: {
    stateful: true,
    proxiable: false,
  },
  connectionTypes: {
    [TABLE_CONNECTION_TYPE]: {
      description:
        "read/write access to the DynamoDB table (access governed by the consumer's IAM identity)",
      interface: DynamoTableCI,
    },
  } as const,
  connectionInterfaces: [DynamoTableCI],
  configSchema: DynamoDbConfigSchema,
  appComponentTypes: defaultAppComponentType(z.object({})),
  outputSchema: z.object({
    tableName: z.string(),
    tableArn: z.string(),
    tableId: z.string(),
    streamArn: z.string().optional(),
  }),
});

component.implement(CloudProvider.aws, {
  stateSchema: z.object({
    tableName: z.string().optional(),
    tableArn: z.string().optional(),
    streamArn: z.string().optional(),
    region: z.string().optional(),
  }),
  initialState: {},

  pulumi: async ({ $, inputs, state, getCredentials, aws: awsProvider }) => {
    const region = getCredentials().AWS_REGION;
    if (!region) {
      throw new Error("dynamo-db(aws): AWS_REGION is required in cloud credentials");
    }

    const awsOpts: pulumi.CustomResourceOptions = awsProvider
      ? { provider: awsProvider }
      : {};

    const derivedTableName = $`${DEFAULT_TABLE_RESOURCE_NAME}`;
    const table = new aws.dynamodb.Table(
      derivedTableName,
      buildTableArgs(inputs as DynamoDbConfig, derivedTableName),
      awsOpts,
    );

    if ((inputs as DynamoDbConfig).resourcePolicyJson.trim() !== "") {
      new aws.dynamodb.ResourcePolicy(
        $`resource-policy`,
        {
          resourceArn: table.arn,
          policy: (inputs as DynamoDbConfig).resourcePolicyJson,
        },
        awsOpts,
      );
    }

    state.tableName = table.name;
    state.tableArn = table.arn;
    state.streamArn = table.streamArn;
    state.region = region;

    return {
      tableName: table.name,
      tableArn: table.arn,
      tableId: table.id,
      streamArn: table.streamArn,
    };
  },

  connect: (({ state }: any) => [
    connectionHandler({
      interface: DynamoTableCI,
      handler: async (_ctx: any) => {
        const identity = requireDynamoTableIdentity(state);
        return {
          uri: pulumi.interpolate`${DYNAMO_URI_SCHEME}://${identity.region}/${identity.tableName}`,
          metadata: {
            tableName: identity.tableName,
            tableArn: identity.tableArn,
            region: identity.region,
            streamArn: identity.streamArn,
          },
        };
      },
    }),
  ]),
});

export default component;
