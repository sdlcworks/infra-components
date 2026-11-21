import { z } from "zod";
import {
  AwsClientSchema,
  AwsRunCarriageStateSchema,
  AwsStatusCarriageSchema,
  StaticAwsCredentialsSchema,
} from "../aws-common";

const absoluteCleanPath = z.string().min(1).superRefine((value, context) => {
  if (!value.startsWith("/") || value.includes("//") || value.split("/").includes(".."))
    context.addIssue({ code: "custom", message: "ec2-guest-path-invalid" });
});
const nonempty = z.string().min(1);
const positive = z.number().int().positive();
const digest = z.string().regex(/^[0-9a-f]{64}$/);

const volumeFields = {
  volumeType: z.enum(["gp2", "gp3", "io1", "io2"]),
  sizeGiB: positive,
  iops: positive.nullable(),
  throughputMiBps: positive.nullable(),
  encrypted: z.boolean(),
  kmsKeyId: nonempty.nullable(),
};

function validVolumeShape(value: {
  volumeType: "gp2" | "gp3" | "io1" | "io2";
  iops: number | null;
  throughputMiBps: number | null;
  encrypted: boolean;
  kmsKeyId: string | null;
}, context: z.RefinementCtx) {
  if (value.volumeType === "gp2" && (value.iops !== null || value.throughputMiBps !== null))
    context.addIssue({ code: "custom", message: "ec2-gp2-performance-fields-forbidden" });
  if ((value.volumeType === "io1" || value.volumeType === "io2") && value.iops === null)
    context.addIssue({ code: "custom", message: "ec2-provisioned-iops-required" });
  if ((value.volumeType === "io1" || value.volumeType === "io2") && value.throughputMiBps !== null)
    context.addIssue({ code: "custom", message: "ec2-provisioned-iops-throughput-forbidden" });
  if (value.kmsKeyId !== null && !value.encrypted)
    context.addIssue({ code: "custom", message: "ec2-kms-requires-encryption" });
}

export const AwsEc2RootVolumeSchema = z
  .strictObject({ ...volumeFields, deleteOnTermination: z.literal(true) })
  .superRefine(validVolumeShape);

const createVolume = z
  .strictObject({
    mode: z.literal("create-per-run"),
    deviceName: nonempty,
    ...volumeFields,
    snapshotId: nonempty.nullable(),
    deleteOnRetire: z.boolean(),
  })
  .superRefine(validVolumeShape);

export const AwsEc2AttachedVolumeSchema = z.discriminatedUnion("mode", [
  z.strictObject({ mode: z.literal("none") }),
  createVolume,
  z.strictObject({
    mode: z.literal("existing"),
    volumeId: nonempty,
    deviceName: nonempty,
    attachment: z.literal("exclusive"),
    deleteOnRetire: z.literal(false),
  }),
]);

export const AwsEc2ConfigurationSchema = z
  .strictObject({
    region: nonempty,
    client: AwsClientSchema,
    statusCarriage: AwsStatusCarriageSchema,
    machine: z.strictObject({
      imageId: nonempty,
      imageOwnerId: nonempty,
      architecture: z.enum(["x86_64", "arm64"]),
      instanceType: nonempty,
      subnetId: nonempty,
      securityGroupIds: z.tuple([nonempty], nonempty),
      instanceProfileArn: nonempty,
      keyName: nonempty.nullable(),
      purchaseModel: z.literal("on-demand"),
      tenancy: z.enum(["default", "dedicated"]),
      capacityReservationPreference: z.enum(["none", "open"]),
      cpuCredits: z.discriminatedUnion("mode", [
        z.strictObject({ mode: z.literal("not-applicable") }),
        z.strictObject({ mode: z.enum(["standard", "unlimited"]) }),
      ]),
      ebsOptimized: z.boolean(),
      associatePublicIpv4Address: z.boolean(),
      metadata: z.strictObject({
        httpEndpoint: z.literal("enabled"),
        httpTokens: z.literal("required"),
        httpPutResponseHopLimit: positive,
      }),
    }),
    rootVolume: AwsEc2RootVolumeSchema,
    attachedVolume: AwsEc2AttachedVolumeSchema,
    lifecycle: z.strictObject({
      pauseMode: z.literal("hibernate"),
      pausedRetentionSeconds: positive,
      cancelGraceMilliseconds: positive,
      providerPollMilliseconds: positive,
    }),
    guest: z.strictObject({
      shellPath: absoluteCleanPath,
      nodePath: absoluteCleanPath,
      awsCliPath: absoluteCleanPath,
      tarPath: absoluteCleanPath,
      workspaceRoot: absoluteCleanPath,
      pathDirectories: z.tuple([absoluteCleanPath], absoluteCleanPath),
    }),
  })
  .superRefine((value, context) => {
    if (new Set(value.machine.securityGroupIds).size !== value.machine.securityGroupIds.length)
      context.addIssue({ code: "custom", message: "ec2-security-groups-not-unique" });
  });
