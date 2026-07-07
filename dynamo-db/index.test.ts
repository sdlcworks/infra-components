import { describe, expect, mock, test } from "bun:test";

mock.module("@pulumi/pulumi", () => ({
  output: (value: unknown) => value,
  interpolate: (strings: TemplateStringsArray, ...values: unknown[]) =>
    String.raw({ raw: strings }, ...values),
  all: (values: unknown[]) => values,
  CustomResource: class {},
  Output: {
    isInstance: () => false,
  },
}));

mock.module("@pulumi/aws", () => ({
  dynamodb: {
    Table: class {},
    ResourcePolicy: class {},
  },
}));

const {
  default: component,
  DynamoDbConfigSchema,
  buildTableArgs,
  requireDynamoTableIdentity,
} = await import("./index");

const baseConfig = {
  hashKey: "pk",
  attributes: [{ name: "pk", type: "S" }],
};

function messagesFor(config: unknown): string[] {
  const result = DynamoDbConfigSchema.safeParse(config);
  if (result.success) return [];
  return result.error.issues.map((issue) => issue.message);
}

describe("dynamo-db config validation", () => {
  test("accepts the minimal on-demand table declaration", () => {
    const parsed = DynamoDbConfigSchema.parse(baseConfig);
    expect(parsed.billingMode).toBe("PAY_PER_REQUEST");
    expect(parsed.globalSecondaryIndexes).toEqual([]);
    expect(parsed.localSecondaryIndexes).toEqual([]);
    expect(parsed.pointInTimeRecovery).toEqual({ enabled: true });
    expect(parsed.tableClass).toBe("STANDARD");
    expect(parsed.deletionProtection).toBe(false);
  });

  test("requires all key fields to reference declared attributes", () => {
    expect(messagesFor({ ...baseConfig, rangeKey: "sk" })).toContain(
      "rangeKey must reference a declared attribute",
    );
    expect(
      messagesFor({
        ...baseConfig,
        globalSecondaryIndexes: [
          { name: "gsi1", hashKey: "gpk", projectionType: "ALL" },
        ],
      }),
    ).toContain(
      "globalSecondaryIndexes[0].hashKey must reference a declared attribute",
    );
  });

  test("rejects unused and duplicate attribute declarations", () => {
    expect(
      messagesFor({
        ...baseConfig,
        attributes: [
          { name: "pk", type: "S" },
          { name: "unused", type: "S" },
        ],
      }),
    ).toContain(
      "attributes[unused] is not used by the table key or any index key",
    );

    expect(
      messagesFor({
        ...baseConfig,
        attributes: [
          { name: "pk", type: "S" },
          { name: "pk", type: "N" },
        ],
      }),
    ).toContain("attributes names must be unique");
  });

  test("enforces LSI and projection cross-field rules", () => {
    expect(
      messagesFor({
        ...baseConfig,
        attributes: [
          { name: "pk", type: "S" },
          { name: "lsi_sk", type: "S" },
        ],
        localSecondaryIndexes: [
          { name: "byLocal", rangeKey: "lsi_sk", projectionType: "ALL" },
        ],
      }),
    ).toContain("localSecondaryIndexes require table rangeKey");

    expect(
      messagesFor({
        ...baseConfig,
        globalSecondaryIndexes: [
          { name: "gsi1", hashKey: "pk", projectionType: "INCLUDE" },
        ],
      }),
    ).toContain(
      "globalSecondaryIndexes[0].nonKeyAttributes is required when projectionType is INCLUDE",
    );

    expect(
      messagesFor({
        ...baseConfig,
        globalSecondaryIndexes: [
          {
            name: "gsi1",
            hashKey: "pk",
            projectionType: "ALL",
            nonKeyAttributes: ["x"],
          },
        ],
      }),
    ).toContain(
      "globalSecondaryIndexes[0].nonKeyAttributes is only valid when projectionType is INCLUDE",
    );
  });

  test("enforces provisioned capacity rules on table and GSIs", () => {
    expect(messagesFor({ ...baseConfig, billingMode: "PROVISIONED" })).toEqual(
      expect.arrayContaining([
        "readCapacity is required when billingMode is PROVISIONED",
        "writeCapacity is required when billingMode is PROVISIONED",
      ]),
    );

    expect(
      messagesFor({
        ...baseConfig,
        readCapacity: 5,
        writeCapacity: 5,
      }),
    ).toEqual(
      expect.arrayContaining([
        "readCapacity is only valid when billingMode is PROVISIONED",
        "writeCapacity is only valid when billingMode is PROVISIONED",
      ]),
    );

    expect(
      messagesFor({
        billingMode: "PROVISIONED",
        hashKey: "pk",
        readCapacity: 5,
        writeCapacity: 5,
        attributes: [
          { name: "pk", type: "S" },
          { name: "gpk", type: "S" },
        ],
        globalSecondaryIndexes: [
          { name: "gsi1", hashKey: "gpk", projectionType: "ALL" },
        ],
      }),
    ).toEqual(
      expect.arrayContaining([
        "globalSecondaryIndexes[0].readCapacity is required when billingMode is PROVISIONED",
        "globalSecondaryIndexes[0].writeCapacity is required when billingMode is PROVISIONED",
      ]),
    );
  });

  test("enforces stream view type dependency", () => {
    expect(messagesFor({ ...baseConfig, streamEnabled: true })).toContain(
      "streamViewType is required when streamEnabled is true",
    );

    expect(
      messagesFor({ ...baseConfig, streamViewType: "NEW_AND_OLD_IMAGES" }),
    ).toContain("streamViewType is only valid when streamEnabled is true");
  });

  test("does not require ttl attributeName to be declared as an attribute", () => {
    expect(
      DynamoDbConfigSchema.safeParse({
        ...baseConfig,
        ttl: { attributeName: "expiresAt" },
      }).success,
    ).toBe(true);
  });

  test("validates disabled ttl and maps it without attributeName", () => {
    const parsed = DynamoDbConfigSchema.parse({
      ...baseConfig,
      ttl: { attributeName: "expiresAt", enabled: false },
    });
    const args = buildTableArgs(parsed, "table");
    expect(args.ttl).toEqual({ enabled: false });
  });

  test("rejects invalid numeric capacity and recovery values", () => {
    expect(messagesFor({ ...baseConfig, onDemandThroughput: { maxReadRequestUnits: 0 } })).toContain(
      "onDemandThroughput.maxReadRequestUnits must be an integer greater than or equal to 1, or -1 to remove the cap",
    );
    expect(messagesFor({ ...baseConfig, warmThroughput: { readUnitsPerSecond: 1.5 } })).toContain(
      "warmThroughput.readUnitsPerSecond must be an integer greater than or equal to 12000",
    );
    expect(messagesFor({ ...baseConfig, warmThroughput: { writeUnitsPerSecond: 3999 } })).toContain(
      "warmThroughput.writeUnitsPerSecond must be an integer greater than or equal to 4000",
    );
    expect(
      messagesFor({
        ...baseConfig,
        pointInTimeRecovery: { enabled: true, recoveryPeriodInDays: 36 },
      }),
    ).toContain("pointInTimeRecovery.recoveryPeriodInDays must be an integer between 1 and 35");
  });

  test("enforces on-demand throughput compatibility with billing mode", () => {
    expect(
      messagesFor({
        ...baseConfig,
        billingMode: "PROVISIONED",
        readCapacity: 5,
        writeCapacity: 5,
        onDemandThroughput: { maxReadRequestUnits: 100 },
      }),
    ).toContain("onDemandThroughput is only valid when billingMode is PAY_PER_REQUEST");

    expect(
      messagesFor({
        billingMode: "PROVISIONED",
        hashKey: "pk",
        readCapacity: 5,
        writeCapacity: 5,
        attributes: [
          { name: "pk", type: "S" },
          { name: "gpk", type: "S" },
        ],
        globalSecondaryIndexes: [
          {
            name: "gsi1",
            hashKey: "gpk",
            projectionType: "ALL",
            readCapacity: 5,
            writeCapacity: 5,
            onDemandThroughput: { maxReadRequestUnits: 100 },
          },
        ],
      }),
    ).toContain(
      "globalSecondaryIndexes[0].onDemandThroughput is only valid when billingMode is PAY_PER_REQUEST",
    );
  });

  test("validates non-empty resourcePolicyJson as JSON", () => {
    expect(messagesFor({ ...baseConfig, resourcePolicyJson: "{not json" })).toContain(
      "resourcePolicyJson must be valid JSON",
    );

    expect(
      DynamoDbConfigSchema.safeParse({
        ...baseConfig,
        resourcePolicyJson: JSON.stringify({
          Version: "2012-10-17",
          Statement: [],
        }),
      }).success,
    ).toBe(true);
  });
});

