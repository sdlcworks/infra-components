import { expect, test } from "bun:test";

import { loadEcs } from "./load-ecs";

test("target-attachment-point rejects a non-ip target group", async () => {
  const { assertExternalTargetGroupTargetType } = await loadEcs();
  expect(() => assertExternalTargetGroupTargetType("api", "instance")).toThrow(
    'external-attachment target group must use targetType "ip"',
  );
  expect(() =>
    assertExternalTargetGroupTargetType("api", "ip"),
  ).not.toThrow();
});

test("target-attachment-point produces workload-target-identity with target, health, and drain meaning", async () => {
  const { workloadTarget } = await loadEcs();
  expect(
    workloadTarget({
      port: 8080,
      health: { path: "/ready", gracePeriodSeconds: 45 },
    }),
  ).toEqual({
    targetType: "ip",
    port: 8080,
    protocol: "HTTP",
    health: { protocol: "HTTP", path: "/ready", gracePeriodSeconds: 45 },
    deregistrationDelaySeconds: 300,
  });
});
