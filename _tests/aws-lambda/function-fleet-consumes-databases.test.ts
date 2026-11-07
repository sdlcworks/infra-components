import { beforeEach, expect, test } from "bun:test";

import {
  MongoCI,
  MysqlCI,
  PostgresCI,
  PublicCI,
  captured,
  getComponentDefinition,
  getProviderFns,
  loadLambda,
  pulumiCtx,
  resetCaptured,
} from "./load-aws-lambda";

function config(vpcConfig?: Record<string, unknown>) {
  return {
    functions: {
      api: {
        packaging: "zip",
        memoryMb: 512,
        handler: "index.handler",
        runtime: "nodejs20.x",
        timeoutSeconds: 30,
        logRetentionDays: 30,
        architecture: "x86_64",
        ephemeralStorageMb: 512,
        environment: {},
      },
    },
    policyStatements: [],
    labels: { owner: "platform" },
    ...(vpcConfig === undefined ? {} : { vpcConfig }),
  };
}

function freshState() {
  return {
    packagingFingerprints: {},
    functionPackagings: {},
    functionNames: {},
    functionArns: {},
    functionUrls: {},
    functionUrlHosts: {},
    imageRepositoryUrls: {},
    allocations: {},
    deployedArtifacts: {},
  } as any;
}

async function realize(vpcConfig?: Record<string, unknown>) {
  const fns = await getProviderFns();
  return fns.pulumi(pulumiCtx(config(vpcConfig), freshState()));
}

beforeEach(() => {
  resetCaptured();
});

test("function-fleet declares consumer-side connection types for every database dialect", async () => {
  const definition = await getComponentDefinition();

  expect(definition.connectionTypes.postgres.interface).toBe(PostgresCI);
  expect(definition.connectionTypes.mysql.interface).toBe(MysqlCI);
  expect(definition.connectionTypes.mongodb.interface).toBe(MongoCI);
  expect(definition.connectionTypes.postgres.description).toStartWith(
    "consumer-side:",
  );
  expect(definition.connectionInterfaces).toEqual([PublicCI]);
});

test("function-fleet recognizes declared security groups", async () => {
  const { declaresOwnSecurityGroups } = await loadLambda();

  expect(declaresOwnSecurityGroups(undefined)).toBe(false);
  expect(declaresOwnSecurityGroups({})).toBe(false);
  expect(declaresOwnSecurityGroups({ securityGroupIds: [] })).toBe(false);
  expect(declaresOwnSecurityGroups({ securityGroupIds: ["sg-given"] })).toBe(true);
});

test("function-fleet creates no security group without VPC placement", async () => {
  const outputs = await realize();

  expect(captured.securityGroups).toHaveLength(0);
  expect(captured.functions[0].args.vpcConfig).toBeUndefined();
  expect(outputs.securityGroupId.apply((value: unknown) => value)).toBeUndefined();
});

test("function-fleet owns one egress-only security group when none is declared", async () => {
  const outputs = await realize({ subnetIds: ["subnet-a", "subnet-b"] });

  expect(captured.subnetLookups).toEqual([{ id: "subnet-a" }]);
  expect(captured.securityGroups).toHaveLength(1);

  const securityGroup = captured.securityGroups[0].args;
  expect(securityGroup.vpcId).toBe("vpc-derived");
  expect(securityGroup.ingress).toEqual([]);
  expect(securityGroup.egress).toEqual([
    {
      protocol: "-1",
      fromPort: 0,
      toPort: 0,
      cidrBlocks: ["0.0.0.0/0"],
      ipv6CidrBlocks: ["::/0"],
    },
  ]);
  expect(securityGroup.tags.owner).toBe("platform");

  expect(captured.functions[0].args.vpcConfig).toEqual({
    subnetIds: ["subnet-a", "subnet-b"],
    securityGroupIds: ["sg-managed"],
  });
  expect(outputs.securityGroupId.apply((value: unknown) => value)).toBe(
    "sg-managed",
  );
});

test("function-fleet keeps declared security groups and owns none", async () => {
  const outputs = await realize({
    subnetIds: ["subnet-a"],
    securityGroupIds: ["sg-given"],
  });

  expect(captured.securityGroups).toHaveLength(0);
  expect(captured.subnetLookups).toEqual([]);
  expect(captured.functions[0].args.vpcConfig).toEqual({
    subnetIds: ["subnet-a"],
    securityGroupIds: ["sg-given"],
  });
  expect(outputs.securityGroupId.apply((value: unknown) => value)).toBeUndefined();
});
