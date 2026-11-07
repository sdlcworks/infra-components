import { expect, test } from "bun:test";

import { getComponentDefinition, loadEcs } from "./load-ecs";

test("service-fleet declares consumer-side connection types for every database dialect", async () => {
  await loadEcs();
  const definition = getComponentDefinition() as any;

  expect(Object.keys(definition.connectionTypes).sort()).toEqual([
    "internal",
    "mongodb",
    "mysql",
    "postgres",
    "public",
  ]);

  for (const connectionType of ["postgres", "mysql", "mongodb"]) {
    expect(definition.connectionTypes[connectionType].description).toStartWith(
      "consumer-side:",
    );
    expect(definition.connectionTypes[connectionType].interface).toBeDefined();
  }

  expect(definition.connectionInterfaces).toHaveLength(2);
});
