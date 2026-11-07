import { beforeEach, expect, test } from "bun:test";

import { captured, loadCloudSql, naming, reset } from "./load-cloud-sql";

beforeEach(reset);

const instance = (overrides: Record<string, unknown> = {}) => ({
  engine: "postgres",
  networkMode: "connector",
  instanceName: "main-name",
  connectionName: "proj:us-central1:main-name",
  publicIp: "34.1.1.1",
  privateIp: "10.0.0.5",
  replicas: {},
  ...overrides,
});

test("an application gets its own database, user and generated password, kept across runs", async () => {
  const { implementation } = await loadCloudSql();
  const state: Record<string, any> = { sqlInstances: { main: instance() } };
  await implementation.allocateWithPulumiCtx({ name: "api-server", deploymentConfig: { instance: "main" }, state, $: naming });
  const first = state.allocations["api-server"];
  expect(first.dbName).toBe("api_server");
  expect(first.dbUser).toBe("api_server");
  expect(first.password.length).toBeGreaterThanOrEqual(32);
  expect(captured.find((c) => c.kind === "User")!.args.deletionPolicy).toBe("ABANDON");
  expect(captured.find((c) => c.kind === "Database")!.args.deletionPolicy).toBe("ABANDON");

  await implementation.allocateWithPulumiCtx({ name: "api-server", deploymentConfig: { instance: "main" }, state, $: naming });
  expect(state.allocations["api-server"].password).toBe(first.password);
});

test("an unknown instance is refused with the declared names", async () => {
  const { implementation } = await loadCloudSql();
  const state = { sqlInstances: { main: instance() } };
  await expect(
    implementation.allocateWithPulumiCtx({ name: "api", deploymentConfig: { instance: "other" }, state, $: naming }),
  ).rejects.toThrow("declared instances: main");
});

test("connection strings follow the network mode", async () => {
  const { module } = await loadCloudSql();
  const allocation = { instanceKey: "main", dbName: "app", dbUser: "app", password: "p@ss" };
  const connector = module.connectionResult(instance() as any, allocation);
  expect(connector.uri).toBe("postgresql://app:p%40ss@localhost/app?host=/cloudsql/proj:us-central1:main-name");
  expect(connector.socketPath).toBe("/cloudsql/proj:us-central1:main-name");

  const privateResult = module.connectionResult(instance({ networkMode: "private" }) as any, allocation);
  expect(privateResult.uri).toBe("postgresql://app:p%40ss@10.0.0.5:5432/app?sslmode=require");

  const mysql = module.connectionResult(instance({ engine: "mysql", networkMode: "authorized-networks" }) as any, allocation);
  expect(mysql.uri).toBe("mysql://app:p%40ss@34.1.1.1:3306/app?ssl-mode=REQUIRED");
});

test("the first replica supplies a read connection", async () => {
  const { module } = await loadCloudSql();
  const allocation = { instanceKey: "main", dbName: "app", dbUser: "app", password: "pw" };
  const result = module.connectionResult(
    instance({
      networkMode: "private",
      replicas: { b: { instanceName: "b", connectionName: "c:b", privateIp: "10.0.0.7" }, a: { instanceName: "a", connectionName: "c:a", privateIp: "10.0.0.6" } },
    }) as any,
    allocation,
  );
  expect(result.readUri).toBe("postgresql://app:pw@10.0.0.6:5432/app?sslmode=require");
});

test("connecting with the wrong engine is refused", async () => {
  const { implementation } = await loadCloudSql();
  const state = {
    sqlInstances: { main: instance() },
    allocations: { api: { instanceKey: "main", dbName: "app", dbUser: "app", password: "pw" } },
  };
  const [, mysqlHandler] = implementation.connect({ state, selfComponentName: "api" });
  await expect(mysqlHandler.handler()).rejects.toThrow("connects as mysql");
});

test("two applications resolving to the same database name are refused", async () => {
  const { implementation } = await loadCloudSql();
  const state: Record<string, any> = { sqlInstances: { main: instance() } };
  await implementation.allocateWithPulumiCtx({ name: "api-server", deploymentConfig: { instance: "main" }, state, $: naming });
  await expect(
    implementation.allocateWithPulumiCtx({ name: "api_server", deploymentConfig: { instance: "main" }, state, $: naming }),
  ).rejects.toThrow("set dbName and dbUser explicitly");
});
