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
 *   8 common top-level fields + 3 optional provider sub-objects
 *   (hetzner, gcloud, aws). Experience layers render only the common
 *   fields + the sub-object matching the bound integration.
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

// ---- Zod Schemas: Hetzner Firewall Rules ----

const HetznerFirewallRuleSchema = z.object({
  direction: z.enum(["in", "out"]),
  protocol: z.enum(["tcp", "udp", "icmp", "gre", "esp"]),
  port: z
    .string()
    .optional()
    .describe(
      'Port or port range. Required for tcp/udp. Examples: "22", "80", "8000-9000", "any"',
    ),
  sourceIps: z
    .array(z.string())
    .optional()
    .describe(
      'CIDRs allowed for inbound rules. Example: ["0.0.0.0/0", "::/0"]',
    ),
  destinationIps: z
    .array(z.string())
    .optional()
    .describe(
      'CIDRs allowed for outbound rules. Example: ["0.0.0.0/0", "::/0"]',
    ),
  description: z.string().optional(),
});

// ---- Zod Schemas: GCloud Firewall Rules ----

const GCloudFirewallRuleSchema = z.object({
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
        "NOTE: GCE aggregates sourceRanges across all rules into one firewall.",
    ),
  description: z.string().optional(),
});

// ---- Zod Schemas: AWS Firewall Rules ----

const AwsIngressRuleSchema = z.object({
  protocol: z
    .string()
    .describe(
      '"tcp", "udp", "icmp", or "-1" for all protocols. ' +
        "When -1, fromPort/toPort are ignored.",
    ),
  fromPort: z
    .number()
    .describe(
      "Start of port range (inclusive). For ICMP: the ICMP type number.",
    ),
  toPort: z
    .number()
    .describe(
      "End of port range (inclusive). For ICMP: the ICMP code number.",
    ),
  sourceRanges: z
    .array(z.string())
    .describe('Source CIDRs for inbound traffic. Example: ["0.0.0.0/0"].'),
  description: z.string().optional(),
});

const AwsEgressRuleSchema = z.object({
  protocol: z
    .string()
    .describe(
      '"tcp", "udp", "icmp", or "-1" for all protocols. ' +
        "When -1, fromPort/toPort are ignored.",
    ),
  fromPort: z
    .number()
    .describe(
      "Start of port range (inclusive). For ICMP: the ICMP type number.",
    ),
  toPort: z
    .number()
    .describe(
      "End of port range (inclusive). For ICMP: the ICMP code number.",
    ),
  destinationRanges: z
    .array(z.string())
    .describe(
      'Destination CIDRs for outbound traffic. Example: ["0.0.0.0/0"].',
    ),
  description: z.string().optional(),
});

// ---- AWS Helper: buildUserData ----

/**
 * Build a cloud-init user data string that injects SSH public keys.
 * If the user already provided userData, this wraps it as a multipart
 * cloud-init document. If not, it produces a minimal #cloud-config.
 *
 * Returns empty string when there are no SSH keys and no user-provided userData.
 */
