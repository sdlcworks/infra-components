import { expect, test } from "bun:test";

import { loadEcs } from "./load-ecs";

test.each([61440, 122880, 249856])(
  "service-fleet-intent accepts the reviewed 32-vCPU memory boundary %i",
  async (memoryMb) => {
    const { validateFargateSize } = await loadEcs();
    expect(() => validateFargateSize("worker", 32768, memoryMb)).not.toThrow();
  },
);

test("service-fleet-intent rejects an unsupported 32-vCPU memory value", async () => {
  const { validateFargateSize } = await loadEcs();
  expect(() => validateFargateSize("worker", 32768, 69632)).toThrow(
    "are not a valid Fargate size",
  );
});

test("service-fleet-intent caps ephemeral storage at 200 GiB", async () => {
  const { ConfigSchema } = await loadEcs();
  const servicesSchema = ConfigSchema.shape.services;
  const services = (ephemeralStorageGb: number) => ({
    worker: {
      scaling: { min: 1, max: 1 },
      exposure: { mode: "none" },
      ephemeralStorageGb,
    },
  });

  expect(servicesSchema.safeParse(services(200)).success).toBe(true);
  expect(servicesSchema.safeParse(services(201)).success).toBe(false);
});
