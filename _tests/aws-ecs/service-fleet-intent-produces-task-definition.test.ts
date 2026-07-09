import { expect, test } from "bun:test";

import { loadEcs } from "./load-ecs";

test("service-fleet-intent produces a task definition using the canonical service log group", async () => {
  const { taskTemplate } = await loadEcs();
  const service = {
    cpu: 256,
    memoryMb: 512,
    capacity: "on-demand",
    deployment: {
      posture: "rolling",
      circuitBreaker: { enabled: true, rollback: true },
      minimumHealthyPercent: 100,
      maximumPercent: 200,
    },
    logRetentionDays: 30,
    architecture: "x86_64",
    scaling: { min: 1, max: 1, targetCpuPercent: 70 },
    exposure: { mode: "none" },
    environment: {},
    secrets: {},
    volumes: [],
    health: { path: "/", gracePeriodSeconds: 0 },
    ephemeralStorageGb: 20,
    enableExecuteCommand: false,
    taskPolicyStatements: [],
  } as Parameters<typeof taskTemplate>[2];

  const template = taskTemplate(
    "task-api",
    "svc-api",
    service,
    "execution-role-arn",
    "task-role-arn",
    "us-east-1",
    "image-uri",
  );
  const applicationContainer = template.containerDefinitions?.find(
    (container) => container.name === "app",
  );

  expect(template.family).toBe("task-api");
  expect(
    applicationContainer?.logConfiguration?.options?.["awslogs-group"],
  ).toBe("/aws/ecs/svc-api");
});