function buildUserData(
  sshPublicKeys: string[],
  rawUserData: string,
): string {
  if (sshPublicKeys.length === 0 && !rawUserData) {
    return "";
  }

  // If the user provided their own userData and there are no SSH keys to inject,
  // pass it through unchanged.
  if (sshPublicKeys.length === 0) {
    return rawUserData;
  }

  // Build a #cloud-config that injects SSH keys.
  const sshBlock = [
    "#cloud-config",
    "ssh_authorized_keys:",
    ...sshPublicKeys.map((k) => `  - ${k}`),
  ].join("\n");

  if (!rawUserData) {
    return sshBlock;
  }

  // Both SSH keys and user-provided userData exist. Use MIME multipart
  // to combine them so cloud-init processes both.
  const parts = [
    `Content-Type: multipart/mixed; boundary="${MULTIPART_BOUNDARY}"`,
    `MIME-Version: 1.0`,
    ``,
    `--${MULTIPART_BOUNDARY}`,
    `Content-Type: text/cloud-config; charset="utf-8"`,
    `MIME-Version: 1.0`,
    ``,
    sshBlock,
    ``,
    `--${MULTIPART_BOUNDARY}`,
    // Detect content type from the user's userData.
    rawUserData.startsWith("#cloud-config")
      ? `Content-Type: text/cloud-config; charset="utf-8"`
      : rawUserData.startsWith("#!/")
        ? `Content-Type: text/x-shellscript; charset="utf-8"`
        : `Content-Type: text/cloud-config; charset="utf-8"`,
    `MIME-Version: 1.0`,
    ``,
    rawUserData,
    ``,
    `--${MULTIPART_BOUNDARY}--`,
  ].join("\n");
  return parts;
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
    // ---- Common Fields (8) ----

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

    image: z
      .string()
      .default("")
      .describe(
        "Direct image ID/name. When empty, provider-specific defaults apply: " +
          'Hetzner defaults to "ubuntu-24.04", GCloud uses imageFamily lookup, ' +
          "AWS uses amiFilter lookup. " +
          "WARNING: changing this value DESTROYS AND RECREATES the VM.",
      ),

    sshPublicKeys: z
      .array(z.string())
      .default([])
      .describe(
        'SSH public key strings (e.g. "ssh-ed25519 AAAA..."). ' +
          "Injection mechanism is provider-specific: Hetzner creates hcloud.SshKey resources, " +
          "GCloud injects via instance metadata, AWS injects via cloud-init.",
      ),

    userData: z
      .string()
      .default("")
      .describe(
        "Cloud-init user data (typically a #cloud-config YAML document). " +
          "Supported by all three providers.",
      ),

    assignPublicIp: z
      .boolean()
      .describe(
        "Create a stable public IP. " +
          "Hetzner: PrimaryIp (v4). GCloud: compute.Address. AWS: Elastic IP.",
      ),

    deletionProtection: z
      .boolean()
      .default(false)
      .describe(
        "Prevent accidental deletion. " +
          "Hetzner: deleteProtection. GCloud: deletionProtection. AWS: disableApiTermination.",
      ),

    labels: z
      .record(z.string(), z.string())
      .default({})
      .describe(
        "Resource labels/tags (key-value pairs). " +
          "Hetzner: labels. GCloud: labels. AWS: tags. In-place update on all providers.",
      ),

    // ---- Hetzner-Specific Sub-Object ----

    hetzner: z.object({
      ipv4Enabled: z
        .boolean()
        .default(true)
        .describe("Enable public IPv4. When true, a stable PrimaryIp is created and attached."),

      ipv6Enabled: z
        .boolean()
        .default(true)
        .describe("Enable public IPv6. When true, a stable PrimaryIp is created and attached."),

      firewallRules: z
        .array(HetznerFirewallRuleSchema)
        .default([])
        .describe(
          "Inline firewall rules. Creates one hcloud.Firewall attached to this server.",
        ),

      backups: z
        .boolean()
        .default(false)
        .describe("Enable automatic backups."),

      rebuildProtection: z
        .boolean()
        .default(false)
        .describe("Enable rebuild protection. Hetzner-specific (no analogue on other providers)."),

      keepDisk: z
        .boolean()
        .default(false)
        .describe("Do not resize disk when changing machineSize. Allows future downgrades."),

      shutdownBeforeDeletion: z
        .boolean()
        .default(true)
        .describe("Gracefully shut down before deleting."),
    }).optional(),

    // ---- GCloud-Specific Sub-Object ----

    gcloud: z.object({
      imageFamily: z
        .string()
        .default("ubuntu-2404-lts-amd64")
        .describe("Boot disk image family. Resolved once at creation."),

      imageProject: z
        .string()
        .default("ubuntu-os-cloud")
        .describe("GCP project hosting the boot disk image family."),

      bootDiskSizeGb: z
        .number()
        .min(10)
        .max(65536)
        .describe("Boot disk size in GB. WARNING: DESTROYS AND RECREATES the VM."),

      bootDiskType: z
        .enum(["pd-standard", "pd-balanced", "pd-ssd", "pd-extreme"])
        .default("pd-balanced")
        .describe("Boot disk type. WARNING: DESTROYS AND RECREATES the VM."),

      sshUser: z
        .string()
        .default("sdlc")
        .describe("Username for SSH keys in GCE metadata."),

      startupScript: z
        .string()
        .optional()
        .describe("GCE startup script (metadata 'startup-script'). Runs on every boot."),

      networkId: z
        .string()
        .optional()
        .describe("VPC network self-link or ID. Omit for default network."),

      subnetId: z
        .string()
        .optional()
        .describe("Subnet self-link or ID. Omit for auto-select."),

      networkTags: z
        .array(z.string())
        .default([])
        .describe("GCE network tags."),

      canIpForward: z
        .boolean()
        .default(false)
        .describe("Enable IP forwarding. WARNING: DESTROYS AND RECREATES."),

      networkTier: z
        .enum(["PREMIUM", "STANDARD"])
        .default("PREMIUM")
        .describe("Network tier for external IP."),

      firewallRules: z
        .array(GCloudFirewallRuleSchema)
        .describe(
          "Inline INGRESS firewall rules. Creates one gcp.compute.Firewall targeting this VM " +
            "via a deterministic network tag.",
        ),

      preemptible: z
        .boolean()
        .default(false)
        .describe(
          "Use preemptible VM. Forces automaticRestart=false, onHostMaintenance=TERMINATE.",
        ),

      automaticRestart: z
        .boolean()
        .default(true)
        .describe("Auto-restart on host failure. Forced false when preemptible=true."),

      onHostMaintenance: z
        .enum(["MIGRATE", "TERMINATE"])
        .default("MIGRATE")
        .describe("Host maintenance behaviour. Forced TERMINATE when preemptible=true."),

      enableSecureBoot: z
        .boolean()
        .default(false)
        .describe("Enable Secure Boot (Shielded VM)."),

      enableVtpm: z
        .boolean()
        .default(false)
        .describe("Enable vTPM (Shielded VM)."),

      enableIntegrityMonitoring: z
        .boolean()
        .default(false)
        .describe("Enable integrity monitoring (Shielded VM)."),

      metadata: z
        .record(z.string(), z.string())
        .default({})
        .describe(
          "Additional GCE instance metadata. Reserved keys (ssh-keys, user-data, startup-script) rejected.",
        ),

      allowStoppingForUpdate: z
        .boolean()
        .default(true)
        .describe("Allow stopping VM for in-place updates (e.g. machineType resize)."),

      desiredStatus: z
        .enum(["RUNNING", "TERMINATED"])
        .default("RUNNING")
        .describe("Desired VM status. TERMINATED stops without destroying."),
    }).optional(),

    // ---- AWS-Specific Sub-Object ----

    aws: z.object({
      amiFilter: z
        .string()
        .default(DEFAULT_AMI_FILTER)
        .describe(
          "AMI name filter for automatic resolution. Only used when common image field is empty.",
        ),

      amiOwner: z
        .string()
        .default(DEFAULT_AMI_OWNER)
        .describe("AWS account ID that owns the AMI. Only used when image is empty."),

      rootVolumeSizeGb: z
        .number()
        .min(8)
        .max(16384)
        .default(20)
        .describe("Root EBS volume size in GB."),

      rootVolumeType: z
        .enum(["gp3", "gp2", "io1", "io2"])
        .default("gp3")
        .describe("Root EBS volume type."),

      rootVolumeEncrypted: z
        .boolean()
        .default(true)
        .describe("Encrypt root EBS volume. WARNING: changing DESTROYS AND RECREATES."),

      keyPairName: z
        .string()
        .default("")
        .describe("Name of an existing EC2 Key Pair. Does NOT create a key pair."),

      subnetId: z
        .string()
        .default("")
        .describe("EC2 subnet ID. Empty = default subnet."),

      vpcId: z
        .string()
        .default("")
        .describe("VPC ID for Security Group. Empty = default VPC."),

      firewallRules: z
        .array(AwsIngressRuleSchema)
        .default([])
        .describe("Ingress firewall rules for Security Group. Empty = deny all inbound."),

      egressRules: z
        .array(AwsEgressRuleSchema)
        .default([])
        .describe("Egress firewall rules. Empty = allow ALL outbound."),

      requireImdsv2: z
        .boolean()
        .default(true)
        .describe("Enforce IMDSv2 (HttpTokens='required'). Security best practice."),

      instanceProfileArn: z
        .string()
        .default("")
        .describe(
          "ARN of existing IAM instance profile. When set, component creates NO IAM resources.",
        ),

      enableSsmAccess: z
        .boolean()
        .default(false)
        .describe(
          "Attach SSM managed policy to component-created IAM role. Only when instanceProfileArn is empty.",
        ),

      allowStoppingForUpdate: z
        .boolean()
        .default(true)
        .describe("Allow Pulumi to stop instance for in-place updates."),
    }).optional(),
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
    const userData = inputs.userData;
    const labels = inputs.labels;
    const deleteProtection = inputs.deletionProtection;

    // Hetzner-specific fields (from sub-object with defaults)
    const h = inputs.hetzner as any ?? {};
    const ipv4Enabled = h.ipv4Enabled ?? (inputs.assignPublicIp as boolean);
    const ipv6Enabled = h.ipv6Enabled ?? true;
    const firewallRules = (h.firewallRules ?? []) as any[];
    const backups = h.backups ?? false;
    const rebuildProtection = h.rebuildProtection ?? false;
    const keepDisk = h.keepDisk ?? false;
    const shutdownBeforeDeletion = h.shutdownBeforeDeletion ?? true;

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
          sourceIps: rule.sourceIps,
          destinationIps: rule.destinationIps,
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
      userData: userData as pulumi.Input<string | undefined>,
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
              "Ensure assignPublicIp is true or hetzner.ipv4Enabled is true in the component config.",
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
    const assignExternalIp = inputs.assignPublicIp;
    const labels = inputs.labels as Record<string, string>;
    const deletionProtection = inputs.deletionProtection;

    // GCloud-specific fields (from sub-object)
    const g = inputs.gcloud as any ?? {};
    const imageFamily = g.imageFamily ?? "ubuntu-2404-lts-amd64";
    const imageProject = g.imageProject ?? "ubuntu-os-cloud";
    const bootDiskSizeGb = g.bootDiskSizeGb;
    const bootDiskType = g.bootDiskType ?? "pd-balanced";
    const sshUser = g.sshUser ?? "sdlc";
    const startupScript = g.startupScript;
    const networkId = g.networkId;
    const subnetId = g.subnetId;
    const networkTags = (g.networkTags ?? []) as string[];
    const canIpForward = g.canIpForward ?? false;
    const networkTier = g.networkTier ?? "PREMIUM";
    const firewallRules = (g.firewallRules ?? []) as any[];
    const preemptible = g.preemptible ?? false;
    const automaticRestart = g.automaticRestart ?? true;
    const onHostMaintenance = g.onHostMaintenance ?? "MIGRATE";
    const enableSecureBoot = g.enableSecureBoot ?? false;
    const enableVtpm = g.enableVtpm ?? false;
    const enableIntegrityMonitoring = g.enableIntegrityMonitoring ?? false;
    const userMetadata = (g.metadata ?? {}) as Record<string, string>;
    const allowStoppingForUpdate = g.allowStoppingForUpdate ?? true;
    const desiredStatus = g.desiredStatus ?? "RUNNING";

    const gcpOpts: pulumi.CustomResourceOptions = { provider };

    // ---- Metadata key collision check ----

    for (const key of RESERVED_METADATA_KEYS) {
      if (key in userMetadata) {
        throw new Error(
          `vm (gcloud): metadata key "${key}" is reserved. ` +
            `Use the dedicated config field instead ` +
            `(sshPublicKeys/gcloud.sshUser for "ssh-keys", userData for "user-data", ` +
            `gcloud.startupScript for "startup-script").`,
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
        allows: firewallRules.map((rule: any) => ({
          protocol: rule.protocol,
          ports: rule.ports,
        })),
        sourceRanges: (() => {
          const ranges = new Set<string>();
          for (const rule of firewallRules) {
            if (rule.sourceRanges) {
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

    // AWS-specific fields (from sub-object)
    const a = inputs.aws as any ?? {};
    const amiFilter = a.amiFilter ?? DEFAULT_AMI_FILTER;
    const amiOwner = a.amiOwner ?? DEFAULT_AMI_OWNER;
    const rootVolumeSizeGb = a.rootVolumeSizeGb ?? 20;
    const rootVolumeType = a.rootVolumeType ?? "gp3";
    const rootVolumeEncrypted = a.rootVolumeEncrypted ?? true;
    const keyPairName = a.keyPairName ?? "";
    const subnetId = a.subnetId ?? "";
    const vpcId = a.vpcId ?? "";
    const firewallRules = (a.firewallRules ?? []) as any[];
    const egressRules = (a.egressRules ?? []) as any[];
    const requireImdsv2 = a.requireImdsv2 ?? true;
    const instanceProfileArn = a.instanceProfileArn ?? "";
    const enableSsmAccess = a.enableSsmAccess ?? false;
    const allowStoppingForUpdate = a.allowStoppingForUpdate ?? true;

    const awsOpts: pulumi.CustomResourceOptions = { provider };

    // ---- Cross-field validation ----

    if (instanceProfileArn && enableSsmAccess) {
      throw new Error(
        "vm (aws): instanceProfileArn and enableSsmAccess are mutually exclusive. " +
          "When you bring your own instance profile, manage SSM policy on it directly in AWS.",
      );
    }

    // ---- Build effective userData with SSH key injection ----

    const effectiveUserData = buildUserData(sshPublicKeys, userData);

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
          owners: [amiOwner as string],
          filters: [
            {
              name: "name",
              values: [amiFilter as string],
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
      ingress: firewallRules.map((rule: any) => ({
        protocol: rule.protocol,
        fromPort: rule.fromPort,
        toPort: rule.toPort,
        cidrBlocks: rule.sourceRanges,
        description: rule.description,
      })),
      egress:
        egressRules.length > 0
          ? egressRules.map((rule: any) => ({
              protocol: rule.protocol,
              fromPort: rule.fromPort,
              toPort: rule.toPort,
              cidrBlocks: rule.destinationRanges,
              description: rule.description,
            }))
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
        volumeSize: rootVolumeSizeGb as number,
        volumeType: rootVolumeType as string,
        encrypted: rootVolumeEncrypted as boolean,
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
