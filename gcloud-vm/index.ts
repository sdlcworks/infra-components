/**
 * gcloud-vm — Standalone Google Compute Engine VM infrastructure component.
 *
 * Creates a single GCE VM with a stable public IP (via gcp.compute.Address),
 * managed inline firewall, SSH keys via instance metadata, cloud-init
 * (user-data), and startup-script support. Pure infrastructure: no
 * app-component allocation, no artifact deployment.
 *
 * Resource graph:
 *   Layer 0 (parallel): static-ip (Address), firewall (Firewall), boot-image (getImageOutput)
 *   Layer 1: instance (Instance) — depends on all of Layer 0
 *
 * Connection type "public" exposes the VM's static IPv4 via PublicCI for
 * platform URI resolution (e.g. URL registers, cross-infra connections).
 */

import { z } from "zod";

import {
  CloudProvider,
  InfraComponent,
  connectionHandler,
  defaultAppComponentType,
} from "@sdlcworks/components";

import * as gcp from "@pulumi/gcp";
import * as pulumi from "@pulumi/pulumi";

import { PublicCI } from "../_internal/interfaces";

// ---- Constants ----

/**
 * Metadata keys managed by this component. If a user's `metadata` map contains
 * any of these, the config is rejected to prevent silent overwrites.
 */
const RESERVED_METADATA_KEYS = ["ssh-keys", "user-data", "startup-script"] as const;

// ---- Zod Schemas ----

const FirewallRuleSchema = z.object({
  protocol: z.enum(["tcp", "udp", "icmp", "all"]),
  ports: z
    .array(z.string())
    .optional()
    .describe(
      'Port or range. Required for tcp/udp. Examples: "22", "80", "8000-9000"',
    ),
  sourceRanges: z
    .array(z.string())
    .optional()
    .describe(
      'CIDRs for inbound. Example: ["0.0.0.0/0"]. ' +
        "NOTE: GCE aggregates sourceRanges across all rules into one firewall — " +
        "all CIDRs apply to all ports. For per-port source filtering, use separate firewall components.",
    ),
  description: z.string().optional(),
});

// ---- Component Definition ----

