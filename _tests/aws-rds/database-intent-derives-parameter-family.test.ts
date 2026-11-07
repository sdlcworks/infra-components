import { expect, test } from "bun:test";

import { loadRds } from "./load-aws-rds";

test("database-intent derives a postgres parameter family from the major version alone", async () => {
  const { parameterGroupFamily } = await loadRds();

  expect(parameterGroupFamily("postgres", "16")).toBe("postgres16");
  expect(parameterGroupFamily("postgres", "15.6")).toBe("postgres15");
});

test("database-intent derives a mysql parameter family from major and minor", async () => {
  const { parameterGroupFamily } = await loadRds();

  expect(parameterGroupFamily("mysql", "8.0")).toBe("mysql8.0");
  expect(parameterGroupFamily("mysql", "8.0.35")).toBe("mysql8.0");
});

test("database-intent refuses a mysql version that names no minor", async () => {
  const { parameterGroupFamily } = await loadRds();

  expect(() => parameterGroupFamily("mysql", "8")).toThrow(
    "must name a major and a minor version",
  );
});

test("database-intent refuses an engine change that would replace the store", async () => {
  const { assertEngineFingerprint, engineFingerprint } = await loadRds();
  const postgres = engineFingerprint({ engine: "postgres" } as any);
  const mysql = engineFingerprint({ engine: "mysql" } as any);

  expect(assertEngineFingerprint("primary", undefined, postgres)).toBe(postgres);
  expect(assertEngineFingerprint("primary", postgres, postgres)).toBe(postgres);
  expect(() => assertEngineFingerprint("primary", postgres, mysql)).toThrow(
    'aws-rds: engine change refused for instance "primary".',
  );
});

test("database-intent sanitizes provider identifiers and keeps them within the length limit", async () => {
  const { rdsIdentifier } = await loadRds();

  expect(rdsIdentifier("Store_DB-Primary")).toBe("store-db-primary");
  expect(rdsIdentifier("9lives")).toBe("db-9lives");
  expect(rdsIdentifier("---")).toBe("db");

  const long = rdsIdentifier("a".repeat(120));
  expect(long.length).toBe(63);
  expect(rdsIdentifier("a".repeat(120))).toBe(long);
});
