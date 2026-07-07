/**
 * vm -- Unified multi-provider VM infrastructure component.
 *
 * Creates a single VM on Hetzner Cloud, Google Compute Engine, or AWS EC2,
 * depending on which cloud integration the component is bound to. Each
 * provider implementation creates the same structural outcome: a VM with
 * stable public IP, managed firewall, SSH access, cloud-init, and a
 * PublicCI connection.
 *
 * This replaces the three separate components (hetzner-vm, gcloud-vm,
 * aws-vm) with a single catalogue entry. The Pulumi resource graphs are
 * identical to the originals -- this is a port, not a rewrite.
 *
 * Config structure:
 *   Flat concept-first schema. Every field is named by what it IS
 *   (e.g. bootDiskSizeGb, networkId, firewallRules), not by which
 *   provider uses it. Provider applicability is documented in each
 *   field's .describe() string. Provider-specific fields that do not
 *   apply are silently ignored by the non-applicable implementations.
 */

import { z } from "zod";

import {
  CloudProvider,
  InfraComponent,
  connectionHandler,
  defaultAppComponentType,
} from "@sdlcworks/components";

import * as hcloud from "@pulumi/hcloud";
import * as gcp from "@pulumi/gcp";
import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";

import { PublicCI } from "../_internal/interfaces";

// ---- Constants ----

/** Default AMI filter: Ubuntu 24.04 Noble, amd64, gp3 root volume. */
const DEFAULT_AMI_FILTER =
  "ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-*";

/** Canonical's AWS account ID -- the official publisher of Ubuntu AMIs. */
const DEFAULT_AMI_OWNER = "099720109477";

/** AWS managed policy ARN for SSM Session Manager access. */
const SSM_MANAGED_POLICY_ARN =
  "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore";

/** EC2 service principal for IAM assume-role trust policies. */
const EC2_SERVICE_PRINCIPAL = "ec2.amazonaws.com";

/**
 * GCE metadata keys managed by the GCloud implementation. User-supplied
 * metadata containing any of these is rejected to prevent silent overwrites.
 */
const RESERVED_METADATA_KEYS = ["ssh-keys", "user-data", "startup-script"] as const;

/** MIME boundary for cloud-init multipart (AWS SSH key injection). */
const MULTIPART_BOUNDARY = "==SDLC_MULTIPART_BOUNDARY==";

// ---- Zod Schema: Universal Firewall Rule ----

const FirewallRuleSchema = z.object({
  direction: z.enum(["in", "out"]).describe(
    'Traffic direction. "in" = ingress, "out" = egress. ' +
      "GCloud: only ingress rules supported; egress rules silently ignored. " +
      "AWS: ingress and egress split into separate Security Group rule sets.",
  ),
  protocol: z.string().describe(
    'Protocol name or number. Common: "tcp", "udp", "icmp", "all", "-1". ' +
      'Hetzner also supports "gre", "esp". AWS uses "-1" for all-protocols.',
  ),
  port: z
    .string()
    .optional()
    .describe(
      'Port or port range string. Required for tcp/udp. Examples: "22", "80", "8000-9000", "any". ' +
        "AWS: parsed to fromPort/toPort number pair. GCloud: wrapped in single-element array.",
    ),
  sourceRanges: z
    .array(z.string())
    .optional()
    .describe(
      'Source CIDRs for ingress rules. Example: ["0.0.0.0/0", "::/0"]. ' +
        "Hetzner: maps to sourceIps. GCloud: aggregated across rules. AWS: maps to cidrBlocks.",
    ),
  destinationRanges: z
    .array(z.string())
    .optional()
    .describe(
      'Destination CIDRs for egress rules. Example: ["0.0.0.0/0", "::/0"]. ' +
        "Hetzner: maps to destinationIps. AWS: maps to cidrBlocks. GCloud: not used.",
    ),
  description: z.string().optional(),
});

// ---- Helper: Parse port string to fromPort/toPort (for AWS) ----

/**
 * Parse a port string like "22", "8000-9000", or "any" into a
 * { fromPort, toPort } pair suitable for AWS Security Group rules.
 */
function parsePortRange(port: string | undefined): { fromPort: number; toPort: number } {
  if (!port || port === "any") return { fromPort: 0, toPort: 65535 };
  if (port.includes("-")) {
    const [from, to] = port.split("-").map(Number);
    return { fromPort: from, toPort: to };
  }
  const p = Number(port);
  return { fromPort: p, toPort: p };
}

// ---- Cloud-Init Helper: buildUserData ----

/**
 * Build a cloud-init user data string from up to three sources:
 *   1. SSH public keys  (rendered as a text/cloud-config part)
 *   2. Raw user data    (type auto-detected: cloud-config or x-shellscript)
 *   3. Startup script   (rendered as a text/x-shellscript part)
 *
 * Returns:
 *   - ""              when all inputs are empty
 *   - raw content     when exactly one part exists (no MIME wrapping)
 *   - MIME multipart  when two or more parts exist
 */
