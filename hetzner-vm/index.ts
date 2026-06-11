import { z } from "zod";

import {
  CloudProvider,
  InfraComponent,
  connectionHandler,
} from "@sdlcworks/components";

import * as hcloud from "@pulumi/hcloud";
import * as pulumi from "@pulumi/pulumi";

import { PublicCI } from "../_internal/interfaces";

// ---- Zod Schemas for Config ----

const FirewallRuleDirection = z.enum(["in", "out"]);
const FirewallRuleProtocol = z.enum(["tcp", "udp", "icmp", "gre", "esp"]);

const FirewallRuleSchema = z.object({
  direction: FirewallRuleDirection,
  protocol: FirewallRuleProtocol,
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

// ---- Component Definition ----

const component = new InfraComponent({
  metadata: {
    stateful: true,
    proxiable: false,
  },
  connectionTypes: {
    public: {
      description:
        "exposes the server via its public IPv4 address for external access",
      interface: PublicCI,
    },
  } as const,
  connectionInterfaces: [],
  configSchema: z.object({
    // ---- Server Core ----

    serverType: z
      .string()
      .default("cx22")
      .describe(
        'Hetzner server type name. Examples: "cx22", "cx32", "cx42", "cpx11", "cax11" (ARM). ' +
          "In-place resize: the server is stopped, resized, and restarted. " +
          "Set keepDisk=true to allow future downgrades.",
      ),

    image: z
      .string()
      .default("ubuntu-24.04")
      .describe(
        'OS image name or ID. Examples: "ubuntu-24.04", "debian-12", "fedora-41", "rocky-9". ' +
          "WARNING: changing this value DESTROYS and RECREATES the server.",
      ),

    location: z
      .string()
      .default("nbg1")
      .describe(
        'Hetzner location name. Options: "nbg1" (Nuremberg), "fsn1" (Falkenstein), ' +
          '"hel1" (Helsinki), "ash" (Ashburn), "hil" (Hillsboro), "sin" (Singapore). ' +
          "WARNING: changing this value DESTROYS and RECREATES the server.",
      ),

    // ---- SSH Keys ----
    //
    // Raw public key strings. Each one creates an hcloud.SshKey resource and is
    // injected into the server at creation time.
    //
    // WARNING: changing this list DESTROYS and RECREATES the server (Hetzner
    // limitation -- SSH keys are baked in at creation).

    sshPublicKeys: z
      .array(z.string())
      .default([])
      .describe(
        "SSH public key strings (e.g. 'ssh-ed25519 AAAA...'). Each creates a managed " +
          "hcloud.SshKey resource. WARNING: changing this list DESTROYS and RECREATES the server.",
      ),

    // ---- Cloud-Init ----

    userData: z
      .string()
      .optional()
      .describe(
        "Cloud-init user data string (typically a #cloud-config YAML document). " +
          "WARNING: changing this value DESTROYS and RECREATES the server.",
      ),

    // ---- Networking ----

    ipv4Enabled: z
      .boolean()
      .default(true)
      .describe("Enable public IPv4. When true, a stable PrimaryIp is created and attached."),

    ipv6Enabled: z
      .boolean()
      .default(true)
      .describe("Enable public IPv6. When true, a stable PrimaryIp is created and attached."),

    // ---- Firewall ----
    //
    // Inline firewall rules. When non-empty, creates one hcloud.Firewall resource
    // attached to this server. For complex multi-server firewall setups, use a
    // separate firewall component (out of scope for v1).

    firewallRules: z
      .array(FirewallRuleSchema)
      .default([])
      .describe(
        "Inline firewall rules. Creates one managed hcloud.Firewall attached to " +
          "this server. Leave empty for no firewall (all traffic allowed by default). " +
          "Changes to rules are non-destructive (in-place update).",
      ),

    // ---- Labels ----

    labels: z
      .record(z.string(), z.string())
      .default({})
      .describe(
        "Hetzner Cloud labels (key-value pairs). In-place update, safe to change.",
      ),

    // ---- Protection & Behavior ----

    backups: z
      .boolean()
      .default(false)
      .describe("Enable automatic backups. In-place update, safe to toggle."),

    deleteProtection: z
      .boolean()
      .default(false)
      .describe(
        "Enable delete protection. Must match rebuildProtection. In-place update.",
      ),

    rebuildProtection: z
      .boolean()
      .default(false)
      .describe(
        "Enable rebuild protection. Must match deleteProtection. In-place update.",
      ),

    keepDisk: z
      .boolean()
      .default(false)
      .describe(
        "If true, do not resize the disk when changing serverType. " +
          "This allows downgrading the server type later. In-place update.",
      ),

    shutdownBeforeDeletion: z
      .boolean()
      .default(true)
      .describe(
        "Whether to try shutting the server down gracefully before deleting it.",
      ),
  }),
  appComponentTypes: {},
  outputSchema: z.object({
    serverId: z.string().describe("Hetzner server ID"),
    name: z.string().describe("Server name (derived from $ naming)"),
    ipv4Address: z
      .string()
      .optional()
      .describe("Public IPv4 address (from PrimaryIp when ipv4Enabled)"),
    ipv6Address: z
      .string()
      .optional()
      .describe("First IPv6 address (from PrimaryIp when ipv6Enabled)"),
    status: z.string().describe("Server status (e.g. running, off)"),
    location: z.string().describe("Location where the server was created"),
    serverType: z.string().describe("Server type name"),
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
    const {
      serverType,
      image,
      location,
      sshPublicKeys,
      userData,
      ipv4Enabled,
      ipv6Enabled,
      firewallRules,
      labels,
      backups,
      deleteProtection,
      rebuildProtection,
      keepDisk,
      shutdownBeforeDeletion,
    } = inputs;

    const providerOpts: pulumi.CustomResourceOptions = { provider };

    // ---- 1. SSH Keys ----
    //
    // Each raw public key string becomes a managed hcloud.SshKey resource.
    // The resource names are passed to the Server's sshKeys arg.

    const sshKeyResources: hcloud.SshKey[] = [];
    for (let i = 0; i < (sshPublicKeys as string[]).length; i++) {
      const key = new hcloud.SshKey($`ssh-key-${i}`, {
        name: $`ssh-key-${i}`,
        publicKey: (sshPublicKeys as string[])[i],
      }, providerOpts);
      sshKeyResources.push(key);
    }

    const sshKeyNames = sshKeyResources.map((k) => k.name);

    // ---- 2. Primary IPs (stable public addresses) ----
    //
    // PrimaryIps are created independently from the server so the IP address
    // survives server replacement (e.g. image change). The PrimaryIp is then
    // linked to the server via publicNets.

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
    if ((firewallRules as any[]).length > 0) {
      const firewall = new hcloud.Firewall($`firewall`, {
        name: $`firewall`,
        labels: labels as pulumi.Input<Record<string, pulumi.Input<string>>>,
        rules: (firewallRules as any[]).map((rule: any) => ({
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
    //
    // publicNets links the PrimaryIps to the server. When a PrimaryIp is
    // assigned, the server gets a stable address that persists across rebuilds.

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
      // Both disabled: explicitly disable both
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
      serverId: server.id,
      name: server.name,
      ipv4Address: primaryIpv4
        ? primaryIpv4.ipAddress
        : ipv4Enabled
          ? server.ipv4Address
          : pulumi.output(undefined),
      ipv6Address: primaryIpv6
        ? primaryIpv6.ipAddress
        : ipv6Enabled
          ? server.ipv6Address
          : pulumi.output(undefined),
      status: server.status,
      location: server.location,
      serverType: server.serverType,
    };
  },

  // ---- Connect Handler ----
  //
  // The PublicCI handler returns the server's public IPv4 as the connection
  // URI. This is used by URL registers and cross-infra connections.
  // Since hetzner-vm is non-hosting (no app components), the handler does
  // not look up allocations -- it simply returns the server IP.

  connect: (({ state }: any) => [
    connectionHandler({
      interface: PublicCI,
      handler: async (_ctx: any) => {
        const ip = state.ipv4Address;
        if (!ip) {
          throw new Error(
            "hetzner-vm: no public IPv4 address available. " +
              "Ensure ipv4Enabled is true in the component config.",
          );
        }
        return {
          uri: pulumi.output(ip),
          metadata: {
            appComponentType: "server",
            host: ip,
            protocol: "https" as const,
          },
        };
      },
    }),
  ]) as any,
});

export default component;
