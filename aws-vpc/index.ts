import { z } from "zod";

import { CloudProvider, InfraComponent } from "@sdlcworks/components";

import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";

const DEFAULT_ROUTE_DESTINATION = "0.0.0.0/0";
const HTTPS_PORT = 443;
const CIDR_REPLACEMENT_GUARD_ERROR_PREFIX = "aws-vpc: cidrBlock change refused";

const NAT_STRATEGIES = ["none", "single", "one-per-az"] as const;
const SUBNET_LAYOUTS = [
  "public-only",
  "private-only",
  "public-and-private",
] as const;
const SUBNET_TIERS = ["public", "private"] as const;
const GATEWAY_ENDPOINT_SERVICE_SUFFIXES = ["s3", "dynamodb"] as const;
const ENDPOINT_TYPES = {
  gateway: "Gateway",
  interface: "Interface",
} as const;

type SubnetTier = (typeof SUBNET_TIERS)[number];

type ParsedCidr = {
  base: number;
  prefix: number;
};

const SubnetCidrsSchema = z.object({
  public: z.array(z.string()).optional(),
  private: z.array(z.string()).optional(),
});

const InterfaceEndpointSchema = z.object({
  service: z.string(),
  privateDnsEnabled: z.boolean().default(true),
  allowedCidrs: z.array(z.string()).optional(),
});

const ConfigSchema = z.object({
  cidrBlock: z.string(),
  azCount: z.number().int().min(1),
  subnetLayout: z.enum(SUBNET_LAYOUTS),
  natStrategy: z.enum(NAT_STRATEGIES),
  enableDnsSupport: z.boolean().default(true),
  enableDnsHostnames: z.boolean().default(true),
  mapPublicIpOnLaunch: z.boolean().default(false),
  labels: z.record(z.string(), z.string()).default({}),
  gatewayEndpoints: z.array(z.enum(GATEWAY_ENDPOINT_SERVICE_SUFFIXES)).default([
    "s3",
    "dynamodb",
  ]),
  interfaceEndpoints: z.array(InterfaceEndpointSchema).default([]),
  subnetCidrs: SubnetCidrsSchema.optional(),
});

type Config = z.infer<typeof ConfigSchema>;

const component = new InfraComponent({
  metadata: {
    stateful: false,
    proxiable: false,
  },
  connectionTypes: {},
  configSchema: ConfigSchema,
  appComponentTypes: {},
  outputSchema: z.object({
    vpcId: z.string(),
    cidrBlock: z.string(),
    azNames: z.array(z.string()),
    publicSubnetIds: z.array(z.string()),
    privateSubnetIds: z.array(z.string()),
    publicRouteTableIds: z.array(z.string()),
    privateRouteTableIds: z.array(z.string()),
    igwId: z.string().optional(),
    natGatewayIds: z.array(z.string()),
  }),
});

function parseCidr(cidr: string): ParsedCidr {
  const [address, prefixRaw] = cidr.split("/");
  const prefix = Number(prefixRaw);
  const octets = address?.split(".").map((part) => Number(part)) ?? [];

  if (
    octets.length !== 4 ||
    !Number.isInteger(prefix) ||
    prefix < 0 ||
    prefix > 32 ||
    octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
  ) {
    throw new Error(`aws-vpc: invalid CIDR block "${cidr}".`);
  }

  const base = octets.reduce((acc, octet) => (acc << 8) + octet, 0) >>> 0;
  const blockSize = 2 ** (32 - prefix);

  if (base % blockSize !== 0) {
    throw new Error(`aws-vpc: CIDR block "${cidr}" is not network-aligned.`);
  }

  return { base, prefix };
}

function formatCidr(base: number, prefix: number): string {
  const octets = [
    (base >>> 24) & 255,
    (base >>> 16) & 255,
    (base >>> 8) & 255,
    base & 255,
  ];

  return `${octets.join(".")}/${prefix}`;
}

function cidrEnd(cidr: ParsedCidr): number {
  return cidr.base + 2 ** (32 - cidr.prefix) - 1;
}

function cidrContains(parentCidr: string, childCidr: string): boolean {
  const parent = parseCidr(parentCidr);
  const child = parseCidr(childCidr);

  return parent.base <= child.base && cidrEnd(child) <= cidrEnd(parent);
}

