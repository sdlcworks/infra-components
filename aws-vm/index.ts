/**
 * aws-vm -- Standalone AWS EC2 VM infrastructure component.
 *
 * Creates a single EC2 instance with a stable Elastic IP (via aws.ec2.Eip),
 * managed Security Group (ingress + egress), optional IAM instance profile,
 * SSH keys via cloud-init, and cloud-init (userData) support. Pure
 * infrastructure: no app-component allocation, no artifact deployment.
 *
 * Resource graph:
 *   Layer 0 (parallel): AMI lookup, Elastic IP, Security Group, IAM Role+Profile
 *   Layer 1: EC2 Instance -- depends on all of Layer 0
 *   Layer 2: EIP Association -- depends on Instance
 *
 * Connection type "public" exposes the VM's Elastic IP via PublicCI for
 * platform URI resolution (e.g. URL registers, cross-infra connections).
 */

import { z } from "zod";

import {
  CloudProvider,
  InfraComponent,
  connectionHandler,
} from "@sdlcworks/components";

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

// ---- Zod Schemas ----

const IngressRuleSchema = z.object({
  protocol: z
    .string()
    .describe(
      'IP protocol. "tcp", "udp", "icmp", or "-1" for all protocols. ' +
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

const EgressRuleSchema = z.object({
  protocol: z
    .string()
    .describe(
      'IP protocol. "tcp", "udp", "icmp", or "-1" for all protocols. ' +
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

// ---- Component Definition ----

const component = new InfraComponent({
  metadata: {
    stateful: true,
    proxiable: false,
  },
  connectionTypes: {
    public: {
      description:
        "exposes the VM via its public IPv4 address (Elastic IP) for external access",
      interface: PublicCI,
    },
  } as const,
  connectionInterfaces: [],
  configSchema: z.object({
    // ---- 2.1 Compute Core ----

    instanceType: z
      .string()
      .describe(
        'EC2 instance type (e.g. "t3.micro", "m6i.large", "c7g.xlarge"). ' +
          "In-place update: instance stops, resizes, restarts (requires allowStoppingForUpdate=true).",
      ),

    availabilityZone: z
      .string()
      .default("")
      .describe(
        'Availability zone (e.g. "us-east-1a"). When empty, AWS chooses automatically. ' +
          "WARNING: changing this value DESTROYS AND RECREATES the VM.",
      ),

    // ---- 2.2 Boot Image ----

    amiId: z
      .string()
      .default("")
      .describe(
        "Explicit AMI ID to use. When set, amiFilter and amiOwner are ignored. " +
          "When empty, the latest AMI matching amiFilter/amiOwner is resolved automatically. " +
          "WARNING: changing this value DESTROYS AND RECREATES the VM.",
      ),

    amiFilter: z
      .string()
      .default(DEFAULT_AMI_FILTER)
      .describe(
        "AMI name filter for automatic resolution (glob pattern). Only used when amiId is empty. " +
          "Default: Ubuntu 24.04 Noble (amd64, gp3 root). " +
          "Resolved once at creation; changes ignored thereafter (ignoreChanges on ami).",
      ),

    amiOwner: z
      .string()
      .default(DEFAULT_AMI_OWNER)
      .describe(
        "AWS account ID that owns the AMI. Only used when amiId is empty. " +
          'Default: "099720109477" (Canonical, publisher of Ubuntu AMIs).',
      ),

    // ---- 2.3 Boot Disk (Root EBS Volume) ----

    rootVolumeSizeGb: z
      .number()
      .min(8)
      .max(16384)
      .default(20)
      .describe("Root EBS volume size in GB. In-place update (EBS volumes can grow online)."),

    rootVolumeType: z
      .enum(["gp3", "gp2", "io1", "io2"])
      .default("gp3")
      .describe("Root EBS volume type. In-place update."),

    rootVolumeEncrypted: z
      .boolean()
      .default(true)
      .describe(
        "Encrypt the root EBS volume (uses default AWS-managed KMS key). " +
          "WARNING: changing this value DESTROYS AND RECREATES the VM.",
      ),

    // ---- 2.4 SSH & Key Pair ----

    sshPublicKeys: z
      .array(z.string())
      .default([])
      .describe(
        'SSH public key strings (e.g. "ssh-ed25519 AAAA..."). Injected via cloud-init ' +
          "ssh_authorized_keys directive. In-place update (userData change, but ignoreChanges prevents replacement).",
      ),

    keyPairName: z
      .string()
      .default("")
      .describe(
        "Name of an existing EC2 Key Pair. AWS injects the key pair's public key into the default " +
          "OS user's authorized_keys via instance metadata. Does NOT create a key pair. " +
          "Independent of sshPublicKeys (both can coexist). " +
          "WARNING: changing this value DESTROYS AND RECREATES the VM.",
      ),

    // ---- 2.5 Cloud-Init ----

    userData: z
      .string()
      .default("")
      .describe(
        "Cloud-init user data (typically a #cloud-config YAML document). " +
          "Changes are ignored after creation (ignoreChanges on userData).",
      ),

    // ---- 2.6 Networking ----

    assignPublicIp: z
      .boolean()
      .default(true)
      .describe(
        "When true, creates an Elastic IP and associates it with the instance. " +
          "The EIP survives instance replacement. In-place update (EIP association/disassociation).",
      ),

    subnetId: z
      .string()
      .default("")
      .describe(
        "EC2 subnet ID. When empty, uses the default subnet in the chosen AZ. " +
          "WARNING: changing this value DESTROYS AND RECREATES the VM.",
      ),

    vpcId: z
      .string()
      .default("")
      .describe(
        "VPC ID for the Security Group. When empty, uses the default VPC. " +
          "WARNING: changing this value DESTROYS AND RECREATES the VM (indirect; SG is VPC-scoped).",
      ),

    // ---- 2.7 Firewall (Security Group) ----

    firewallRules: z
      .array(IngressRuleSchema)
      .default([])
      .describe(
        "Ingress firewall rules. Each rule permits inbound traffic on the Security Group. " +
          "Empty = deny all inbound (no rules = nothing can reach the VM). In-place update.",
      ),

    egressRules: z
      .array(EgressRuleSchema)
      .default([])
      .describe(
        "Egress firewall rules. Empty/omitted = allow ALL outbound (AWS native default; " +
          "the VM can reach the internet out of the box). When explicit rules are provided, " +
          "they REPLACE the allow-all default -- only the specified outbound traffic is permitted. " +
          "In-place update.",
      ),

    // ---- 2.8 Tags ----

    tags: z
      .record(z.string(), z.string())
      .default({})
      .describe(
        "Tags applied to all AWS resources (instance, EIP, security group, root volume). In-place update.",
      ),

    // ---- 2.9 Security ----

    requireImdsv2: z
      .boolean()
      .default(true)
      .describe(
        'Enforce IMDSv2 (sets HttpTokens="required"). Security best practice. In-place update.',
      ),

    // ---- 2.10 IAM Instance Profile ----

    instanceProfileArn: z
      .string()
      .default("")
      .describe(
        "ARN of an existing IAM instance profile. When set, the component attaches this profile " +
          "and creates NO IAM resources. enableSsmAccess is ignored. " +
          "When empty, the component creates a dedicated IAM role + instance profile with zero policies. " +
          "WARNING: changing this value DESTROYS AND RECREATES the VM.",
      ),

    enableSsmAccess: z
      .boolean()
      .default(false)
      .describe(
        "Attach AmazonSSMManagedInstanceCore managed policy to the component-created IAM role. " +
          "Only effective when instanceProfileArn is empty. " +
          "Cross-validation: setting both instanceProfileArn and enableSsmAccess=true is an error. " +
          "In-place update.",
      ),

    // ---- 2.11 Protection & Lifecycle ----

    deletionProtection: z
      .boolean()
      .default(false)
      .describe("Enable EC2 API termination protection (disableApiTermination). In-place update."),

    allowStoppingForUpdate: z
      .boolean()
      .default(true)
      .describe(
        "Meta-field: controls whether Pulumi may stop the instance for in-place updates " +
          "(e.g. instanceType resize). Does not map to an AWS API field directly.",
      ),
  }),
  appComponentTypes: {},
  outputSchema: z.object({
    instanceId: z.string().describe("EC2 instance ID"),
    name: z.string().describe("Instance name (derived from $ naming)"),
    availabilityZone: z.string().describe("AZ where the instance was launched"),
    instanceType: z.string().describe("Effective instance type"),
    status: z.string().describe("Instance state (e.g. running, stopped)"),
    ipv4Address: z
      .string()
      .optional()
      .describe("Public IPv4 address (from Elastic IP when assignPublicIp is true)"),
    privateIpAddress: z.string().describe("Private IPv4 address"),
  }),
});

// ---- AWS Provider Implementation ----

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
  const boundary = "==SDLC_MULTIPART_BOUNDARY==";
  const parts = [
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    `MIME-Version: 1.0`,
    ``,
    `--${boundary}`,
    `Content-Type: text/cloud-config; charset="utf-8"`,
    `MIME-Version: 1.0`,
    ``,
    sshBlock,
    ``,
    `--${boundary}`,
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
    `--${boundary}--`,
  ].join("\n");
  return parts;
}

component.implement(CloudProvider.aws, {
  stateSchema: z.object({
    ipv4Address: z.string().optional(),
  }),
  initialState: {},

  pulumi: async ({ $, inputs, state, aws: provider }) => {
    const {
      instanceType,
      availabilityZone,
      amiId,
      amiFilter,
      amiOwner,
      rootVolumeSizeGb,
      rootVolumeType,
      rootVolumeEncrypted,
      sshPublicKeys,
      keyPairName,
      userData,
      assignPublicIp,
      subnetId,
      vpcId,
      firewallRules,
      egressRules,
      tags,
      requireImdsv2,
      instanceProfileArn,
      enableSsmAccess,
      deletionProtection,
      allowStoppingForUpdate,
    } = inputs;

    const awsOpts: pulumi.CustomResourceOptions = { provider };

    // ---- Cross-field validation ----

    if ((instanceProfileArn as string) && (enableSsmAccess as boolean)) {
      throw new Error(
        "aws-vm: instanceProfileArn and enableSsmAccess are mutually exclusive. " +
          "When you bring your own instance profile, manage SSM policy on it directly in AWS.",
      );
    }

    // ---- Build effective userData with SSH key injection ----

    const effectiveUserData = buildUserData(
      sshPublicKeys as string[],
      userData as string,
    );

    // ---- Merge tags with a component-managed Name tag ----

    const instanceName = $`instance`;
    const baseTags: Record<string, string> = {
      ...(tags as Record<string, string>),
      Name: instanceName,
    };

    // ---- Layer 0a: AMI Lookup (data source, only if amiId is empty) ----

    let ami: pulumi.Input<string>;
    if ((amiId as string)) {
      ami = amiId as string;
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
      description: "Managed by sdlc.works aws-vm component",
      ...(vpcId as string ? { vpcId: vpcId as string } : {}),
      // Ingress rules (empty = deny all inbound)
      ingress: (firewallRules as any[]).map((rule: any) => ({
        protocol: rule.protocol,
        fromPort: rule.fromPort,
        toPort: rule.toPort,
        cidrBlocks: rule.sourceRanges,
        description: rule.description,
      })),
      // Egress rules: empty = allow-all outbound (AWS native default).
      // Non-empty = user's explicit rules REPLACE the allow-all.
      egress:
        (egressRules as any[]).length > 0
          ? (egressRules as any[]).map((rule: any) => ({
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
    //
    // When instanceProfileArn is provided, use it directly and create no IAM resources.
    // When empty, create a role + profile with zero policies (user manages permissions
    // in AWS directly). enableSsmAccess optionally attaches the SSM managed policy.

    let effectiveInstanceProfileName: pulumi.Input<string> | undefined;

    if (instanceProfileArn as string) {
      // User-managed: extract the instance profile name from the ARN.
      // ARN format: arn:aws:iam::<account>:instance-profile/<name>
      // We pass the full ARN to the instance's iamInstanceProfile field,
      // which accepts either a name or an ARN.
      effectiveInstanceProfileName = instanceProfileArn as string;
    } else {
      // Component-managed: create role + instance profile.
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

      // Optional: attach SSM managed policy.
      if (enableSsmAccess as boolean) {
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
      ...(keyPairName as string
        ? { keyName: keyPairName as string }
        : {}),
      ...(subnetId as string
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
        httpTokens: (requireImdsv2 as boolean) ? "required" : "optional",
        httpEndpoint: "enabled",
      },

      disableApiTermination: deletionProtection as boolean,

      tags: baseTags,
    }, {
      ...awsOpts,
      ignoreChanges: ["ami", "userData"],
    });

    // suppress unused variable warning -- allowStoppingForUpdate is a meta-field
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
      instanceId: instance.id,
      name: instance.tags.apply((t) => t?.Name ?? instanceName),
      availabilityZone: instance.availabilityZone,
      instanceType: instance.instanceType,
      status: instance.instanceState,
      ipv4Address: eip
        ? eip.publicIp
        : pulumi.output(undefined),
      privateIpAddress: instance.privateIp,
    };
  },

  // ---- Connect Handler ----
  //
  // The PublicCI handler returns the VM's Elastic IP as the connection
  // URI. Since aws-vm is non-hosting (no app components), the handler does
  // not look up allocations -- it simply returns the VM IP.

  connect: (({ state }: any) => [
    connectionHandler({
      interface: PublicCI,
      handler: async (_ctx: any) => {
        if (!state.ipv4Address) {
          throw new Error(
            "aws-vm: no public IPv4 address available. " +
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
