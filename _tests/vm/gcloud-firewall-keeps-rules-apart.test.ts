import { expect, mock, test } from "bun:test";

mock.module("@pulumi/hcloud", () => ({}));
mock.module("@pulumi/gcp", () => ({}));
mock.module("@pulumi/aws", () => ({}));
mock.module("@pulumi/pulumi", () => ({}));
mock.module("../../_internal/interfaces", () => ({ PublicCI: {} }));
mock.module("@sdlcworks/components", () => ({
  InfraComponent: class {
    implement() {}
  },
  connectionHandler: (value: unknown) => value,
  CloudProvider: { aws: "aws", gcloud: "gcloud", hetzner: "hetzner" },
  defaultAppComponentType: (value: unknown) => value,
}));

test("an office-only SSH rule stays office-only beside a public HTTPS rule", async () => {
  const { gcloudFirewallRules } = await import("../../vm/index");
  const rules = gcloudFirewallRules([
    { direction: "in", protocol: "tcp", port: "22", sourceRanges: ["203.0.113.0/24"] },
    { direction: "in", protocol: "tcp", port: "443", sourceRanges: ["0.0.0.0/0"] },
  ] as any);
  expect(rules).toEqual([
    { direction: "INGRESS", protocol: "tcp", ports: ["22"], sourceRanges: ["203.0.113.0/24"], destinationRanges: undefined },
    { direction: "INGRESS", protocol: "tcp", ports: ["443"], sourceRanges: ["0.0.0.0/0"], destinationRanges: undefined },
  ]);
});

test("egress rules are kept and any-port means every port", async () => {
  const { gcloudFirewallRules } = await import("../../vm/index");
  const [rule] = gcloudFirewallRules([{ direction: "out", protocol: "tcp", port: "any", destinationRanges: ["10.0.0.0/8"] }] as any);
  expect(rule).toEqual({ direction: "EGRESS", protocol: "tcp", ports: undefined, sourceRanges: undefined, destinationRanges: ["10.0.0.0/8"] });
});
