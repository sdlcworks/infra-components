import { expect, test } from "bun:test";

import {
  MysqlCI,
  PostgresCI,
  getComponentDefinition,
  getProviderFns,
  loadRds,
  namingTag,
} from "./load-aws-rds";

function state(overrides: Record<string, any> = {}) {
  return {
    instances: {
      primary: {
        identifier: "store-db-primary",
        host: "store-db-primary.rds.test",
        port: 5432,
        engine: "postgres",
        databaseName: "app",
        masterUsername: "sdlc_admin",
        password: "p@ss/word",
        secretArn: "arn:aws:secretsmanager:eu-west-1:0:secret:store",
        replicaEndpoints: {},
      },
    },
    allocations: { api: { instanceKey: "primary" } },
    ...overrides,
  } as any;
}

async function handlerFor(interfaceDef: unknown, ctxState: any, self: string) {
  const fns = await getProviderFns();
  const entries = fns.connect({ state: ctxState, selfComponentName: self });
  const entry = entries.find((candidate: any) => candidate.interface === interfaceDef);
  if (!entry) {
    throw new Error("no handler registered for the requested interface");
  }

  return () => entry.handler({ $: namingTag, connectionData: {}, connectionType: "x" });
}

test("database-access declares one connection type per supported dialect", async () => {
  const definition = await getComponentDefinition();

  expect(Object.keys(definition.connectionTypes).sort()).toEqual([
    "mysql",
    "postgres",
  ]);
  expect(definition.connectionTypes.postgres.interface).toBe(PostgresCI);
  expect(definition.connectionTypes.mysql.interface).toBe(MysqlCI);
  expect(definition.metadata).toEqual({ stateful: true, proxiable: false });
  expect(Object.keys(definition.appComponentTypes)).toEqual(["database"]);
});

test("database-access produces a credentialed postgres URI with required TLS", async () => {
  const handler = await handlerFor(PostgresCI, state(), "api");
  const result = await handler();

  expect(result.uri).toBe(
    "postgresql://sdlc_admin:p%40ss%2Fword@store-db-primary.rds.test:5432/app?sslmode=require",
  );
  expect(result.metadata).toMatchObject({
    uri: result.uri,
    host: "store-db-primary.rds.test",
    port: 5432,
    database: "app",
    user: "sdlc_admin",
    password: "p@ss/word",
    secretArn: "arn:aws:secretsmanager:eu-west-1:0:secret:store",
  });
  expect(result.metadata.readUri).toBeUndefined();
});

test("database-access produces a mysql URI with required TLS", async () => {
  const { sqlUri } = await loadRds();

  expect(
    sqlUri("mysql", {
      host: "legacy.rds.test",
      port: 3306,
      database: "app",
      user: "sdlc_admin",
      password: "secret",
    }),
  ).toBe("mysql://sdlc_admin:secret@legacy.rds.test:3306/app?ssl-mode=REQUIRED");
});

test("database-access refuses a dialect the allocated instance does not run", async () => {
  const handler = await handlerFor(MysqlCI, state(), "api");

  await expect(handler()).rejects.toThrow(
    'aws-rds: app component "api" is allocated to instance "primary" running engine "postgres" and cannot serve a "mysql" connection.',
  );
});

test("database-access refuses a connection for an unallocated app component", async () => {
  const handler = await handlerFor(PostgresCI, state(), "worker");

  await expect(handler()).rejects.toThrow(
    'aws-rds: no allocation found for "worker"',
  );
});

test("database-access routes reads to the first replica by sorted key", async () => {
  const { firstReplicaKey } = await loadRds();
  expect(firstReplicaKey({ zulu: "z", alpha: "a" })).toBe("alpha");
  expect(firstReplicaKey({})).toBeUndefined();

  const withReplicas = state();
  withReplicas.instances.primary.replicaEndpoints = {
    zulu: "zulu.rds.test",
    alpha: "alpha.rds.test",
  };

  const handler = await handlerFor(PostgresCI, withReplicas, "api");
  const result = await handler();

  expect(result.metadata.readUri).toBe(
    "postgresql://sdlc_admin:p%40ss%2Fword@alpha.rds.test:5432/app?sslmode=require",
  );
});

test("database-access records the allocated instance and names the declared ones on refusal", async () => {
  const fns = await getProviderFns();
  const allocationState = state({ allocations: {} });

  await fns.allocateWithPulumiCtx({
    name: "api",
    appComponentType: "database",
    deploymentConfig: { instance: "primary" },
    state: allocationState,
    $: namingTag,
  });

  expect(allocationState.allocations.api).toEqual({ instanceKey: "primary" });

  await expect(
    fns.allocateWithPulumiCtx({
      name: "api",
      appComponentType: "database",
      deploymentConfig: { instance: "reporting" },
      state: allocationState,
      $: namingTag,
    }),
  ).rejects.toThrow(
    'aws-rds: app component "api" requested unknown instance "reporting"; declared instances are "primary".',
  );
});