function buildUserData(
  sshPublicKeys: string[],
  rawUserData: string,
  startupScript: string,
): string {
  // Accumulate parts as { contentType, body } pairs.
  const parts: { contentType: string; body: string }[] = [];

  // Part 1: SSH key injection as cloud-config.
  if (sshPublicKeys.length > 0) {
    const sshBlock = [
      "#cloud-config",
      "ssh_authorized_keys:",
      ...sshPublicKeys.map((k) => `  - ${k}`),
    ].join("\n");
    parts.push({ contentType: "text/cloud-config", body: sshBlock });
  }

  // Part 2: User-provided userData (auto-detect type).
  if (rawUserData) {
    const detectedType = rawUserData.startsWith("#cloud-config")
      ? "text/cloud-config"
      : rawUserData.startsWith("#!/")
        ? "text/x-shellscript"
        : "text/cloud-config";
    parts.push({ contentType: detectedType, body: rawUserData });
  }

  // Part 3: Startup script.
  if (startupScript) {
    parts.push({ contentType: "text/x-shellscript", body: startupScript });
  }

  // 0 parts -> empty string.
  if (parts.length === 0) {
    return "";
  }

  // 1 part -> raw content, no MIME wrapping.
  if (parts.length === 1) {
    return parts[0].body;
  }

  // 2+ parts -> MIME multipart document.
  const mimeLines: string[] = [
    `Content-Type: multipart/mixed; boundary="${MULTIPART_BOUNDARY}"`,
    `MIME-Version: 1.0`,
    ``,
  ];
  for (const part of parts) {
    mimeLines.push(
      `--${MULTIPART_BOUNDARY}`,
      `Content-Type: ${part.contentType}; charset="utf-8"`,
      `MIME-Version: 1.0`,
      ``,
      part.body,
      ``,
    );
  }
  mimeLines.push(`--${MULTIPART_BOUNDARY}--`);
  return mimeLines.join("\n");
}

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
    // ---- Compute (2) ----

    machineSize: z
      .string()
      .describe(
        "Provider-native machine size string. " +
          'Hetzner: "cx22", "cx32". GCloud: "e2-medium", "n2-standard-4". AWS: "t3.micro", "m6i.large". ' +
          "In-place resize on all providers (may require stop/start).",
      ),

    region: z
      .string()
      .describe(
        "Provider-native zone/location/AZ. " +
          'Hetzner: "nbg1". GCloud: "us-central1-a". AWS: "us-east-1a" (or "" for auto). ' +
          "WARNING: changing this value DESTROYS AND RECREATES the VM.",
      ),

    // ---- Boot Image (5) ----

    image: z
      .string()
      .default("")
      .describe(
        "Direct image ID/name. When empty, provider-specific defaults apply: " +
          'Hetzner defaults to "ubuntu-24.04", GCloud uses imageFamily lookup, ' +
          "AWS uses imageFilter lookup. " +
          "WARNING: changing this value DESTROYS AND RECREATES the VM.",
      ),

    imageFamily: z
      .string()
      .default("ubuntu-2404-lts-amd64")
      .describe(
        "Boot disk image family for GCloud. Resolved once at creation. " +
          "GCloud only. Other providers ignore this field.",
      ),

    imageProject: z
      .string()
      .default("ubuntu-os-cloud")
      .describe(
        "GCP project hosting the boot disk image family. " +
          "GCloud only. Other providers ignore this field.",
      ),

    imageFilter: z
      .string()
      .default(DEFAULT_AMI_FILTER)
      .describe(
        "AMI name filter for automatic image resolution. Only used when image field is empty. " +
          "AWS only. Other providers ignore this field.",
      ),

    imageFilterOwner: z
      .string()
      .default(DEFAULT_AMI_OWNER)
      .describe(
        "AWS account ID that owns the AMI matched by imageFilter. Only used when image is empty. " +
          "AWS only. Other providers ignore this field.",
      ),

    // ---- Boot Disk (3) ----

    bootDiskSizeGb: z
      .number()
      .min(8)
      .max(65536)
      .optional()
      .describe(
        "Boot/root disk size in GB. " +
          "GCloud: boot disk size (min 10). AWS: root EBS volume size (default 20). " +
          "Hetzner: not applicable (disk size is fixed per server type). " +
          "WARNING: changing this value may DESTROY AND RECREATE the VM.",
      ),

    bootDiskType: z
      .string()
      .default("pd-balanced")
      .describe(
        "Boot/root disk type. " +
          'GCloud: "pd-standard", "pd-balanced", "pd-ssd", "pd-extreme". ' +
          'AWS: "gp3", "gp2", "io1", "io2". ' +
          "Hetzner: not applicable. " +
          "WARNING: changing this value may DESTROY AND RECREATE the VM.",
      ),

    bootDiskEncrypted: z
      .boolean()
      .default(true)
      .describe(
        "Encrypt the root/boot disk. " +
          "AWS: encrypts root EBS volume. WARNING: changing DESTROYS AND RECREATES. " +
          "GCloud/Hetzner: not applicable (GCloud encrypts by default).",
      ),

    // ---- SSH Access (3) ----

    sshPublicKeys: z
      .array(z.string())
      .default([])
      .describe(
        'SSH public key strings (e.g. "ssh-ed25519 AAAA..."). ' +
          "Injection mechanism is provider-specific: Hetzner creates hcloud.SshKey resources, " +
          "GCloud injects via instance metadata, AWS injects via cloud-init.",
      ),

    sshUser: z
      .string()
      .default("sdlc")
      .describe(
        "Username for SSH key injection. " +
          "GCloud: prefixed to each key in ssh-keys metadata. " +
          "Hetzner/AWS: not used (SSH user is determined by the image).",
      ),

    keyPairName: z
      .string()
      .default("")
      .describe(
        "Name of an existing cloud key pair. " +
          "AWS: EC2 Key Pair name. Does NOT create a key pair. " +
          "GCloud/Hetzner: not applicable.",
      ),

    // ---- Initialization (3) ----

    userData: z
      .string()
      .default("")
      .describe(
        "Cloud-init user data (typically a #cloud-config YAML document). " +
          "Supported by all three providers.",
      ),

    startupScript: z
      .string()
      .optional()
      .describe(
        "Shell script to run on the VM at boot (e.g. #!/bin/bash ...). " +
          "GCloud: mapped to metadata 'startup-script' (runs on every boot via guest agent). " +
          "AWS/Hetzner: injected as a text/x-shellscript cloud-init part (runs on first boot by default).",
      ),

    instanceMetadata: z
      .record(z.string(), z.string())
      .default({})
      .describe(
        "Additional instance metadata (key-value pairs). " +
          "GCloud: GCE instance metadata. Reserved keys (ssh-keys, user-data, startup-script) are rejected. " +
          "Hetzner/AWS: not applicable.",
      ),

    // ---- Public Networking (4) ----

    assignPublicIp: z
      .boolean()
      .describe(
        "Create a stable public IP. " +
          "Hetzner: PrimaryIp (v4). GCloud: compute.Address. AWS: Elastic IP.",
      ),

    ipv4Enabled: z
      .boolean()
      .default(true)
      .describe(
        "Enable public IPv4. " +
          "Hetzner: when true, a stable PrimaryIp (v4) is created and attached. " +
          "GCloud/AWS: not applicable (use assignPublicIp).",
      ),

    ipv6Enabled: z
      .boolean()
      .default(true)
      .describe(
        "Enable public IPv6. " +
          "Hetzner: when true, a stable PrimaryIp (v6) is created and attached. " +
          "GCloud/AWS: not applicable.",
      ),

    networkTier: z
      .enum(["PREMIUM", "STANDARD"])
      .default("PREMIUM")
      .describe(
        "Network tier for external IP. " +
          "GCloud only. Hetzner/AWS: not applicable.",
      ),

    // ---- Network Placement (2) ----

    networkId: z
      .string()
      .optional()
      .describe(
        "VPC/network identifier. " +
          "GCloud: VPC network self-link or ID. Omit for default network. " +
          "AWS: VPC ID for Security Group. Omit for default VPC. " +
          "Hetzner: not applicable.",
      ),

    subnetId: z
      .string()
      .optional()
      .describe(
        "Subnet identifier. " +
          "GCloud: subnet self-link or ID. Omit for auto-select. " +
          "AWS: EC2 subnet ID. Omit for default subnet. " +
          "Hetzner: not applicable.",
      ),

    // ---- Network Policy (1) ----

    firewallRules: z
      .array(FirewallRuleSchema)
      .default([])
      .describe(
        "Inline firewall rules using a universal shape. " +
          "Hetzner: creates one hcloud.Firewall attached to this server. " +
          "GCloud: creates one gcp.compute.Firewall (ingress only; egress rules ignored). " +
          "AWS: creates Security Group ingress/egress rules (split by direction).",
      ),

    // ---- Network Config (2) ----

    networkTags: z
      .array(z.string())
      .default([])
      .describe(
        "Network tags. " +
          "GCloud: GCE network tags (firewall target tag is auto-added). " +
          "Hetzner/AWS: not applicable.",
      ),

    canIpForward: z
      .boolean()
      .default(false)
      .describe(
        "Enable IP forwarding. " +
          "GCloud only. WARNING: DESTROYS AND RECREATES. " +
          "Hetzner/AWS: not applicable.",
      ),

    // ---- Scheduling (4) ----

    preemptible: z
      .boolean()
      .default(false)
      .describe(
        "Use preemptible/spot VM. Forces automaticRestart=false, onHostMaintenance=TERMINATE. " +
          "GCloud only. Hetzner/AWS: not applicable.",
      ),

    automaticRestart: z
      .boolean()
      .default(true)
      .describe(
        "Auto-restart on host failure. Forced false when preemptible=true. " +
          "GCloud only. Hetzner/AWS: not applicable.",
      ),

    onHostMaintenance: z
      .enum(["MIGRATE", "TERMINATE"])
      .default("MIGRATE")
      .describe(
        "Host maintenance behaviour. Forced TERMINATE when preemptible=true. " +
          "GCloud only. Hetzner/AWS: not applicable.",
      ),

    desiredStatus: z
      .enum(["RUNNING", "TERMINATED"])
      .default("RUNNING")
      .describe(
        "Desired VM status. TERMINATED stops without destroying. " +
          "GCloud only. Hetzner/AWS: not applicable.",
      ),

    // ---- Protection (3) ----

    deletionProtection: z
      .boolean()
      .default(false)
      .describe(
        "Prevent accidental deletion. " +
          "Hetzner: deleteProtection. GCloud: deletionProtection. AWS: disableApiTermination.",
      ),

    rebuildProtection: z
      .boolean()
      .default(false)
      .describe(
        "Enable rebuild protection. " +
          "Hetzner only. GCloud/AWS: not applicable.",
      ),

    keepDisk: z
      .boolean()
      .default(false)
      .describe(
        "Do not resize disk when changing machineSize. Allows future downgrades. " +
          "Hetzner only. GCloud/AWS: not applicable.",
      ),

    // ---- Labels (1) ----

    labels: z
      .record(z.string(), z.string())
      .default({})
      .describe(
        "Resource labels/tags (key-value pairs). " +
          "Hetzner: labels. GCloud: labels. AWS: tags. In-place update on all providers.",
      ),

    // ---- Security Hardening (4) ----

    secureBoot: z
      .boolean()
      .default(false)
      .describe(
        "Enable Secure Boot (Shielded VM). " +
          "GCloud only. Hetzner/AWS: not applicable.",
      ),

    virtualTpm: z
      .boolean()
      .default(false)
      .describe(
        "Enable virtual TPM (Shielded VM). " +
          "GCloud only. Hetzner/AWS: not applicable.",
      ),

    integrityMonitoring: z
      .boolean()
      .default(false)
      .describe(
        "Enable integrity monitoring (Shielded VM). " +
          "GCloud only. Hetzner/AWS: not applicable.",
      ),

    requireImdsv2: z
      .boolean()
      .default(true)
      .describe(
        "Enforce Instance Metadata Service v2 (HttpTokens='required'). Security best practice. " +
          "AWS only. GCloud/Hetzner: not applicable.",
      ),

    // ---- IAM (2) ----

    instanceProfileArn: z
      .string()
      .default("")
      .describe(
        "ARN of existing IAM instance profile. When set, component creates NO IAM resources. " +
          "AWS only. GCloud/Hetzner: not applicable.",
      ),

    enableSsmAccess: z
      .boolean()
      .default(false)
      .describe(
        "Attach SSM managed policy to component-created IAM role. Only when instanceProfileArn is empty. " +
          "AWS only. GCloud/Hetzner: not applicable.",
      ),

    // ---- Operational (3) ----

    allowStoppingForUpdate: z
      .boolean()
      .default(true)
      .describe(
        "Allow stopping VM for in-place updates (e.g. machineType/instanceType resize). " +
          "GCloud: allowStoppingForUpdate on Instance. AWS: allows Pulumi to stop instance. " +
          "Hetzner: not applicable.",
      ),

    shutdownBeforeDeletion: z
      .boolean()
      .default(true)
      .describe(
        "Gracefully shut down before deleting. " +
          "Hetzner only. GCloud/AWS: not applicable.",
      ),

    backups: z
      .boolean()
      .default(false)
      .describe(
        "Enable automatic backups. " +
          "Hetzner only. GCloud/AWS: not applicable.",
      ),
  }),
  appComponentTypes: defaultAppComponentType(z.object({})),
  outputSchema: z.object({
    // Universal (all providers set these)
    name: z.string().describe("Resource name (derived from $ naming)"),
    status: z.string().describe("Instance status (e.g. running, RUNNING, off)"),
    ipv4Address: z
      .string()
      .optional()
      .describe("Public IPv4 address (from stable IP when assignPublicIp is true)"),

    // Hetzner-specific
    serverId: z
      .string()
      .optional()
      .describe("Hetzner server ID"),
    ipv6Address: z
      .string()
      .optional()
      .describe("Public IPv6 address (Hetzner PrimaryIp when ipv6Enabled)"),
    location: z
      .string()
      .optional()
      .describe("Hetzner location"),
    serverType: z
      .string()
      .optional()
      .describe("Hetzner server type name"),

    // GCloud-specific
    instanceId: z
      .string()
      .optional()
      .describe("GCE instance ID or EC2 instance ID"),
    selfLink: z
      .string()
      .optional()
      .describe("GCE instance self-link"),
    zone: z
      .string()
      .optional()
      .describe("GCE zone"),
    machineType: z
      .string()
      .optional()
      .describe("GCE machine type name"),
    internalIpAddress: z
      .string()
      .optional()
      .describe("Internal/private IPv4 address (GCloud VPC)"),

    // AWS-specific
    availabilityZone: z
      .string()
      .optional()
      .describe("AWS availability zone"),
    instanceType: z
      .string()
      .optional()
      .describe("AWS EC2 instance type"),
    privateIpAddress: z
      .string()
      .optional()
      .describe("AWS private IPv4 address"),
  }),
});