function deriveSubnetCidrs(vpcCidr: string, count: number): string[] {
  if (count === 0) {
    return [];
  }

  const vpc = parseCidr(vpcCidr);
  const subnetBits = Math.ceil(Math.log2(count));
  const subnetPrefix = vpc.prefix + subnetBits;

  if (subnetPrefix > 32) {
    throw new Error(
      `aws-vpc: subnet layout requires ${count} subnets, but ${vpcCidr} cannot be split that many times.`,
    );
  }

  const subnetSize = 2 ** (32 - subnetPrefix);

  return Array.from({ length: count }, (_, index) =>
    formatCidr(vpc.base + index * subnetSize, subnetPrefix),
  );
}

function tierCounts(
  subnetLayout: (typeof SUBNET_LAYOUTS)[number],
  azCount: number,
): Record<SubnetTier, number> {
  return {
    public:
      subnetLayout === "public-only" || subnetLayout === "public-and-private"
        ? azCount
        : 0,
    private:
      subnetLayout === "private-only" || subnetLayout === "public-and-private"
        ? azCount
        : 0,
  };
}

function validateSubnetCidrs(
  vpcCidr: string,
  tier: SubnetTier,
  cidrs: string[],
  requiredCount: number,
): void {
  if (cidrs.length < requiredCount) {
    throw new Error(
      `aws-vpc: subnetCidrs.${tier} must include at least ${requiredCount} CIDR blocks.`,
    );
  }

  for (const cidr of cidrs.slice(0, requiredCount)) {
    if (!cidrContains(vpcCidr, cidr)) {
      throw new Error(
        `aws-vpc: subnet CIDR ${cidr} for ${tier} tier must fit inside VPC CIDR ${vpcCidr}.`,
      );
    }
  }
}

function resolvedTierCidrs(
  vpcCidr: string,
  counts: Record<SubnetTier, number>,
  explicitCidrs?: Partial<Record<SubnetTier, string[]>>,
): Record<SubnetTier, string[]> {
  const derived = deriveSubnetCidrs(vpcCidr, counts.public + counts.private);
  const fallback = {
    public: derived.slice(0, counts.public),
    private: derived.slice(counts.public, counts.public + counts.private),
  };

  const result = {
    public: explicitCidrs?.public ?? fallback.public,
    private: explicitCidrs?.private ?? fallback.private,
  };

  for (const tier of SUBNET_TIERS) {
    validateSubnetCidrs(vpcCidr, tier, result[tier], counts[tier]);
  }

  return {
    public: result.public.slice(0, counts.public),
    private: result.private.slice(0, counts.private),
  };
}

function endpointServiceName(region: pulumi.Input<string>, service: string): pulumi.Output<string> {
  return pulumi.output(region).apply((regionName) => `com.amazonaws.${regionName}.${service}`);
}

function tags(
  labels: Record<string, string>,
  name: string,
  tier?: SubnetTier,
): Record<string, string> {
  return {
    ...labels,
    Name: name,
    ...(tier ? { Tier: tier } : {}),
  };
}

