import { beforeEach, expect, test } from "bun:test";

import { captured, loadCloudSql, naming, reset } from "./load-cloud-sql";

beforeEach(reset);

const provision = async (instances: Record<string, unknown>, state: Record<string, any> = {}) => {
  const { module, implementation } = await loadCloudSql();
  const inputs = module.ConfigSchema.parse({ instances });
  const result = await implementation.pulumi({ $: naming, inputs, state, gcp: undefined });
  return { state, result };
};

test("a declared instance defaults to connector-only access with protection and backups on", async () => {
  const { module } = await loadCloudSql();
  const spec = module.InstanceSchema.parse({});
  expect(spec.network).toEqual({ mode: "connector" });
  expect(spec.deletionProtection).toBe(true);
  expect(spec.backups).toEqual({ enabled: true, pointInTimeRecovery: true, retainedBackups: 7, transactionLogRetentionDays: 7 });
  expect(spec.storage).toEqual({ sizeGb: 10, type: "PD_SSD", autoResize: true, autoResizeLimitGb: 0 });

  await provision({ main: {} });
  const instance = captured.find((c) => c.kind === "DatabaseInstance")!;
  expect(instance.args.deletionProtection).toBe(true);
  expect(instance.args.settings.connectorEnforcement).toBe("REQUIRED");
  expect(instance.args.settings.ipConfiguration).toEqual({ ipv4Enabled: true, authorizedNetworks: [], sslMode: "ENCRYPTED_ONLY" });
  expect(instance.args.settings.deletionProtectionEnabled).toBe(true);
  expect(instance.args.settings.backupConfiguration.backupRetentionSettings).toEqual({ retainedBackups: 7, retentionUnit: "COUNT" });
});

test("the whole internet is refused as an authorized network", async () => {
  const { module } = await loadCloudSql();
  const parsed = module.InstanceSchema.safeParse({
    network: { mode: "authorized-networks", cidrs: [{ name: "all", cidr: "0.0.0.0/0" }] },
  });
  expect(parsed.success).toBe(false);
  expect(JSON.stringify(parsed.error?.issues)).toContain("whole internet");
});

test("enterprise plus refuses tiers it cannot run", async () => {
  const { module } = await loadCloudSql();
  expect(module.InstanceSchema.safeParse({ edition: "ENTERPRISE_PLUS" }).success).toBe(false);
  expect(module.InstanceSchema.safeParse({ edition: "ENTERPRISE_PLUS", tier: "db-perf-optimized-N-2" }).success).toBe(true);
});

test("private instances share one peering per network and drop public addresses", async () => {
  await provision({
    a: { network: { mode: "private", network: "projects/p/global/networks/vpc" } },
    b: { network: { mode: "private", network: "projects/p/global/networks/vpc" } },
  });
  expect(captured.filter((c) => c.kind === "Connection")).toHaveLength(1);
  const instances = captured.filter((c) => c.kind === "DatabaseInstance");
  for (const instance of instances) {
    expect(instance.args.settings.ipConfiguration.ipv4Enabled).toBe(false);
    expect(instance.args.settings.ipConfiguration.allocatedIpRange).toBe("sql-peering-range-0-range");
    expect(instance.args.settings.connectorEnforcement).toBe("NOT_REQUIRED");
    expect(instance.opts?.dependsOn).toHaveLength(1);
  }
});

test("read replicas follow their primary without their own backups", async () => {
  const { state } = await provision({ main: { tier: "db-custom-2-7680", readReplicas: { eu: { region: "europe-west1" } } } });
  const replica = captured.find((c) => c.name === "replica-main-eu")!;
  expect(replica.args.masterInstanceName).toBe("instance-main-name");
  expect(replica.args.region).toBe("europe-west1");
  expect(replica.args.settings.tier).toBe("db-custom-2-7680");
  expect(replica.args.settings.backupConfiguration).toEqual({ enabled: false });
  expect(state.sqlInstances.main.replicas.eu.connectionName).toBe("proj:region:replica-main-eu-name");
});

test("mysql instances use binary logging for point-in-time recovery", async () => {
  await provision({ main: { version: "MYSQL_8_0" } });
  const instance = captured.find((c) => c.kind === "DatabaseInstance")!;
  expect(instance.args.settings.backupConfiguration.binaryLogEnabled).toBe(true);
  expect(instance.args.settings.backupConfiguration.pointInTimeRecoveryEnabled).toBeUndefined();
});

test("changing engine is refused because it would replace the database", async () => {
  const state = { sqlInstances: { main: { engine: "postgres" } } };
  await expect(provision({ main: { version: "MYSQL_8_0" } }, state)).rejects.toThrow("would replace the database");
});

test("replicas relax connector enforcement and growing disks are not shrunk back", async () => {
  await provision({ main: { readReplicas: { r: {} } } });
  const primary = captured.find((c) => c.name === "instance-main")!;
  expect(primary.args.settings.connectorEnforcement).toBe("NOT_REQUIRED");
  expect(primary.args.settings.ipConfiguration.authorizedNetworks).toEqual([]);
  expect(primary.opts?.ignoreChanges).toEqual(["settings.diskSize"]);
});