export type AwsEc2Configuration = z.infer<typeof AwsEc2ConfigurationSchema>;
export { StaticAwsCredentialsSchema as AwsEc2CredentialsSchema };
export type AwsEc2Credentials = z.infer<typeof StaticAwsCredentialsSchema>;

export const AwsEc2ComputeConstraintsSchema = z.strictObject({
  os: z.literal("linux"),
  architecture: z.enum(["x86_64", "arm64"]),
  minimumVcpus: positive,
  minimumMemoryMiB: positive,
  minimumWorkspaceGiB: positive,
  attachedVolume: z.enum(["forbidden", "required", "either"]),
  gpu: z.literal(false),
});
export type AwsEc2ComputeConstraints = z.infer<typeof AwsEc2ComputeConstraintsSchema>;

export const AwsEc2AllocationStateSchema = z.strictObject({
  version: z.literal(1),
  configurationDigest: digest,
  image: z.strictObject({
    id: nonempty,
    ownerId: nonempty,
    rootDeviceName: nonempty,
    architecture: z.enum(["x86_64", "arm64"]),
  }),
  instanceType: z.strictObject({
    name: nonempty,
    vcpus: positive,
    memoryMiB: positive,
    hibernationSupported: z.literal(true),
    burstCreditsSupported: z.boolean(),
  }),
  network: z.strictObject({
    subnetId: nonempty,
    vpcId: nonempty,
    availabilityZone: nonempty,
    securityGroupIds: z.array(nonempty).min(1),
    securityGroupVpcId: nonempty,
  }),
  instanceProfileArn: nonempty,
  existingVolume: z
    .strictObject({ volumeId: nonempty, availabilityZone: nonempty, state: z.literal("available") })
    .nullable(),
  qualifiedConstraints: z.strictObject({
    os: z.literal("linux"),
    architecture: z.enum(["x86_64", "arm64"]),
    vcpus: positive,
    memoryMiB: positive,
    workspaceGiB: z.number().int().nonnegative(),
    attachedVolume: z.boolean(),
    gpu: z.literal(false),
  }),
});
export type AwsEc2AllocationState = z.infer<typeof AwsEc2AllocationStateSchema>;

export const AwsEc2RunStateSchema = z.strictObject({
  version: z.literal(1),
  configurationDigest: digest,
  clientToken: digest,
  instanceId: nonempty,
  rootVolumeId: nonempty,
  attachedVolumeId: nonempty.nullable(),
  attachedVolumeOwnership: z.enum(["none", "run", "external"]),
  carriage: AwsRunCarriageStateSchema,
  launchAssociationDigest: digest,
  lastProviderState: z.enum([
    "pending",
    "running",
    "stopping",
    "stopped",
    "shutting-down",
    "terminated",
    "missing",
  ]),
  pauseWitnessedAt: z.string().datetime().nullable(),
  commandSequence: z.number().int().nonnegative(),
});
export type AwsEc2RunState = z.infer<typeof AwsEc2RunStateSchema>;
