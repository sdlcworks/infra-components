import { expect, test } from "bun:test";

import {
  getComponentDefinition,
  getImplementationRegistration,
  loadEcs,
} from "./load-ecs";

type Schema = {
  safeParse(value: unknown): {
    success: boolean;
    data?: unknown;
  };
};

const target = {
  targetType: "ip",
  port: 8080,
  protocol: "HTTP",
  health: {
    protocol: "HTTP",
    path: "/ready",
    gracePeriodSeconds: 45,
  },
  deregistrationDelaySeconds: 300,
};

test("workload-target-identity is required by the registered component output", async () => {
  await loadEcs();
  const definition = getComponentDefinition() as { outputSchema: Schema };
  const output = {
    region: "us-east-1",
    clusterArn: "arn:aws:ecs:us-east-1:123456789012:cluster/fleet",
    serviceNames: {},
    serviceArns: {},
    taskRoleArns: {},
    publicEndpoints: {},
    ownedAlbDnsNames: {},
    ownedAlbZoneIds: {},
    internalEndpoints: {},
    workloadTargets: { api: target },
    namespaceArn:
      "arn:aws:servicediscovery:us-east-1:123456789012:namespace/ns-123",
  };

  expect(definition.outputSchema.safeParse(output).success).toBe(true);
  const { workloadTargets: _workloadTargets, ...withoutWorkloadTargets } = output;
  expect(
    definition.outputSchema.safeParse(withoutWorkloadTargets).success,
  ).toBe(false);
});

test("service-fleet-intent registers external discovery and workload target state", async () => {
  await loadEcs();
  const registration = getImplementationRegistration();
  expect(registration).toBeDefined();
  const [provider, implementation] = registration as [
    string,
    { stateSchema: Schema; initialState: Record<string, unknown> },
  ];

  expect(provider).toBe("aws");
  expect(
    implementation.stateSchema.safeParse({
      discoveryNamespace: {
        name: "apps.internal",
        arn: "arn:aws:servicediscovery:us-east-1:123456789012:namespace/ns-123",
      },
      workloadTargets: { api: target },
    }).success,
  ).toBe(true);
  expect(
    implementation.stateSchema.safeParse({
      discoveryNamespace: "apps.internal",
      workloadTargets: {},
    }).success,
  ).toBe(false);
  expect(
    implementation.stateSchema.safeParse({}).data,
  ).toMatchObject({ workloadTargets: {} });
  expect(implementation.initialState).toMatchObject({ workloadTargets: {} });
});