// ---- Hetzner Provider Implementation ----

component.implement(CloudProvider.hetzner, {
  stateSchema: z.object({
    ipv4Address: z.string().optional(),
    ipv6Address: z.string().optional(),
  }),
  initialState: {},

  pulumi: async ({ $, inputs, state, hetzner: provider }) => {
    // Common fields
    const serverType = inputs.machineSize;
    const location = inputs.region;
    const image = (inputs.image as string) || "ubuntu-24.04";
    const sshPublicKeys = inputs.sshPublicKeys as string[];
    const userData = inputs.userData as string;
    const startupScript = (inputs.startupScript as string) ?? "";
    const labels = inputs.labels;
    const deleteProtection = inputs.deletionProtection;

    // Build effective userData with startupScript merged via cloud-init.
    // Empty SSH keys array: Hetzner handles SSH via hcloud.SshKey resources, not cloud-init.
    const effectiveUserData = buildUserData([], userData, startupScript);

    // Hetzner-applicable fields (flat schema, read directly)
    const ipv4Enabled = inputs.ipv4Enabled as boolean;
    const ipv6Enabled = inputs.ipv6Enabled as boolean;
    const firewallRules = (inputs.firewallRules ?? []) as any[];
    const backups = inputs.backups as boolean;
    const rebuildProtection = inputs.rebuildProtection as boolean;
    const keepDisk = inputs.keepDisk as boolean;
    const shutdownBeforeDeletion = inputs.shutdownBeforeDeletion as boolean;

    const providerOpts: pulumi.CustomResourceOptions = { provider };

    // ---- 1. SSH Keys ----

    const sshKeyResources: hcloud.SshKey[] = [];
    for (let i = 0; i < sshPublicKeys.length; i++) {
      const key = new hcloud.SshKey($`ssh-key-${i}`, {
        name: $`ssh-key-${i}`,
        publicKey: sshPublicKeys[i],
      }, providerOpts);
      sshKeyResources.push(key);
    }

    const sshKeyNames = sshKeyResources.map((k) => k.name);

    // ---- 2. Primary IPs (stable public addresses) ----

    let primaryIpv4: hcloud.PrimaryIp | undefined;
    if (ipv4Enabled) {
      primaryIpv4 = new hcloud.PrimaryIp($`ipv4`, {
        name: $`ipv4`,
        type: "ipv4",
        assigneeType: "server",
        autoDelete: false,
        location: location as pulumi.Input<string>,
        labels: labels as pulumi.Input<Record<string, pulumi.Input<string>>>,
      }, providerOpts);
    }

    let primaryIpv6: hcloud.PrimaryIp | undefined;
    if (ipv6Enabled) {
      primaryIpv6 = new hcloud.PrimaryIp($`ipv6`, {
        name: $`ipv6`,
        type: "ipv6",
        assigneeType: "server",
        autoDelete: false,
        location: location as pulumi.Input<string>,
        labels: labels as pulumi.Input<Record<string, pulumi.Input<string>>>,
      }, providerOpts);
    }

    // ---- 3. Firewall (optional) ----

    let firewallId: pulumi.Output<number> | undefined;
    if (firewallRules.length > 0) {
      const firewall = new hcloud.Firewall($`firewall`, {
        name: $`firewall`,
        labels: labels as pulumi.Input<Record<string, pulumi.Input<string>>>,
        rules: firewallRules.map((rule: any) => ({
          direction: rule.direction,
          protocol: rule.protocol,
          port: rule.port,
          sourceIps: rule.sourceRanges,
          destinationIps: rule.destinationRanges,
          description: rule.description,
        })),
      }, providerOpts);
      firewallId = firewall.id.apply((id) => Number(id));
    }

    // ---- 4. Server ----

    const publicNets: pulumi.Input<hcloud.types.input.ServerPublicNet>[] = [];
    if (primaryIpv4 || primaryIpv6) {
      publicNets.push({
        ipv4Enabled: ipv4Enabled as pulumi.Input<boolean>,
        ipv4: primaryIpv4
          ? primaryIpv4.id.apply((id) => Number(id))
          : undefined,
        ipv6Enabled: ipv6Enabled as pulumi.Input<boolean>,
        ipv6: primaryIpv6
          ? primaryIpv6.id.apply((id) => Number(id))
          : undefined,
      });
    } else {
      publicNets.push({
        ipv4Enabled: false,
        ipv6Enabled: false,
      });
    }

    const serverName = $`server`;

    const server = new hcloud.Server(serverName, {
      name: serverName,
      serverType: serverType as pulumi.Input<string>,
      image: image as pulumi.Input<string>,
      location: location as pulumi.Input<string>,
      sshKeys: sshKeyNames.length > 0 ? sshKeyNames : undefined,
      userData: (effectiveUserData || undefined) as pulumi.Input<string | undefined>,
      publicNets: publicNets,
      firewallIds: firewallId ? [firewallId] : undefined,
      labels: labels as pulumi.Input<Record<string, pulumi.Input<string>>>,
      backups: backups as pulumi.Input<boolean>,
      deleteProtection: deleteProtection as pulumi.Input<boolean>,
      rebuildProtection: rebuildProtection as pulumi.Input<boolean>,
      keepDisk: keepDisk as pulumi.Input<boolean>,
      shutdownBeforeDeletion: shutdownBeforeDeletion as pulumi.Input<boolean>,
    }, {
      ...providerOpts,
      dependsOn: [
        ...(primaryIpv4 ? [primaryIpv4] : []),
        ...(primaryIpv6 ? [primaryIpv6] : []),
        ...sshKeyResources,
      ],
    });

    // ---- 5. Populate state for connect handler ----

    state.ipv4Address = primaryIpv4
      ? primaryIpv4.ipAddress
      : server.ipv4Address;
    state.ipv6Address = primaryIpv6
      ? primaryIpv6.ipAddress
      : server.ipv6Address;

    // ---- 6. Return outputs ----

    return {
      name: server.name,
      status: server.status,
      ipv4Address: primaryIpv4
        ? primaryIpv4.ipAddress
        : ipv4Enabled
          ? server.ipv4Address
          : pulumi.output(undefined),
      serverId: server.id,
      ipv6Address: primaryIpv6
        ? primaryIpv6.ipAddress
        : ipv6Enabled
          ? server.ipv6Address
          : pulumi.output(undefined),
      location: server.location,
      serverType: server.serverType,
    };
  },

  connect: (({ state }: any) => [
    connectionHandler({
      interface: PublicCI,
      handler: async (_ctx: any) => {
        const ip = state.ipv4Address;
        if (!ip) {
          throw new Error(
            "vm (hetzner): no public IPv4 address available. " +
              "Ensure assignPublicIp is true or ipv4Enabled is true in the component config.",
          );
        }
        return {
          uri: pulumi.output(ip as string),
          metadata: {
            appComponentType: "server",
            host: ip as string,
            protocol: "https" as const,
          },
        };
      },
    }),
  ]) as any,
});