const component = new InfraComponent({
  metadata: {
    stateful: true,
    proxiable: false,
  },
  connectionTypes: {
    public: {
      description:
        "exposes the VM via its public IPv4 address for external access",
      interface: PublicCI,
    },
  } as const,
  connectionInterfaces: [],
  configSchema: z.object({
    // ---- Compute Core ----

    machineType: z
      .string()
      .describe(
        "GCE machine type name (e.g. \"e2-medium\", \"n2-standard-4\", \"c3-standard-8\"). " +
          "In-place update: VM stops, resizes, restarts (requires allowStoppingForUpdate=true).",
      ),

    zone: z
      .string()
      .describe(
        "GCE zone (e.g. \"us-central1-a\", \"europe-west1-b\"). " +
          "WARNING: changing this value DESTROYS AND RECREATES the VM.",
      ),

    // ---- Boot Disk ----

    imageFamily: z
      .string()
      .default("ubuntu-2404-lts-amd64")
      .describe(
        "Boot disk image family. Resolved once at creation; changes are ignored " +
          "thereafter (ignoreChanges on bootDisk prevents spurious replacement).",
      ),

    imageProject: z
      .string()
      .default("ubuntu-os-cloud")
      .describe(
        "GCP project hosting the boot disk image family.",
      ),

    bootDiskSizeGb: z
      .number()
      .min(10)
      .max(65536)
      .describe(
        "Boot disk size in GB. " +
          "WARNING: changing this value DESTROYS AND RECREATES the VM.",
      ),

    bootDiskType: z
      .enum(["pd-standard", "pd-balanced", "pd-ssd", "pd-extreme"])
      .default("pd-balanced")
      .describe(
        "Boot disk type. " +
          "WARNING: changing this value DESTROYS AND RECREATES the VM.",
      ),

    // ---- SSH Access ----

    sshPublicKeys: z
      .array(z.string())
      .default([])
      .describe(
        "SSH public key strings (e.g. \"ssh-ed25519 AAAA...\"). Injected via GCE instance " +
          "metadata. In-place update (metadata change, no VM replacement).",
      ),

    sshUser: z
      .string()
      .default("sdlc")
      .describe(
        "Username associated with the SSH public keys in GCE metadata.",
      ),

    // ---- Cloud-Init / Startup Script ----

    userData: z
      .string()
      .optional()
      .describe(
        "Cloud-init user data (typically #cloud-config YAML). Mapped to GCE metadata key " +
          "\"user-data\". In-place update (does NOT re-execute on a running VM).",
      ),

    startupScript: z
      .string()
      .optional()
      .describe(
        "GCE startup script. Mapped to metadata key \"startup-script\". " +
          "Runs on every boot. In-place update.",
      ),

    // ---- Networking ----

    networkId: z
      .string()
      .optional()
      .describe(
        "VPC network self-link or ID. When omitted, uses GCP default network. " +
          "WARNING: changing this value DESTROYS AND RECREATES the VM.",
      ),

    subnetId: z
      .string()
      .optional()
      .describe(
        "Subnet self-link or ID. When omitted, GCP auto-selects the default subnet for the zone's region. " +
          "WARNING: changing this value DESTROYS AND RECREATES the VM.",
      ),

    assignExternalIp: z
      .boolean()
      .default(true)
      .describe(
        "When true, creates a static gcp.compute.Address and attaches it to the VM. " +
          "The static IP survives VM replacement.",
      ),

    networkTags: z
      .array(z.string())
      .default([])
      .describe("GCE network tags. In-place update."),

    canIpForward: z
      .boolean()
      .default(false)
      .describe(
        "Enable IP forwarding on the VM. " +
          "WARNING: changing this value DESTROYS AND RECREATES the VM.",
      ),

    networkTier: z
      .enum(["PREMIUM", "STANDARD"])
      .default("PREMIUM")
      .describe("Network tier for the VM's external IP. In-place update."),

    // ---- Firewall ----

    firewallRules: z
      .array(FirewallRuleSchema)
      .describe(
        "Inline INGRESS firewall rules. Creates one gcp.compute.Firewall targeting this VM " +
          "via a deterministic network tag. Changes are non-destructive (in-place update).",
      ),

    // ---- Scheduling ----

    preemptible: z
      .boolean()
      .default(false)
      .describe(
        "Use a preemptible VM. When true, automaticRestart is forced to false and " +
          "onHostMaintenance is forced to TERMINATE. " +
          "WARNING: changing this value DESTROYS AND RECREATES the VM.",
      ),

    automaticRestart: z
      .boolean()
      .default(true)
      .describe(
        "Auto-restart on host failure. Forced to false when preemptible=true. In-place update.",
      ),

    onHostMaintenance: z
      .enum(["MIGRATE", "TERMINATE"])
      .default("MIGRATE")
      .describe(
        "Behaviour during host maintenance. Forced to TERMINATE when preemptible=true. In-place update.",
      ),

    // ---- Shielded VM ----

    enableSecureBoot: z
      .boolean()
      .default(false)
      .describe("Enable Secure Boot (Shielded VM). In-place update (requires allowStoppingForUpdate)."),

    enableVtpm: z
      .boolean()
      .default(false)
      .describe("Enable vTPM (Shielded VM). In-place update."),

    enableIntegrityMonitoring: z
      .boolean()
      .default(false)
      .describe("Enable integrity monitoring (Shielded VM). In-place update."),

    // ---- Labels and Metadata ----

    labels: z
      .record(z.string(), z.string())
      .default({})
      .describe("GCE instance labels (key-value pairs). In-place update."),

    metadata: z
      .record(z.string(), z.string())
      .default({})
      .describe(
        "Additional GCE instance metadata (key-value pairs). Merged with component-managed " +
          "keys (ssh-keys, user-data, startup-script). Reserved keys are rejected at validation time. " +
          "In-place update.",
      ),

    // ---- Protection and Lifecycle ----

    deletionProtection: z
      .boolean()
      .default(false)
      .describe("Enable deletion protection on the VM. In-place update."),

    allowStoppingForUpdate: z
      .boolean()
      .default(true)
      .describe(
        "Allow Compute Engine to stop the VM for in-place updates (e.g. machineType resize). In-place update.",
      ),

    desiredStatus: z
      .enum(["RUNNING", "TERMINATED"])
      .default("RUNNING")
      .describe("Desired VM status. Set to TERMINATED to stop without destroying. In-place update."),
  }),
  appComponentTypes: defaultAppComponentType(z.object({})),
  outputSchema: z.object({
    instanceId: z.string().describe("GCE instance ID"),
    selfLink: z.string().describe("GCE instance self-link (globally unique resource URI)"),
    name: z.string().describe("Instance name (derived from $ naming)"),
    zone: z.string().describe("Zone where the instance was created"),
    machineType: z.string().describe("Effective machine type name"),
    status: z.string().describe("Instance status (e.g. RUNNING, TERMINATED)"),
    ipv4Address: z
      .string()
      .optional()
      .describe("Public IPv4 address (from static Address when assignExternalIp is true)"),
    internalIpAddress: z
      .string()
      .describe("Internal (VPC) IPv4 address"),
  }),
});

