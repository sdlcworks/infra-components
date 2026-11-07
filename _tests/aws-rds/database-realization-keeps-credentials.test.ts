import { beforeEach, expect, test } from "bun:test";

import {
  captured,
  getProviderFns,
  loadRds,
  pulumiCtx,
  resetCaptured,
} from "./load-aws-rds";

function config(instances: Record<string, unknown> = { primary: {} }) {
  return {
    vpcId: "vpc-1",
    subnetIds: ["subnet-a", "subnet-b"],
    access: { cidrs: ["10.0.0.0/16"], securityGroupIds: ["sg-app"] },
    labels: { owner: "platform" },
    instances,
  };
}

function freshState() {
  return { engineFingerprints: {}, instances: {}, allocations: {} } as any;
}

async function realize(
  instances: Record<string, unknown> = { primary: {} },
  state = freshState(),
) {
  const { ConfigSchema } = await loadRds();
  const fns = await getProviderFns();
  await fns.pulumi(pulumiCtx(ConfigSchema.parse(config(instances)), state));
  return state;
}

beforeEach(() => {
  resetCaptured();
});

test("database-realization generates the master password once and reuses it from state", async () => {
  const { ConfigSchema } = await loadRds();
  const fns = await getProviderFns();
  const inputs = ConfigSchema.parse(config());
  const state = freshState();

  await fns.pulumi(pulumiCtx(inputs, state));
  const password = state.instances.primary.password;

  expect(typeof password).toBe("string");
  expect(password.length).toBeGreaterThan(0);
  expect(password.length).toBeLessThanOrEqual(41);

  await fns.pulumi(pulumiCtx(inputs, state));

  expect(state.instances.primary.password).toBe(password);
  expect(captured.instances.map((resource) => resource.args.password)).toEqual([
    password,
    password,
  ]);
});

test("database-realization refuses a declared engine change against stored state", async () => {
  const { ConfigSchema } = await loadRds();
  const fns = await getProviderFns();
  const state = freshState();

  await fns.pulumi(pulumiCtx(ConfigSchema.parse(config()), state));

  const changed = ConfigSchema.parse(config({ primary: { engine: "mysql" } }));
  await expect(fns.pulumi(pulumiCtx(changed, state))).rejects.toThrow(
    'aws-rds: engine change refused for instance "primary".',
  );
});

test("database-realization places one subnet group and one closed security group", async () => {
  await realize();

  expect(captured.subnetGroups).toHaveLength(1);
  expect(captured.subnetGroups[0].args.subnetIds).toEqual([
    "subnet-a",
    "subnet-b",
  ]);

  expect(captured.securityGroups).toHaveLength(1);
  const securityGroup = captured.securityGroups[0].args;
  expect(securityGroup.vpcId).toBe("vpc-1");
  expect(securityGroup.egress).toEqual([]);
  expect(securityGroup.ingress).toEqual([
    {
      protocol: "tcp",
      fromPort: 5432,
      toPort: 5432,
      cidrBlocks: ["10.0.0.0/16"],
    },
    {
      protocol: "tcp",
      fromPort: 5432,
      toPort: 5432,
      securityGroups: ["sg-app"],
    },
  ]);
  expect(securityGroup.tags.owner).toBe("platform");
});

test("database-realization encrypts storage and keeps a deterministic final snapshot", async () => {
  const state = await realize();
  const instance = captured.instances[0].args;

  expect(instance.storageEncrypted).toBe(true);
  expect(instance.deletionProtection).toBe(true);
  expect(instance.skipFinalSnapshot).toBe(false);
  expect(instance.finalSnapshotIdentifier).toBe(
    `${state.instances.primary.identifier}-final`,
  );
  expect(instance.port).toBe(5432);
  expect(instance.copyTagsToSnapshot).toBe(true);
  expect(instance.tags.Name).toBe(state.instances.primary.identifier);
});

test("database-realization skips the final snapshot only when it is declined", async () => {
  await realize({ primary: { finalSnapshot: false } });
  const instance = captured.instances[0].args;

  expect(instance.skipFinalSnapshot).toBe(true);
  expect(instance.finalSnapshotIdentifier).toBeUndefined();
});

test("database-realization creates a parameter group only for declared parameters", async () => {
  await realize();
  expect(captured.parameterGroups).toHaveLength(0);

  resetCaptured();
  await realize({
    primary: {
      engine: "mysql",
      engineVersion: "8.0.35",
      parameters: { max_connections: "200" },
    },
  });

  expect(captured.parameterGroups).toHaveLength(1);
  expect(captured.parameterGroups[0].args.family).toBe("mysql8.0");
  expect(captured.parameterGroups[0].args.parameters).toEqual([
    { name: "max_connections", value: "200", applyMethod: "pending-reboot" },
  ]);
  expect(captured.instances[0].args.parameterGroupName).toBe(
    captured.parameterGroups[0].args.name,
  );
});

test("database-realization anchors each read replica on the primary and its security group", async () => {
  const state = await realize({
    primary: { readReplicas: { reports: { instanceClass: "db.t4g.small" } } },
  });

  expect(captured.instances).toHaveLength(2);
  const replica = captured.instances[1].args;
  expect(replica.replicateSourceDb).toBe(state.instances.primary.identifier);
  expect(replica.instanceClass).toBe("db.t4g.small");
  expect(replica.vpcSecurityGroupIds).toEqual(["sg-test"]);
  expect(replica.storageEncrypted).toBe(true);
  expect(replica.skipFinalSnapshot).toBe(true);
  expect(Object.keys(state.instances.primary.replicaEndpoints)).toEqual([
    "reports",
  ]);
});

test("database-realization publishes the credential to a secret when enabled", async () => {
  const state = await realize();

  expect(captured.secrets).toHaveLength(1);
  expect(captured.secrets[0].args.recoveryWindowInDays).toBe(7);
  expect(typeof state.instances.primary.secretArn).toBe("string");

  const payload = JSON.parse(captured.secretVersions[0].args.secretString);
  expect(payload).toMatchObject({
    engine: "postgres",
    host: `${state.instances.primary.identifier}.rds.test`,
    port: 5432,
    dbname: "app",
    username: "sdlc_admin",
    password: state.instances.primary.password,
  });
  expect(payload.uri).toContain("postgresql://sdlc_admin:");
  expect(payload.uri).toContain("?sslmode=require");
});

test("database-realization publishes no secret when the instance declines one", async () => {
  const state = await realize({ primary: { secret: { enabled: false } } });

  expect(captured.secrets).toHaveLength(0);
  expect(captured.secretVersions).toHaveLength(0);
  expect(state.instances.primary.secretArn).toBeUndefined();
});
