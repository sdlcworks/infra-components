import { expect, test } from "bun:test";

import { loadRds } from "./load-aws-rds";

function config(
  access: Record<string, unknown>,
  instances: Record<string, unknown> = { primary: {} },
) {
  return {
    vpcId: "vpc-1",
    subnetIds: ["subnet-a", "subnet-b"],
    access,
    instances,
  };
}

test("database-intent refuses admission that names no source", async () => {
  const { ConfigSchema } = await loadRds();
  const result = ConfigSchema.safeParse(config({}));

  expect(result.success).toBe(false);
  if (!result.success) {
    expect(result.error.issues.map((issue) => issue.message)).toContain(
      "aws-rds: access must declare at least one CIDR or security group; a database no source may reach serves nothing.",
    );
  }
});

test.each(["0.0.0.0/0", "::/0"])(
  "database-intent refuses internet-wide admission %s for a private instance",
  async (cidr) => {
    const { ConfigSchema } = await loadRds();
    const result = ConfigSchema.safeParse(config({ cidrs: [cidr] }));

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.message)).toContain(
        `aws-rds: access.cidrs entry "${cidr}" admits every source on the internet; it is refused unless every declared instance sets publiclyAccessible true.`,
      );
    }
  },
);

test("database-intent admits internet-wide CIDRs only when every instance is public", async () => {
  const { ConfigSchema } = await loadRds();

  expect(
    ConfigSchema.safeParse(
      config({ cidrs: ["0.0.0.0/0"] }, {
        primary: { publiclyAccessible: true },
      }),
    ).success,
  ).toBe(true);

  expect(
    ConfigSchema.safeParse(
      config({ cidrs: ["0.0.0.0/0"] }, {
        primary: { publiclyAccessible: true },
        reporting: { publiclyAccessible: false },
      }),
    ).success,
  ).toBe(false);
});

test("database-intent admits a narrow CIDR without any public instance", async () => {
  const { ConfigSchema } = await loadRds();

  expect(ConfigSchema.safeParse(config({ cidrs: ["10.0.0.0/16"] })).success).toBe(
    true,
  );
});

test("database-intent opens one transport rule per declared engine port and source kind", async () => {
  const { ingressRules, declaredEnginePorts } = await loadRds();
  const instances = {
    primary: { engine: "postgres" as const },
    legacy: { engine: "mysql" as const },
  } as any;

  expect(declaredEnginePorts(instances)).toEqual([3306, 5432]);
  expect(
    ingressRules([5432], {
      cidrs: ["10.0.0.0/16", "2001:db8::/32"],
      securityGroupIds: ["sg-app"],
    }),
  ).toEqual([
    { protocol: "tcp", fromPort: 5432, toPort: 5432, cidrBlocks: ["10.0.0.0/16"] },
    {
      protocol: "tcp",
      fromPort: 5432,
      toPort: 5432,
      ipv6CidrBlocks: ["2001:db8::/32"],
    },
    {
      protocol: "tcp",
      fromPort: 5432,
      toPort: 5432,
      securityGroups: ["sg-app"],
    },
  ]);
});