describe("dynamo-db resource mapping", () => {
  test("maps STANDARD_IA config tableClass to the Pulumi AWS table value", () => {
    const parsed = DynamoDbConfigSchema.parse({
      ...baseConfig,
      tableClass: "STANDARD_IA",
    });
    const args = buildTableArgs(parsed, "derived-name");
    expect(args.tableClass).toBe("STANDARD_INFREQUENT_ACCESS");
  });

  test("uses configured table name when present and derived name when empty", () => {
    expect(
      buildTableArgs(DynamoDbConfigSchema.parse(baseConfig), "derived-name").name,
    ).toBe("derived-name");

    expect(
      buildTableArgs(
        DynamoDbConfigSchema.parse({ ...baseConfig, name: "explicit-name" }),
        "derived-name",
      ).name,
    ).toBe("explicit-name");
  });

  test("omits optional resource blocks when config leaves them unset", () => {
    const args = buildTableArgs(DynamoDbConfigSchema.parse(baseConfig), "table");
    expect(args.rangeKey).toBeUndefined();
    expect(args.ttl).toBeUndefined();
    expect(args.serverSideEncryption).toBeUndefined();
    expect(args.streamViewType).toBeUndefined();
  });
});

describe("dynamo-db connection metadata", () => {
  test("portable schemas expose the table connection and dynamo-table result schema", () => {
    const portable = component.getPortableSchemas();
    expect(portable.connection_types.table.interface_name).toBe("dynamo-table");
    expect(
      portable.connection_interfaces["dynamo-table"].result_schema,
    ).toBeDefined();
    expect(portable.schemas.output.properties).toHaveProperty("tableName");
    expect(portable.schemas.output.properties).toHaveProperty("tableArn");
    expect(portable.schemas.output.properties).toHaveProperty("tableId");
  });

  test("requireDynamoTableIdentity rejects missing identity fields with clear errors", () => {
    expect(() => requireDynamoTableIdentity({})).toThrow(
      "dynamo-db(aws): missing table identity in state; expected tableName, tableArn, and region",
    );
  });
});