// ---- GCloud Provider Implementation ----

component.implement(CloudProvider.gcloud, {
  stateSchema: z.object({
    ipv4Address: z.string().optional(),
    internalIpAddress: z.string().optional(),
  }),
  initialState: {},

  pulumi: async ({ $, inputs, state, gcp: provider }) => {
    // Common fields
    const machineType = inputs.machineSize;
    const zone = inputs.region;
    const sshPublicKeys = inputs.sshPublicKeys as string[];
    const userData = inputs.userData;
    const startupScript = inputs.startupScript as string | undefined;
    const assignExternalIp = inputs.assignPublicIp;
    const labels = inputs.labels as Record<string, string>;
    const deletionProtection = inputs.deletionProtection;

    // GCloud-applicable fields (flat schema, read directly with concept-level names)
    const imageFamily = inputs.imageFamily as string;
    const imageProject = inputs.imageProject as string;
    const bootDiskSizeGb = inputs.bootDiskSizeGb;
    const bootDiskType = inputs.bootDiskType as string;
    const sshUser = inputs.sshUser as string;
    const networkId = inputs.networkId;
    const subnetId = inputs.subnetId;
    const networkTags = (inputs.networkTags ?? []) as string[];
    const canIpForward = inputs.canIpForward as boolean;
    const networkTier = inputs.networkTier as string;
    const firewallRules = (inputs.firewallRules ?? []) as any[];
    const preemptible = inputs.preemptible as boolean;
    const automaticRestart = inputs.automaticRestart as boolean;
    const onHostMaintenance = inputs.onHostMaintenance as string;
    const secureBoot = inputs.secureBoot as boolean;
    const virtualTpm = inputs.virtualTpm as boolean;
    const integrityMonitoring = inputs.integrityMonitoring as boolean;
    const userMetadata = (inputs.instanceMetadata ?? {}) as Record<string, string>;
    const allowStoppingForUpdate = inputs.allowStoppingForUpdate as boolean;
    const desiredStatus = inputs.desiredStatus as string;

    const gcpOpts: pulumi.CustomResourceOptions = { provider };

    // ---- Metadata key collision check ----

    for (const key of RESERVED_METADATA_KEYS) {
      if (key in userMetadata) {
        throw new Error(
          `vm (gcloud): metadata key "${key}" is reserved. ` +
            `Use the dedicated config field instead ` +
            `(sshPublicKeys/sshUser for "ssh-keys", userData for "user-data", ` +
            `startupScript for "startup-script").`,
        );
      }
    }

    // ---- Layer 0: Static IP, Firewall, Boot Image (parallel) ----

    // 0a. Static IP
    let staticIp: gcp.compute.Address | undefined;
    if (assignExternalIp) {
      const ipRegion = (zone as string).replace(/-[a-z]$/, "");
      staticIp = new gcp.compute.Address($`static-ip`, {
        name: $`static-ip`,
        addressType: "EXTERNAL",
        networkTier: networkTier as string,
        region: ipRegion,
      }, gcpOpts);
    }

    // 0b. Firewall
    const fwTargetTag = $`fw-target`;
    if (firewallRules.length > 0) {
      const firewallNetwork = networkId
        ? (networkId as string)
        : "default";

      new gcp.compute.Firewall($`firewall`, {
        name: $`firewall`,
        network: firewallNetwork,
        direction: "INGRESS",
        targetTags: [fwTargetTag],
        allows: firewallRules
          .filter((rule: any) => rule.direction === "in")
          .map((rule: any) => ({
            protocol: rule.protocol,
            ports: rule.port ? [rule.port] : undefined,
          })),
        sourceRanges: (() => {
          const ranges = new Set<string>();
          for (const rule of firewallRules) {
            if (rule.direction === "in" && rule.sourceRanges) {
              for (const r of rule.sourceRanges) {
                ranges.add(r);
              }
            }
          }
          return ranges.size > 0 ? Array.from(ranges) : ["0.0.0.0/0"];
        })(),
        description: "Inline firewall for vm/gcloud (managed by sdlc.works)",
      }, gcpOpts);
    }

    // 0c. Boot image lookup
    const bootImage = gcp.compute.getImageOutput({
      family: imageFamily as string,
      project: imageProject as string,
    }, gcpOpts);

    // ---- Build instance metadata ----

    const instanceMetadata: Record<string, pulumi.Input<string>> = {
      ...userMetadata,
    };

    if (sshPublicKeys.length > 0) {
      instanceMetadata["ssh-keys"] = sshPublicKeys
        .map((key) => `${sshUser}:${key}`)
        .join("\n");
    }

    if (userData) {
      instanceMetadata["user-data"] = userData as string;
    }

    if (startupScript) {
      instanceMetadata["startup-script"] = startupScript as string;
    }

    // ---- Scheduling auto-correction ----

    const effectiveAutomaticRestart = preemptible ? false : (automaticRestart as boolean);
    const effectiveOnHostMaintenance = preemptible ? "TERMINATE" : (onHostMaintenance as string);

    // ---- Merge network tags with firewall target tag ----

    const mergedTags = [
      ...networkTags,
      fwTargetTag,
    ];

    // ---- Layer 1: Instance ----

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
      labels: labels,
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
        enableSecureBoot: secureBoot as boolean,
        enableVtpm: virtualTpm as boolean,
        enableIntegrityMonitoring: integrityMonitoring as boolean,
      },

      metadata: instanceMetadata,

      deletionProtection: deletionProtection as boolean,
      allowStoppingForUpdate: allowStoppingForUpdate as boolean,
      desiredStatus: desiredStatus as string,
    }, {
      ...gcpOpts,
      dependsOn: staticIp ? [staticIp] : [],
      ignoreChanges: ["bootDisk"],
    });

    // ---- Populate state for connect handler ----

    const internalIp = instance.networkInterfaces[0].networkIp;
    const externalIp = staticIp ? staticIp.address : undefined;

    state.ipv4Address = externalIp;
    state.internalIpAddress = internalIp;

    // ---- Return outputs ----

    return {
      name: instance.name,
      status: instance.currentStatus,
      ipv4Address: externalIp
        ? (typeof externalIp === "string"
            ? pulumi.output(externalIp)
            : externalIp)
        : pulumi.output(undefined),
      instanceId: instance.instanceId,
      selfLink: instance.selfLink,
      zone: instance.zone,
      machineType: instance.machineType,
      internalIpAddress: internalIp,
    };
  },

  connect: (({ state }: any) => [
    connectionHandler({
      interface: PublicCI,
      handler: async (_ctx: any) => {
        if (!state.ipv4Address) {
          throw new Error(
            "vm (gcloud): no public IPv4 address available. " +
              "Ensure assignPublicIp is true in the component config.",
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

// ---- AWS Provider Implementation ----

component.implement(CloudProvider.aws, {
  stateSchema: z.object({
    ipv4Address: z.string().optional(),
  }),
  initialState: {},

  pulumi: async ({ $, inputs, state, aws: provider }) => {
    // Common fields
    const instanceType = inputs.machineSize;
    const availabilityZone = inputs.region;
    const amiId = inputs.image as string;
    const sshPublicKeys = inputs.sshPublicKeys as string[];
    const userData = inputs.userData as string;
    const assignPublicIp = inputs.assignPublicIp;
    const tags = inputs.labels as Record<string, string>;
    const deletionProtection = inputs.deletionProtection;

    // AWS-applicable fields (flat schema, read directly with concept-level names)
    const imageFilter = inputs.imageFilter as string;
    const imageFilterOwner = inputs.imageFilterOwner as string;
    const bootDiskSizeGb = (inputs.bootDiskSizeGb as number | undefined) ?? 20;
    const bootDiskType = inputs.bootDiskType as string;
    const bootDiskEncrypted = inputs.bootDiskEncrypted as boolean;
    const keyPairName = inputs.keyPairName as string;
    const subnetId = (inputs.subnetId as string) ?? "";
    const vpcId = (inputs.networkId as string) ?? "";
    const allFirewallRules = (inputs.firewallRules ?? []) as any[];
    const ingressRules = allFirewallRules.filter((r: any) => r.direction === "in");
    const egressRules = allFirewallRules.filter((r: any) => r.direction === "out");
    const requireImdsv2 = inputs.requireImdsv2 as boolean;
    const instanceProfileArn = inputs.instanceProfileArn as string;
    const enableSsmAccess = inputs.enableSsmAccess as boolean;
    const allowStoppingForUpdate = inputs.allowStoppingForUpdate as boolean;

    const awsOpts: pulumi.CustomResourceOptions = { provider };

    // ---- Cross-field validation ----

    if (instanceProfileArn && enableSsmAccess) {
      throw new Error(
        "vm (aws): instanceProfileArn and enableSsmAccess are mutually exclusive. " +
          "When you bring your own instance profile, manage SSM policy on it directly in AWS.",
      );
    }

    // ---- Build effective userData with SSH key injection ----

    const effectiveUserData = buildUserData(
      sshPublicKeys,
      userData,
      (inputs.startupScript as string) ?? "",
    );

    // ---- Merge tags with a component-managed Name tag ----

    const instanceName = $`instance`;
    const baseTags: Record<string, string> = {
      ...tags,
      Name: instanceName,
    };

    // ---- Layer 0a: AMI Lookup (data source, only if amiId is empty) ----

    let ami: pulumi.Input<string>;
    if (amiId) {
      ami = amiId;
    } else {
      const amiLookup = aws.ec2.getAmiOutput(
        {
          mostRecent: true,
          owners: [imageFilterOwner as string],
          filters: [
            {
              name: "name",
              values: [imageFilter as string],
            },
          ],
        },
        awsOpts,
      );
      ami = amiLookup.id;
    }

    // ---- Layer 0b: Elastic IP (only if assignPublicIp) ----

    let eip: aws.ec2.Eip | undefined;
    if (assignPublicIp as boolean) {
      eip = new aws.ec2.Eip($`eip`, {
        domain: "vpc",
        tags: {
          ...baseTags,
          Name: $`eip`,
        },
      }, awsOpts);
    }

    // ---- Layer 0c: Security Group ----

    const sg = new aws.ec2.SecurityGroup($`sg`, {
      name: $`sg`,
      description: "Managed by sdlc.works vm component",
      ...(vpcId ? { vpcId: vpcId as string } : {}),
      ingress: ingressRules.map((rule: any) => {
        const { fromPort, toPort } = parsePortRange(rule.port);
        return {
          protocol: rule.protocol,
          fromPort,
          toPort,
          cidrBlocks: rule.sourceRanges,
          description: rule.description,
        };
      }),
      egress:
        egressRules.length > 0
          ? egressRules.map((rule: any) => {
              const { fromPort, toPort } = parsePortRange(rule.port);
              return {
                protocol: rule.protocol,
                fromPort,
                toPort,
                cidrBlocks: rule.destinationRanges,
                description: rule.description,
              };
            })
          : [
              {
                protocol: "-1",
                fromPort: 0,
                toPort: 0,
                cidrBlocks: ["0.0.0.0/0"],
                description: "Allow all outbound (default)",
              },
            ],
      revokeRulesOnDelete: true,
      tags: {
        ...baseTags,
        Name: $`sg`,
      },
    }, awsOpts);

    // ---- Layer 0d: IAM Role + Instance Profile (conditional) ----

    let effectiveInstanceProfileName: pulumi.Input<string> | undefined;

    if (instanceProfileArn) {
      effectiveInstanceProfileName = instanceProfileArn as string;
    } else {
      const role = new aws.iam.Role($`role`, {
        name: $`role`,
        assumeRolePolicy: JSON.stringify({
          Version: "2012-10-17",
          Statement: [
            {
              Effect: "Allow",
              Principal: { Service: EC2_SERVICE_PRINCIPAL },
              Action: "sts:AssumeRole",
            },
          ],
        }),
        tags: baseTags,
      }, awsOpts);

      if (enableSsmAccess) {
        new aws.iam.RolePolicyAttachment($`ssm-policy`, {
          role: role.name,
          policyArn: SSM_MANAGED_POLICY_ARN,
        }, awsOpts);
      }

      const instanceProfile = new aws.iam.InstanceProfile($`instance-profile`, {
        name: $`instance-profile`,
        role: role.name,
        tags: baseTags,
      }, awsOpts);

      effectiveInstanceProfileName = instanceProfile.name;
    }

    // ---- Layer 1: EC2 Instance ----

    const instance = new aws.ec2.Instance(instanceName, {
      instanceType: instanceType as string,
      ami,
      ...(availabilityZone as string
        ? { availabilityZone: availabilityZone as string }
        : {}),
      ...(keyPairName
        ? { keyName: keyPairName as string }
        : {}),
      ...(subnetId
        ? { subnetId: subnetId as string }
        : {}),
      iamInstanceProfile: effectiveInstanceProfileName,
      vpcSecurityGroupIds: [sg.id],
      userData: effectiveUserData || undefined,

      rootBlockDevice: {
        volumeSize: bootDiskSizeGb as number,
        volumeType: bootDiskType as string,
        encrypted: bootDiskEncrypted as boolean,
        tags: {
          ...baseTags,
          Name: $`root-volume`,
        },
      },

      metadataOptions: {
        httpTokens: requireImdsv2 ? "required" : "optional",
        httpEndpoint: "enabled",
      },

      disableApiTermination: deletionProtection as boolean,

      tags: baseTags,
    }, {
      ...awsOpts,
      ignoreChanges: ["ami", "userData"],
    });

    // suppress unused variable warning
    void allowStoppingForUpdate;

    // ---- Layer 2: EIP Association (only if assignPublicIp) ----

    if (eip) {
      new aws.ec2.EipAssociation($`eip-assoc`, {
        allocationId: eip.allocationId,
        instanceId: instance.id,
      }, awsOpts);
    }

    // ---- Populate state for connect handler ----

    state.ipv4Address = eip ? eip.publicIp : undefined;

    // ---- Return outputs ----

    return {
      name: instance.tags.apply((t) => t?.Name ?? instanceName),
      status: instance.instanceState,
      ipv4Address: eip
        ? eip.publicIp
        : pulumi.output(undefined),
      instanceId: instance.id,
      availabilityZone: instance.availabilityZone,
      instanceType: instance.instanceType,
      privateIpAddress: instance.privateIp,
    };
  },

  connect: (({ state }: any) => [
    connectionHandler({
      interface: PublicCI,
      handler: async (_ctx: any) => {
        if (!state.ipv4Address) {
          throw new Error(
            "vm (aws): no public IPv4 address available. " +
              "Ensure assignPublicIp is true in the component config.",
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