component.implement(CloudProvider.aws, {
  stateSchema: z.object({
    cidrBlockFingerprint: z.string().optional(),
    vpcId: z.string().optional(),
    publicSubnetIds: z.array(z.string()).optional(),
    privateSubnetIds: z.array(z.string()).optional(),
    publicRouteTableIds: z.array(z.string()).optional(),
    privateRouteTableIds: z.array(z.string()).optional(),
    igwId: z.string().optional(),
    natGatewayIds: z.array(z.string()).optional(),
  }),
  initialState: {},

  pulumi: async ({ $, inputs, state, aws: awsProvider }) => {
    const config = inputs as unknown as Config;
    const {
      cidrBlock,
      azCount,
      subnetLayout,
      natStrategy,
      enableDnsSupport,
      enableDnsHostnames,
      mapPublicIpOnLaunch,
      labels,
      gatewayEndpoints,
      interfaceEndpoints,
      subnetCidrs,
    } = config;

    if (
      state.cidrBlockFingerprint &&
      state.cidrBlockFingerprint !== cidrBlock
    ) {
      throw new Error(
        `${CIDR_REPLACEMENT_GUARD_ERROR_PREFIX}: stored ${state.cidrBlockFingerprint}, requested ${cidrBlock}.`,
      );
    }

    const counts = tierCounts(subnetLayout, azCount);

    if (natStrategy !== "none" && counts.public === 0) {
      throw new Error(
        "aws-vpc: natStrategy other than none requires public subnets.",
      );
    }

    if (natStrategy === "one-per-az" && azCount < 2) {
      throw new Error("aws-vpc: natStrategy one-per-az requires azCount >= 2.");
    }

    const tierCidrs = resolvedTierCidrs(cidrBlock, counts, subnetCidrs);
    const awsOpts: pulumi.CustomResourceOptions = awsProvider
      ? { provider: awsProvider }
      : {};

    const availableZones = aws.getAvailabilityZonesOutput(
      {
        state: "available",
        filters: [
          {
            name: "opt-in-status",
            values: ["opt-in-not-required"],
          },
        ],
      },
      awsOpts,
    );
    const azNames = availableZones.names.apply((names) => {
      const selected = [...names].sort().slice(0, azCount);

      if (selected.length < azCount) {
        throw new Error(
          `aws-vpc: requested ${azCount} availability zones, but only ${selected.length} are available.`,
        );
      }

      return selected;
    });
    const region = availableZones.region;

    const vpc = new aws.ec2.Vpc($`vpc`, {
      cidrBlock,
      enableDnsSupport,
      enableDnsHostnames,
      tags: tags(labels, $`vpc`),
    }, awsOpts);

    const publicSubnets = tierCidrs.public.map((subnetCidr, index) =>
      new aws.ec2.Subnet($`public-subnet-${index + 1}`, {
        vpcId: vpc.id,
        cidrBlock: subnetCidr,
        availabilityZone: azNames.apply((names) => names[index]),
        mapPublicIpOnLaunch,
        tags: tags(labels, $`public-subnet-${index + 1}`, "public"),
      }, awsOpts),
    );

    const privateSubnets = tierCidrs.private.map((subnetCidr, index) =>
      new aws.ec2.Subnet($`private-subnet-${index + 1}`, {
        vpcId: vpc.id,
        cidrBlock: subnetCidr,
        availabilityZone: azNames.apply((names) => names[index]),
        tags: tags(labels, $`private-subnet-${index + 1}`, "private"),
      }, awsOpts),
    );

    const internetGateway = publicSubnets.length > 0
      ? new aws.ec2.InternetGateway($`igw`, {
          vpcId: vpc.id,
          tags: tags(labels, $`igw`),
        }, awsOpts)
      : undefined;

    const publicRouteTables = publicSubnets.map((subnet, index) => {
      const routeTable = new aws.ec2.RouteTable($`public-rt-${index + 1}`, {
        vpcId: vpc.id,
        tags: tags(labels, $`public-rt-${index + 1}`, "public"),
      }, awsOpts);

      new aws.ec2.RouteTableAssociation($`public-rta-${index + 1}`, {
        subnetId: subnet.id,
        routeTableId: routeTable.id,
      }, awsOpts);

      if (internetGateway) {
        new aws.ec2.Route($`public-default-route-${index + 1}`, {
          routeTableId: routeTable.id,
          destinationCidrBlock: DEFAULT_ROUTE_DESTINATION,
          gatewayId: internetGateway.id,
        }, awsOpts);
      }

      return routeTable;
    });

    const natGatewayCount =
      natStrategy === "none"
        ? 0
        : natStrategy === "single"
          ? 1
          : azCount;
    const eips = Array.from({ length: natGatewayCount }, (_, index) =>
      new aws.ec2.Eip($`nat-eip-${index + 1}`, {
        domain: "vpc",
        tags: tags(labels, $`nat-eip-${index + 1}`),
      }, awsOpts),
    );
    const natGateways = eips.map((eip, index) =>
      new aws.ec2.NatGateway($`nat-${index + 1}`, {
        allocationId: eip.allocationId,
        subnetId: publicSubnets[index % publicSubnets.length].id,
        tags: tags(labels, $`nat-${index + 1}`),
      }, internetGateway ? { ...awsOpts, dependsOn: [internetGateway] } : awsOpts),
    );

    const privateRouteTables = privateSubnets.map((subnet, index) => {
      const routeTable = new aws.ec2.RouteTable($`private-rt-${index + 1}`, {
        vpcId: vpc.id,
        tags: tags(labels, $`private-rt-${index + 1}`, "private"),
      }, awsOpts);

      new aws.ec2.RouteTableAssociation($`private-rta-${index + 1}`, {
        subnetId: subnet.id,
        routeTableId: routeTable.id,
      }, awsOpts);

      const natGateway =
        natStrategy === "none"
          ? undefined
          : natStrategy === "single"
            ? natGateways[0]
            : natGateways[index];

      if (natGateway) {
        new aws.ec2.Route($`private-default-route-${index + 1}`, {
          routeTableId: routeTable.id,
          destinationCidrBlock: DEFAULT_ROUTE_DESTINATION,
          natGatewayId: natGateway.id,
        }, awsOpts);
      }

      return routeTable;
    });

    const routeTableIdsForGatewayEndpoints = [
      ...publicRouteTables.map((routeTable) => routeTable.id),
      ...privateRouteTables.map((routeTable) => routeTable.id),
    ];

    for (const service of gatewayEndpoints) {
      new aws.ec2.VpcEndpoint($`gateway-endpoint-${service}`, {
        vpcId: vpc.id,
        serviceName: endpointServiceName(region, service),
        vpcEndpointType: ENDPOINT_TYPES.gateway,
        routeTableIds: routeTableIdsForGatewayEndpoints,
        tags: tags(labels, $`gateway-endpoint-${service}`),
      }, awsOpts);
    }

    if (interfaceEndpoints.length > 0) {
      const endpointSubnets =
        privateSubnets.length > 0 ? privateSubnets : publicSubnets;
      const endpointSecurityGroup = new aws.ec2.SecurityGroup($`endpoint-sg`, {
        name: $`endpoint-sg`,
        description: "Managed by sdlc.works aws-vpc component for interface endpoints",
        vpcId: vpc.id,
        ingress: interfaceEndpoints.flatMap((endpoint) =>
          (endpoint.allowedCidrs ?? [cidrBlock]).map((allowedCidr) => ({
            protocol: "tcp",
            fromPort: HTTPS_PORT,
            toPort: HTTPS_PORT,
            cidrBlocks: [allowedCidr],
            description: `Allow ${endpoint.service} endpoint HTTPS from ${allowedCidr}`,
          })),
        ),
        egress: [
          {
            protocol: "-1",
            fromPort: 0,
            toPort: 0,
            cidrBlocks: [DEFAULT_ROUTE_DESTINATION],
            description: "Allow all outbound",
          },
        ],
        revokeRulesOnDelete: true,
        tags: tags(labels, $`endpoint-sg`),
      }, awsOpts);

      interfaceEndpoints.forEach((endpoint, index) => {
        new aws.ec2.VpcEndpoint($`interface-endpoint-${index + 1}`, {
          vpcId: vpc.id,
          serviceName: endpointServiceName(region, endpoint.service),
          vpcEndpointType: ENDPOINT_TYPES.interface,
          privateDnsEnabled: endpoint.privateDnsEnabled,
          subnetIds: endpointSubnets.map((subnet) => subnet.id),
          securityGroupIds: [endpointSecurityGroup.id],
          tags: tags(labels, $`interface-endpoint-${endpoint.service}`),
        }, awsOpts);
      });
    }

    const outputs = {
      vpcId: vpc.id,
      cidrBlock: pulumi.output(cidrBlock),
      azNames,
      publicSubnetIds: pulumi.all(publicSubnets.map((subnet) => subnet.id)),
      privateSubnetIds: pulumi.all(privateSubnets.map((subnet) => subnet.id)),
      publicRouteTableIds: pulumi.all(publicRouteTables.map((routeTable) => routeTable.id)),
      privateRouteTableIds: pulumi.all(privateRouteTables.map((routeTable) => routeTable.id)),
      igwId: internetGateway?.id,
      natGatewayIds: pulumi.all(natGateways.map((natGateway) => natGateway.id)),
    };

    state.cidrBlockFingerprint = cidrBlock;
    state.vpcId = outputs.vpcId;
    state.publicSubnetIds = outputs.publicSubnetIds;
    state.privateSubnetIds = outputs.privateSubnetIds;
    state.publicRouteTableIds = outputs.publicRouteTableIds;
    state.privateRouteTableIds = outputs.privateRouteTableIds;
    state.igwId = outputs.igwId;
    state.natGatewayIds = outputs.natGatewayIds;

    return outputs;
  },
});

export default component;
