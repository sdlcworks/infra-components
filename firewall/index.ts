import { z } from "zod";

import { CloudProvider, InfraComponent } from "@sdlcworks/components";

import * as gcp from "@pulumi/gcp";

// ---- Zod Enums for Config Options ----

const FirewallDirection = z.enum(["INGRESS", "EGRESS"]);

const FirewallProtocol = z.enum(["tcp", "udp", "icmp", "all"]);

const FirewallAction = z.enum(["allow", "deny"]);

const LogMetadata = z.enum(["INCLUDE_ALL_METADATA", "EXCLUDE_ALL_METADATA"]);

// ---- Reusable Schema Definitions ----

const FirewallRuleSchema = z.object({
  protocol: FirewallProtocol,
  ports: z.array(z.string()).optional(),
});

const LogConfigSchema = z.object({
  metadata: LogMetadata.default("INCLUDE_ALL_METADATA"),
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

    // Rule Configuration
    direction: FirewallDirection.default("INGRESS"),
    action: FirewallAction.default("allow"),
    priority: z.number().min(0).max(65535).default(1000),
    disabled: z.boolean().default(false),

    // Traffic Rules
    rules: z.array(FirewallRuleSchema).min(1),

    // Source Filtering (for INGRESS)
    sourceRanges: z.array(z.string()).optional(),
    sourceTags: z.array(z.string()).optional(),
    sourceServiceAccounts: z.array(z.string()).optional(),

    // Target Filtering
    targetTags: z.array(z.string()).optional(),
    targetServiceAccounts: z.array(z.string()).optional(),

    // Destination Filtering (for EGRESS)
    destinationRanges: z.array(z.string()).optional(),

    // Logging
    enableLogging: z.boolean().default(false),
    logConfig: LogConfigSchema.optional(),
  }),
  appComponentTypes: {},
  outputSchema: z.object({
    id: z.string(),
    selfLink: z.string(),
    name: z.string(),
    creationTimestamp: z.string(),
  }),
});

// ---- GCloud Provider Implementation ----

component.implement(CloudProvider.gcloud, {
  pulumi: async ({ $, inputs }) => {
    const {
      networkId,
      direction,
      action,
      priority,
      disabled,
      rules,
      sourceRanges,
      sourceTags,
      sourceServiceAccounts,
      targetTags,
      targetServiceAccounts,
      destinationRanges,
      enableLogging,
      logConfig,
    } = inputs;

    // Build allows/denies based on action
    const allows = action === "allow" ? rules : undefined;
    const denies = action === "deny" ? rules : undefined;

    const firewall = new gcp.compute.Firewall($`firewall`, {
      network: networkId,
      direction: direction,
      priority: priority,
      disabled: disabled,
      allows: allows,
      denies: denies,
      sourceRanges: sourceRanges,
      sourceTags: sourceTags,
      sourceServiceAccounts: sourceServiceAccounts,
      targetTags: targetTags,
      targetServiceAccounts: targetServiceAccounts,
      destinationRanges: destinationRanges,
      logConfig:
        enableLogging && logConfig ? { metadata: logConfig.metadata } : undefined,
      description: "Firewall rule managed by sdlc.works",
    });

    return {
      id: firewall.id,
      selfLink: firewall.selfLink,
      name: firewall.name,
      creationTimestamp: firewall.creationTimestamp,
    };
  },
});

export default component;
