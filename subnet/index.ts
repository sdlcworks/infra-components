import { z } from "zod";

import { CloudProvider, InfraComponent } from "@sdlcworks/components";

import * as gcp from "@pulumi/gcp";

// ---- Zod Enums for Config Options ----

const SubnetPurpose = z.enum([
  "PRIVATE",
  "REGIONAL_MANAGED_PROXY",
  "GLOBAL_MANAGED_PROXY",
  "PRIVATE_SERVICE_CONNECT",
  "PRIVATE_NAT",
]);

const SubnetRole = z.enum(["ACTIVE", "BACKUP"]);

const StackType = z.enum(["IPV4_ONLY", "IPV4_IPV6", "IPV6_ONLY"]);

const Ipv6AccessType = z.enum(["EXTERNAL", "INTERNAL"]);

const LogAggregationInterval = z.enum([
  "INTERVAL_5_SEC",
  "INTERVAL_30_SEC",
  "INTERVAL_1_MIN",
  "INTERVAL_5_MIN",
  "INTERVAL_10_MIN",
  "INTERVAL_15_MIN",
]);

const LogMetadata = z.enum([
  "INCLUDE_ALL_METADATA",
  "EXCLUDE_ALL_METADATA",
  "CUSTOM_METADATA",
]);

// ---- Reusable Schema Definitions ----

const SecondaryIpRangeSchema = z.object({
  rangeName: z.string(),
  ipCidrRange: z.string(),
});

const FlowLogConfigSchema = z.object({
  aggregationInterval: LogAggregationInterval.default("INTERVAL_5_SEC"),
  flowSampling: z.number().min(0).max(1).default(0.5),
  metadata: LogMetadata.default("INCLUDE_ALL_METADATA"),
  filterExpr: z.string().optional(),
});

// ---- Component Definition ----

const component = new InfraComponent({
  metadata: {
    stateful: false,
    proxiable: false,
  },
  connectionTypes: {},
  configSchema: z.object({
    // Core (interop with VPC)
    networkId: z.string(),
    region: z.string().default("us-central1"),
    ipCidrRange: z.string(),

    // Subnet Purpose & Role
    purpose: SubnetPurpose.default("PRIVATE"),
    role: SubnetRole.optional(),

    // IP Stack Configuration
    stackType: StackType.default("IPV4_ONLY"),
    ipv6AccessType: Ipv6AccessType.optional(),

    // Private Access
    privateIpGoogleAccess: z.boolean().default(true),
    privateIpv6GoogleAccess: z.string().optional(),

    // Secondary IP Ranges (for GKE pods/services)
    secondaryIpRanges: z.array(SecondaryIpRangeSchema).default([]),

    // Flow Logs
    enableFlowLogs: z.boolean().default(false),
    flowLogConfig: FlowLogConfigSchema.optional(),
  }),
  appComponentTypes: {},
  outputSchema: z.object({
    // Core outputs
    id: z.string(),
    selfLink: z.string(),
    name: z.string(),
    region: z.string(),

    // IP outputs
    ipCidrRange: z.string(),
    gatewayAddress: z.string(),

    // IPv6 outputs (when enabled)
    externalIpv6Prefix: z.string().optional(),

    // Secondary ranges (for GKE reference)
    secondaryIpRanges: z.array(SecondaryIpRangeSchema),
  }),
});

// ---- GCloud Provider Implementation ----

component.implement(CloudProvider.gcloud, {
  pulumi: async ({ $, inputs }) => {
    const {
      networkId,
      region,
      ipCidrRange,
      purpose,
      role,
      stackType,
      ipv6AccessType,
      privateIpGoogleAccess,
      privateIpv6GoogleAccess,
      secondaryIpRanges,
      enableFlowLogs,
      flowLogConfig,
    } = inputs;

    // Proxy-type subnets (REGIONAL_MANAGED_PROXY, GLOBAL_MANAGED_PROXY) don't support privateIpGoogleAccess
    const isProxySubnet = purpose === "REGIONAL_MANAGED_PROXY" || purpose === "GLOBAL_MANAGED_PROXY";

    const subnet = new gcp.compute.Subnetwork($`subnet`, {
      network: networkId,
      region: region,
      ipCidrRange: ipCidrRange,
      purpose: purpose,
      role: role,
      stackType: stackType,
      ipv6AccessType: ipv6AccessType,
      privateIpGoogleAccess: isProxySubnet ? undefined : privateIpGoogleAccess,
      privateIpv6GoogleAccess: privateIpv6GoogleAccess,
      secondaryIpRanges: secondaryIpRanges,
      logConfig:
        enableFlowLogs && flowLogConfig
          ? {
              aggregationInterval: flowLogConfig.aggregationInterval,
              flowSampling: flowLogConfig.flowSampling,
              metadata: flowLogConfig.metadata,
              filterExpr: flowLogConfig.filterExpr,
            }
          : undefined,
      description: "Subnet managed by sdlc.works",
    });

    return {
      id: subnet.id,
      selfLink: subnet.selfLink,
      name: subnet.name,
      region: subnet.region,
      ipCidrRange: subnet.ipCidrRange,
      gatewayAddress: subnet.gatewayAddress,
      externalIpv6Prefix: subnet.externalIpv6Prefix,
      secondaryIpRanges: subnet.secondaryIpRanges,
    };
  },
});

export default component;
