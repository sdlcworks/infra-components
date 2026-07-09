import { expect, test } from "bun:test";

import { loadEcs } from "./load-ecs";

function config(overrides: Record<string, unknown> = {}) {
  return {
    vpcId: "vpc-123",
    privateSubnetIds: ["subnet-private"],
    publicSubnetIds: ["subnet-public-a", "subnet-public-b"],
    discoveryNamespace: {
      name: "apps.internal",
      arn: "arn:aws:servicediscovery:us-east-1:123456789012:namespace/ns-123",
    },
    observability: { containerInsights: "enabled" },
    defaults: {
      cpu: 256,
      memoryMb: 512,
      capacity: "on-demand",
      deployment: { posture: "rolling" },
    },
    services: {
      api: {
        scaling: { min: 1, max: 1 },
        exposure: { mode: "none" },
      },
    },
    ...overrides,
  };
}

test("service-fleet-intent accepts only a strict external discovery namespace identity", async () => {
  const { ConfigSchema } = await loadEcs();
  expect(ConfigSchema.safeParse(config()).success).toBe(true);
  expect(
    ConfigSchema.safeParse(config({ discoveryNamespace: "apps.internal" })).success,
  ).toBe(false);
  expect(
    ConfigSchema.safeParse(
      config({
        discoveryNamespace: {
          name: "apps.internal",
          arn: "arn:aws:servicediscovery:us-east-1:123456789012:namespace/ns-123",
          extra: true,
        },
      }),
    ).success,
  ).toBe(false);
});

test("service-fleet-intent produces one internal endpoint meaning for alias and output", async () => {
  const { internalEndpoint } = await loadEcs();
  expect(internalEndpoint("api", "apps.internal", 8080)).toEqual({
    dnsName: "api.apps.internal",
    port: 8080,
    uri: "api.apps.internal:8080",
  });
});

test("service-fleet-intent requires public names whenever a certificate is supplied", async () => {
  const { ConfigSchema } = await loadEcs();
  const result = ConfigSchema.safeParse(
    config({
      services: {
        api: {
          scaling: { min: 1, max: 1 },
          deployment: { posture: "blue-green" },
          exposure: {
            mode: "owned-alb",
            allowedIngressCidrs: ["0.0.0.0/0"],
            publicNames: [],
            certificateArn: "arn:aws:acm:us-east-1:123456789012:certificate/cert-123",
          },
          port: 8080,
        },
      },
    }),
  );

  expect(result.success).toBe(false);
  if (!result.success) {
    expect(result.error.issues.map((issue) => issue.message)).toContain(
      'aws-ecs: service "api" certificateArn requires at least one publicName.',
    );
  }
});

test("service-fleet-intent rejects an empty public name", async () => {
  const { ConfigSchema } = await loadEcs();
  const result = ConfigSchema.safeParse(
    config({
      services: {
        api: {
          scaling: { min: 1, max: 1 },
          deployment: { posture: "blue-green" },
          exposure: {
            mode: "owned-alb",
            allowedIngressCidrs: ["0.0.0.0/0"],
            publicNames: [""],
            certificateArn: "arn:aws:acm:us-east-1:123456789012:certificate/cert-123",
          },
          port: 8080,
        },
      },
    }),
  );

  expect(result.success).toBe(false);
});

test("service-fleet-intent produces the first public name or falls back to ALB DNS", async () => {
  const { publicEndpointHost } = await loadEcs();
  expect(
    publicEndpointHost(
      ["api.example.com", "api-alt.example.com"],
      "alb.aws",
    ),
  ).toBe("api.example.com");
  expect(publicEndpointHost([], "alb.aws")).toBe("alb.aws");
});
