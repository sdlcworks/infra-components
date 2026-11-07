import { expect, test } from "bun:test";

import { loadRds } from "./load-aws-rds";

function config(overrides: Record<string, unknown> = {}) {
  return {
    vpcId: "vpc-1",
    subnetIds: ["subnet-a", "subnet-b"],
    access: { securityGroupIds: ["sg-app"] },
    instances: { primary: {} },
    ...overrides,
  };
}

test("database-intent fills every reviewed durability default", async () => {
  const { ConfigSchema } = await loadRds();
  const parsed = ConfigSchema.parse(config());

  expect(parsed.labels).toEqual({});
  expect(parsed.access).toEqual({ cidrs: [], securityGroupIds: ["sg-app"] });
  expect(parsed.instances.primary).toEqual({
    engine: "postgres",
    instanceClass: "db.t4g.micro",
    storage: { allocatedGb: 20, type: "gp3" },
    multiAz: false,
    publiclyAccessible: false,
    databaseName: "app",
    masterUsername: "sdlc_admin",
    backup: { retentionDays: 7, copyTagsToSnapshot: true },
    autoMinorVersionUpgrade: true,
    allowMajorVersionUpgrade: false,
    applyImmediately: false,
    deletionProtection: true,
    finalSnapshot: true,
    performanceInsights: { enabled: false },
    iamAuthentication: false,
    logExports: [],
    parameters: {},
    readReplicas: {},
    secret: { enabled: true, recoveryWindowDays: 7 },
  });
});

test("database-intent resolves the engine version default per engine", async () => {
  const { engineVersionFor } = await loadRds();

  expect(engineVersionFor("postgres")).toBe("16");
  expect(engineVersionFor("mysql")).toBe("8.0");
  expect(engineVersionFor("postgres", "15.6")).toBe("15.6");
});

test("database-intent requires two subnets so the subnet group spans two zones", async () => {
  const { ConfigSchema } = await loadRds();

  expect(ConfigSchema.safeParse(config({ subnetIds: ["subnet-a"] })).success).toBe(
    false,
  );
  expect(ConfigSchema.safeParse(config()).success).toBe(true);
});

test("database-intent requires at least one declared instance", async () => {
  const { ConfigSchema } = await loadRds();
  const result = ConfigSchema.safeParse(config({ instances: {} }));

  expect(result.success).toBe(false);
  if (!result.success) {
    expect(result.error.issues.map((issue) => issue.message)).toContain(
      "aws-rds: instances must declare at least one database instance.",
    );
  }
});

test("database-intent rejects undeclared instance fields", async () => {
  const { ConfigSchema } = await loadRds();

  expect(
    ConfigSchema.safeParse(config({ instances: { primary: { engineMajor: 16 } } }))
      .success,
  ).toBe(false);
});

test("database-intent requires storage autoscaling room to exceed the allocation", async () => {
  const { ConfigSchema } = await loadRds();
  const result = ConfigSchema.safeParse(
    config({
      instances: { primary: { storage: { allocatedGb: 50, maxAllocatedGb: 50 } } },
    }),
  );

  expect(result.success).toBe(false);
  if (!result.success) {
    expect(result.error.issues.map((issue) => issue.message)).toContain(
      'aws-rds: instance "primary" storage.maxAllocatedGb must exceed storage.allocatedGb for storage autoscaling to have room to grow.',
    );
  }

  expect(
    ConfigSchema.safeParse(
      config({
        instances: {
          primary: { storage: { allocatedGb: 50, maxAllocatedGb: 100 } },
        },
      }),
    ).success,
  ).toBe(true);
});

test("database-intent refuses secret recovery windows the provider rejects", async () => {
  const { ConfigSchema } = await loadRds();
  const withWindow = (recoveryWindowDays: number) =>
    ConfigSchema.safeParse(config({ instances: { primary: { secret: { recoveryWindowDays } } } })).success;
  expect(withWindow(0)).toBe(true);
  expect(withWindow(3)).toBe(false);
  expect(withWindow(7)).toBe(true);
  expect(withWindow(30)).toBe(true);
});