// ---- GCP Provider Implementation ----

component.implement(CloudProvider.gcloud, {
  stateSchema: z.object({
    ipv4Address: z.string().optional(),
    internalIpAddress: z.string().optional(),
  }),
  initialState: {},

  pulumi: async ({ $, inputs, state, gcp: provider }) => {
    const {
      machineType,
      zone,
      imageFamily,
      imageProject,
      bootDiskSizeGb,
      bootDiskType,
      sshPublicKeys,
      sshUser,
      userData,
      startupScript,
      networkId,
      subnetId,
      assignExternalIp,
      networkTags,
      canIpForward,
      networkTier,
      firewallRules,
      preemptible,
      automaticRestart,
      onHostMaintenance,
      enableSecureBoot,
      enableVtpm,
      enableIntegrityMonitoring,
      labels,
      metadata,
      deletionProtection,
      allowStoppingForUpdate,
      desiredStatus,
    } = inputs;

    const gcpOpts: pulumi.CustomResourceOptions = { provider };

    // ---- Metadata key collision check ----
    //
    // The user's `metadata` map must not contain keys that this component
    // manages. Fail fast with a clear error rather than silently overwriting.

    const userMetadata = metadata as Record<string, string>;
    for (const key of RESERVED_METADATA_KEYS) {
      if (key in userMetadata) {
        throw new Error(
          `gcloud-vm: metadata key "${key}" is reserved. ` +
            `Use the dedicated config field instead ` +
            `(sshPublicKeys/sshUser for "ssh-keys", userData for "user-data", ` +
            `startupScript for "startup-script").`,
        );
      }
    }

    // ---- Layer 0: Static IP, Firewall, Boot Image (parallel) ----

    // 0a. Static IP — independent Address resource that survives VM replacement.
    // Region is derived from zone by dropping the trailing "-a"/"-b"/"-c"/etc.
    let staticIp: gcp.compute.Address | undefined;
    if (assignExternalIp) {
      const region = (zone as string).replace(/-[a-z]$/, "");
      staticIp = new gcp.compute.Address($`static-ip`, {
        name: $`static-ip`,
        addressType: "EXTERNAL",
        networkTier: networkTier as string,
        region,
      }, gcpOpts);
    }

    // 0b. Firewall — one ingress firewall targeting this VM via a deterministic tag.
    const fwTargetTag = $`fw-target`;
    if ((firewallRules as any[]).length > 0) {
      const firewallNetwork = networkId
        ? (networkId as string)
        : "default";

      new gcp.compute.Firewall($`firewall`, {
        name: $`firewall`,
        network: firewallNetwork,
        direction: "INGRESS",
        targetTags: [fwTargetTag],
        allows: (firewallRules as any[]).map((rule: any) => ({
          protocol: rule.protocol,
          ports: rule.ports,
        })),
        sourceRanges: (() => {
          // Collect all unique sourceRanges across rules. If any rule omits
          // sourceRanges, GCP defaults to 0.0.0.0/0 for that rule. We merge
          // them at the firewall level since GCE Firewall.allows does not
          // carry per-rule sourceRanges — sourceRanges is a firewall-level field.
          const ranges = new Set<string>();
          for (const rule of firewallRules as any[]) {
            if (rule.sourceRanges) {
              for (const r of rule.sourceRanges) {
                ranges.add(r);
              }
            }
          }
          return ranges.size > 0 ? Array.from(ranges) : ["0.0.0.0/0"];
        })(),
        description: "Inline firewall for gcloud-vm (managed by sdlc.works)",
      }, gcpOpts);
    }

    // 0c. Boot image lookup — data source, not a managed resource.
    const bootImage = gcp.compute.getImageOutput({
      family: imageFamily as string,
      project: imageProject as string,
    }, gcpOpts);

    // ---- Build instance metadata ----
    //
    // Component-managed keys take precedence over user-supplied metadata
    // (collision already rejected above, so this merge is safe).

    const instanceMetadata: Record<string, pulumi.Input<string>> = {
      ...userMetadata,
    };

    // SSH keys: format is "user:key1\nuser:key2\n..."
    const sshKeys = sshPublicKeys as string[];
    if (sshKeys.length > 0) {
      const sshUser_ = sshUser as string;
      instanceMetadata["ssh-keys"] = sshKeys
        .map((key) => `${sshUser_}:${key}`)
        .join("\n");
    }

    if (userData) {
      instanceMetadata["user-data"] = userData as string;
    }

    if (startupScript) {
      instanceMetadata["startup-script"] = startupScript as string;
    }

    // ---- Scheduling auto-correction ----
    //
    // When preemptible=true, GCE requires automaticRestart=false and
    // onHostMaintenance="TERMINATE". Force these regardless of user input.

    const effectiveAutomaticRestart = preemptible ? false : (automaticRestart as boolean);
    const effectiveOnHostMaintenance = preemptible ? "TERMINATE" : (onHostMaintenance as string);

    // ---- Merge network tags with firewall target tag ----

    const mergedTags = [
      ...(networkTags as string[]),
      fwTargetTag,
    ];

    // ---- Layer 1: Instance ----

    // Build accessConfigs for the network interface.
    const accessConfigs: gcp.types.input.compute.InstanceNetworkInterfaceAccessConfig[] = [];
    if (assignExternalIp) {
      accessConfigs.push({
        natIp: staticIp!.address,
        networkTier: networkTier as string,
      });
    }

    const instanceName = $`instance`;

    const instance = new gcp.compute.Instance(instanceName, {
      name: instanceName,
      zone: zone as string,
      machineType: machineType as string,
      description: "Standalone GCE VM managed by sdlc.works",
      labels: labels as Record<string, string>,
      tags: mergedTags,
      canIpForward: canIpForward as boolean,

      bootDisk: {
        autoDelete: true,
        initializeParams: {
          image: bootImage.selfLink,
          size: bootDiskSizeGb as number,
          type: pulumi.interpolate`zones/${zone}/diskTypes/${bootDiskType}`,
        },
      },

      networkInterfaces: [
        {
          ...(networkId
            ? { network: networkId as string }
            : !subnetId
              ? { network: "default" }
              : {}),
          ...(subnetId ? { subnetwork: subnetId as string } : {}),
          accessConfigs,
        },
      ],

      scheduling: {
        preemptible: preemptible as boolean,
        automaticRestart: effectiveAutomaticRestart,
        onHostMaintenance: effectiveOnHostMaintenance,
      },

      shieldedInstanceConfig: {
        enableSecureBoot: enableSecureBoot as boolean,
        enableVtpm: enableVtpm as boolean,
        enableIntegrityMonitoring: enableIntegrityMonitoring as boolean,
      },

      metadata: instanceMetadata,

      deletionProtection: deletionProtection as boolean,
      allowStoppingForUpdate: allowStoppingForUpdate as boolean,
      desiredStatus: desiredStatus as string,
    }, {
      ...gcpOpts,
      dependsOn: staticIp ? [staticIp] : [],
      // Prevent spurious VM replacements: the boot disk image selfLink changes
      // whenever Google publishes a new image in the family. Without this,
      // every `pulumi up` would detect [diff: ~bootDisk] and trigger a
      // ForceNew VM replacement. Broadened to the entire "bootDisk" block
      // because the GCP provider normalizes nested field paths and narrower
      // paths may not suppress the ForceNew correctly.
      // Follows the k3s component precedent (k3s/index.ts:1286).
      ignoreChanges: ["bootDisk"],
    });

    // ---- Populate state for connect handler ----

    const internalIp = instance.networkInterfaces[0].networkIp;
    const externalIp = staticIp ? staticIp.address : undefined;

    state.ipv4Address = externalIp;
    state.internalIpAddress = internalIp;

    // ---- Return outputs ----

    return {
      instanceId: instance.instanceId,
      selfLink: instance.selfLink,
      name: instance.name,
      zone: instance.zone,
      machineType: instance.machineType,
      status: instance.currentStatus,
      ipv4Address: externalIp
        ? (typeof externalIp === "string"
            ? pulumi.output(externalIp)
            : externalIp)
        : pulumi.output(undefined),
      internalIpAddress: internalIp,
    };
  },

  // ---- Connect Handler ----
  //
  // The PublicCI handler returns the VM's static public IPv4 as the connection
  // URI. This is used by URL registers and cross-infra connections.
  // Since gcloud-vm is non-hosting (no app components), the handler does
  // not look up allocations — it simply returns the VM IP.

  connect: (({ state }: any) => [
    connectionHandler({
      interface: PublicCI,
      handler: async (_ctx: any) => {
        if (!state.ipv4Address) {
          throw new Error(
            "gcloud-vm: no public IPv4 address available. " +
              "Ensure assignExternalIp is true in the component config.",
          );
        }
        return {
          uri: pulumi.output(state.ipv4Address as string),
          metadata: {
            appComponentType: "server",
            host: state.ipv4Address as string,
            protocol: "https" as const,
          },
        };
      },
    }),
  ]) as any,
});

export default component;
