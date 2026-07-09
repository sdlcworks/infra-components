import { z } from "zod";

import { CloudProvider, InfraComponent } from "@sdlcworks/components";

import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";

const EFS_NFS_PORT = 2049;
const POSIX_DIRECTORY_PERMISSIONS = "750";
const PERFORMANCE_MODE_GENERAL_PURPOSE = "generalPurpose";
const THROUGHPUT_ELASTIC = "elastic";
const THROUGHPUT_BURSTING = "bursting";
const THROUGHPUT_PROVISIONED = "provisioned";
const TRANSITION_TO_PRIMARY_STORAGE_CLASS = "AFTER_1_ACCESS";
const AWS_POLICY_VERSION = "2012-10-17";
const CONSUMER_FINGERPRINT_ERROR_PREFIX =
  "aws-efs: consumer identity change refused";
const CONSUMER_FINGERPRINT_ERROR_MESSAGE =
  "Changing uid, gid, or rootPath would change the enforced data identity. Create a new consumer key and migrate data explicitly.";
const KMS_FINGERPRINT_ERROR_PREFIX =
  "aws-efs: kmsKeyArn change refused";
const KMS_FINGERPRINT_ERROR_MESSAGE =
  "Changing filesystem encryption key would replace the filesystem and risk total data loss. Create a new filesystem and migrate data explicitly.";
const IA_LIFECYCLE_DAYS = [1, 7, 14, 30, 60, 90] as const;
const ARCHIVE_LIFECYCLE_DAYS = [90, 180, 270, 365] as const;
const DEFAULT_TO_INFREQUENT_ACCESS_DAYS = 30;
const DEFAULT_TO_ARCHIVE_DAYS = 90;
const DEFAULT_RESTORE_TO_STANDARD_ON_ACCESS = false;
const ROOT_PATH_PREFIX = "/";
const TCP_PROTOCOL = "tcp";
const BACKUP_ENABLED = "ENABLED";
const BACKUP_DISABLED = "DISABLED";
const POLICY_EFFECT_ALLOW = "Allow";
const POLICY_EFFECT_DENY = "Deny";
const PRINCIPAL_ALL = "*";
const PRINCIPAL_AWS = "AWS";
const BOOL_CONDITION = "Bool";
const STRING_EQUALS_CONDITION = "StringEquals";
const SECURE_TRANSPORT_CONDITION_KEY = "aws:SecureTransport";
const ACCESS_POINT_ARN_CONDITION_KEY = "elasticfilesystem:AccessPointArn";
const FALSE_CONDITION_VALUE = "false";
const CLIENT_MOUNT_ACTION = "elasticfilesystem:ClientMount";
const CLIENT_WRITE_ACTION = "elasticfilesystem:ClientWrite";
const CLIENT_ROOT_ACCESS_ACTION = "elasticfilesystem:ClientRootAccess";

const LifecycleDaysSchema = z.union([
  z.literal("never"),
  z.number().int().positive(),
]);

const LifecycleSchema = z.object({
  toInfrequentAccessDays: LifecycleDaysSchema
    .default(DEFAULT_TO_INFREQUENT_ACCESS_DAYS)
    .refine(
      (days) => days === "never" || IA_LIFECYCLE_DAYS.includes(days as any),
      "aws-efs: lifecycle.toInfrequentAccessDays must be never or one of 1, 7, 14, 30, 60, 90.",
    ),
  toArchiveDays: LifecycleDaysSchema
    .default(DEFAULT_TO_ARCHIVE_DAYS)
    .refine(
      (days) => days === "never" || ARCHIVE_LIFECYCLE_DAYS.includes(days as any),
      "aws-efs: lifecycle.toArchiveDays must be never or one of 90, 180, 270, 365.",
    ),
  restoreToStandardOnAccess: z.boolean().default(DEFAULT_RESTORE_TO_STANDARD_ON_ACCESS),
}).strict();

const ThroughputSchema = z.union([
  z.enum([THROUGHPUT_ELASTIC, THROUGHPUT_BURSTING]),
  z.object({
    provisionedMibps: z.number().positive(),
  }).strict(),
]);

const ConsumerSchema = z.object({
  uid: z.number().int().min(0),
  gid: z.number().int().min(0),
  rootPath: z.string().min(1).optional(),
  readOnly: z.boolean().default(false),
}).strict().superRefine((consumer, ctx) => {
  if (
    consumer.rootPath !== undefined &&
    !consumer.rootPath.startsWith(ROOT_PATH_PREFIX)
  ) {
    ctx.addIssue({
      code: "custom",
      message: "aws-efs: consumer rootPath must start with /.",
      path: ["rootPath"],
    });
  }
});

const ConfigSchema = z.object({
  vpcId: z.string().min(1),
  subnetIds: z.array(z.string().min(1)).min(1),
  throughput: ThroughputSchema,
  backupEnabled: z.boolean(),
  consumers: z.record(z.string(), ConsumerSchema).refine(
    (consumers) => Object.keys(consumers).length > 0,
    "aws-efs: consumers must declare at least one consumer.",
  ),
  kmsKeyArn: z.string().min(1).optional(),
  lifecycle: LifecycleSchema.default({
    toInfrequentAccessDays: DEFAULT_TO_INFREQUENT_ACCESS_DAYS,
    toArchiveDays: DEFAULT_TO_ARCHIVE_DAYS,
    restoreToStandardOnAccess: DEFAULT_RESTORE_TO_STANDARD_ON_ACCESS,
  }),
  labels: z.record(z.string(), z.string()).default({}),
}).strict();

const OutputSchema = z.object({
  region: z.string(),
  fileSystemId: z.string(),
  fileSystemArn: z.string(),
  mountTargetSecurityGroupId: z.string(),
  accessPointIds: z.record(z.string(), z.string()),
  accessPointArns: z.record(z.string(), z.string()),
  clientSecurityGroupIds: z.record(z.string(), z.string()),
});

type Config = z.infer<typeof ConfigSchema>;
type ConsumerConfig = z.infer<typeof ConsumerSchema>;
type ResolvedConsumerConfig = ConsumerConfig & { rootPath: string };
type ThroughputConfig = z.infer<typeof ThroughputSchema>;
type LifecycleDays = z.infer<typeof LifecycleDaysSchema>;

type ConsumerFingerprint = {
  uid: number;
  gid: number;
  rootPath: string;
};

type PolicyStatement = {
  Effect: string;
  Principal: Record<string, string>;
  Action: string | string[];
  Resource: string;
  Condition?: Record<string, Record<string, string | string[]>>;
};

const component = new InfraComponent({
  metadata: {
    stateful: true,
    proxiable: false,
  },
  connectionTypes: {},
  configSchema: ConfigSchema,
  appComponentTypes: {},
  outputSchema: OutputSchema,
});

function resolveConsumers(
  consumers: Record<string, ConsumerConfig>,
): Record<string, ResolvedConsumerConfig> {
  return Object.fromEntries(
    Object.entries(consumers).map(([consumerKey, consumer]) => [
      consumerKey,
      {
        ...consumer,
        rootPath: consumer.rootPath ?? `${ROOT_PATH_PREFIX}${consumerKey}`,
      },
    ]),
  );
}

function consumerFingerprint(
  consumer: ResolvedConsumerConfig,
): ConsumerFingerprint {
  return {
    uid: consumer.uid,
    gid: consumer.gid,
    rootPath: consumer.rootPath,
  };
}

function assertConsumerFingerprint(
  consumerKey: string,
  stored: string | undefined,
  requested: ConsumerFingerprint,
): string {
  const requestedFingerprint = JSON.stringify(requested);

  if (stored && stored !== requestedFingerprint) {
    throw new Error(
      `${CONSUMER_FINGERPRINT_ERROR_PREFIX} for consumer "${consumerKey}". ${CONSUMER_FINGERPRINT_ERROR_MESSAGE}`,
    );
  }

  return requestedFingerprint;
}

function assertKmsFingerprint(
  stored: string | undefined,
  requested: string | undefined,
): string {
  const requestedFingerprint = requested ?? "";

  if (stored !== undefined && stored !== requestedFingerprint) {
    throw new Error(
      `${KMS_FINGERPRINT_ERROR_PREFIX}. ${KMS_FINGERPRINT_ERROR_MESSAGE}`,
    );
  }

  return requestedFingerprint;
}

function throughputArgs(
  throughput: ThroughputConfig,
): Pick<aws.efs.FileSystemArgs, "throughputMode" | "provisionedThroughputInMibps"> {
  if (typeof throughput === "string") {
    return {
      throughputMode: throughput,
    };
  }

  return {
    throughputMode: THROUGHPUT_PROVISIONED,
    provisionedThroughputInMibps: throughput.provisionedMibps,
  };
}

function transitionAfter(days: Exclude<LifecycleDays, "never">): string {
  return `AFTER_${days}_DAY${days === 1 ? "" : "S"}`;
}

function lifecyclePolicies(
  lifecycle: Config["lifecycle"],
): aws.types.input.efs.FileSystemLifecyclePolicy[] {
  const policies: aws.types.input.efs.FileSystemLifecyclePolicy[] = [];

  if (lifecycle.toInfrequentAccessDays !== "never") {
    policies.push({
      transitionToIa: transitionAfter(lifecycle.toInfrequentAccessDays),
    });
  }

  if (lifecycle.toArchiveDays !== "never") {
    policies.push({
      transitionToArchive: transitionAfter(lifecycle.toArchiveDays),
    });
  }

  if (lifecycle.restoreToStandardOnAccess) {
    policies.push({
      transitionToPrimaryStorageClass: TRANSITION_TO_PRIMARY_STORAGE_CLASS,
    });
  }

  return policies;
}

function validateDistinctAvailabilityZones(
  subnets: aws.ec2.GetSubnetResult[],
): aws.ec2.GetSubnetResult[] {
  const subnetByAvailabilityZone = new Map<string, string>();

  for (const subnet of subnets) {
    const existingSubnetId = subnetByAvailabilityZone.get(subnet.availabilityZone);
    if (existingSubnetId) {
      throw new Error(
        `aws-efs: subnetIds "${existingSubnetId}" and "${subnet.id}" both resolve to availability zone "${subnet.availabilityZone}". EFS permits one mount target per availability zone.`,
      );
    }
    subnetByAvailabilityZone.set(subnet.availabilityZone, subnet.id);
  }

  return subnets;
}

function buildFileSystemPolicy(
  fileSystemArn: string,
  accessPointArns: Record<string, string>,
  consumers: Record<string, ResolvedConsumerConfig>,
): string {
  const statements: PolicyStatement[] = [
    {
      Effect: POLICY_EFFECT_DENY,
      Principal: { [PRINCIPAL_AWS]: PRINCIPAL_ALL },
      Action: [
        CLIENT_MOUNT_ACTION,
        CLIENT_WRITE_ACTION,
        CLIENT_ROOT_ACCESS_ACTION,
      ],
      Resource: fileSystemArn,
      Condition: {
        [BOOL_CONDITION]: {
          [SECURE_TRANSPORT_CONDITION_KEY]: FALSE_CONDITION_VALUE,
        },
      },
    },
    {
      Effect: POLICY_EFFECT_DENY,
      Principal: { [PRINCIPAL_AWS]: PRINCIPAL_ALL },
      Action: CLIENT_ROOT_ACCESS_ACTION,
      Resource: fileSystemArn,
    },
    {
      Effect: POLICY_EFFECT_ALLOW,
      Principal: { [PRINCIPAL_AWS]: PRINCIPAL_ALL },
      Action: CLIENT_MOUNT_ACTION,
      Resource: fileSystemArn,
      Condition: {
        [STRING_EQUALS_CONDITION]: {
          [ACCESS_POINT_ARN_CONDITION_KEY]: Object.values(accessPointArns),
        },
      },
    },
  ];

  const writableAccessPointArns = Object.entries(consumers)
    .filter(([, consumer]) => !consumer.readOnly)
    .map(([consumerKey]) => accessPointArns[consumerKey]);

  if (writableAccessPointArns.length > 0) {
    statements.push({
      Effect: POLICY_EFFECT_ALLOW,
      Principal: { [PRINCIPAL_AWS]: PRINCIPAL_ALL },
      Action: CLIENT_WRITE_ACTION,
      Resource: fileSystemArn,
      Condition: {
        [STRING_EQUALS_CONDITION]: {
          [ACCESS_POINT_ARN_CONDITION_KEY]: writableAccessPointArns,
        },
      },
    });
  }

  return JSON.stringify({
    Version: AWS_POLICY_VERSION,
    Statement: statements,
  });
}

component.implement(CloudProvider.aws, {
  stateSchema: z.object({
    region: z.string().optional(),
    kmsKeyArnFingerprint: z.string().optional(),
    consumerFingerprints: z.record(z.string(), z.string()).default({}),
    accessPointIds: z.record(z.string(), z.string()).default({}),
    accessPointArns: z.record(z.string(), z.string()).default({}),
    clientSecurityGroupIds: z.record(z.string(), z.string()).default({}),
    fileSystemId: z.string().optional(),
    fileSystemArn: z.string().optional(),
    mountTargetSecurityGroupId: z.string().optional(),
  }),
  initialState: {
    consumerFingerprints: {},
    accessPointIds: {},
    accessPointArns: {},
    clientSecurityGroupIds: {},
  },

  pulumi: async ({ $, inputs, state, aws: provider }) => {
    const config = inputs as Config;
    const awsOpts: pulumi.CustomResourceOptions = provider
      ? { provider }
      : {};
    const consumers = resolveConsumers(config.consumers);
    const consumerFingerprints = (state.consumerFingerprints ?? {}) as Record<string, string>;

    const storedKmsKeyArnFingerprint = typeof state.kmsKeyArnFingerprint === "string"
      ? state.kmsKeyArnFingerprint
      : undefined;
    const kmsKeyArnFingerprint = assertKmsFingerprint(
      storedKmsKeyArnFingerprint,
      config.kmsKeyArn,
    );

    for (const [consumerKey, consumer] of Object.entries(consumers)) {
      consumerFingerprints[consumerKey] = assertConsumerFingerprint(
        consumerKey,
        consumerFingerprints[consumerKey],
        consumerFingerprint(consumer),
      );
    }

    const subnetOutputs = config.subnetIds.map((subnetId) =>
      aws.ec2.getSubnetOutput({ id: subnetId }, awsOpts)
    );
    const validatedSubnets = pulumi
      .all(subnetOutputs)
      .apply(validateDistinctAvailabilityZones);
    const region = aws.getRegionOutput({}, awsOpts).name;

    const clientSecurityGroups: Record<string, aws.ec2.SecurityGroup> = {};
    for (const consumerKey of Object.keys(consumers)) {
      clientSecurityGroups[consumerKey] = new aws.ec2.SecurityGroup(
        $`sg-client-${consumerKey}`,
        {
          name: $`sg-client-${consumerKey}`,
          description: "Managed by sdlc.works aws-efs component",
          vpcId: config.vpcId,
          ingress: [],
          egress: [],
          revokeRulesOnDelete: true,
          tags: {
            ...config.labels,
            Name: $`sg-client-${consumerKey}`,
          },
        },
        awsOpts,
      );
    }

    const mountTargetSecurityGroup = new aws.ec2.SecurityGroup(
      $`sg-mount`,
      {
        name: $`sg-mount`,
        description: "Managed by sdlc.works aws-efs component",
        vpcId: config.vpcId,
        ingress: Object.entries(clientSecurityGroups).map(
          ([consumerKey, securityGroup]) => ({
            protocol: TCP_PROTOCOL,
            fromPort: EFS_NFS_PORT,
            toPort: EFS_NFS_PORT,
            securityGroups: [securityGroup.id],
            description: `Allow NFS from ${consumerKey}`,
          }),
        ),
        egress: [],
        revokeRulesOnDelete: true,
        tags: {
          ...config.labels,
          Name: $`sg-mount`,
        },
      },
      awsOpts,
    );

    const fileSystem = new aws.efs.FileSystem(
      $`fs`,
      {
        encrypted: true,
        kmsKeyId: config.kmsKeyArn,
        performanceMode: PERFORMANCE_MODE_GENERAL_PURPOSE,
        ...throughputArgs(config.throughput),
        lifecyclePolicies: lifecyclePolicies(config.lifecycle),
        tags: {
          ...config.labels,
          Name: $`fs`,
        },
      },
      {
        ...awsOpts,
        protect: true,
      },
    );

    new aws.efs.BackupPolicy(
      $`backup`,
      {
        fileSystemId: fileSystem.id,
        backupPolicy: {
          status: config.backupEnabled ? BACKUP_ENABLED : BACKUP_DISABLED,
        },
      },
      awsOpts,
    );

    for (let index = 0; index < config.subnetIds.length; index += 1) {
      new aws.efs.MountTarget(
        $`mt-${index}`,
        {
          fileSystemId: fileSystem.id,
          subnetId: validatedSubnets.apply((subnets) => subnets[index].id),
          securityGroups: [mountTargetSecurityGroup.id],
        },
        awsOpts,
      );
    }

    const accessPointIds: Record<string, pulumi.Output<string>> = {};
    const accessPointArns: Record<string, pulumi.Output<string>> = {};
    for (const [consumerKey, consumer] of Object.entries(consumers)) {
      const accessPoint = new aws.efs.AccessPoint(
        $`ap-${consumerKey}`,
        {
          fileSystemId: fileSystem.id,
          posixUser: {
            uid: consumer.uid,
            gid: consumer.gid,
            secondaryGids: [],
          },
          rootDirectory: {
            path: consumer.rootPath,
            creationInfo: {
              ownerUid: consumer.uid,
              ownerGid: consumer.gid,
              permissions: POSIX_DIRECTORY_PERMISSIONS,
            },
          },
          tags: {
            ...config.labels,
            Name: $`ap-${consumerKey}`,
          },
        },
        awsOpts,
      );

      accessPointIds[consumerKey] = accessPoint.id;
      accessPointArns[consumerKey] = accessPoint.arn;
    }

    new aws.efs.FileSystemPolicy(
      $`policy`,
      {
        fileSystemId: fileSystem.id,
        policy: pulumi
          .all([fileSystem.arn, pulumi.output(accessPointArns)])
          .apply(([fileSystemArn, resolvedAccessPointArns]) =>
            buildFileSystemPolicy(
              fileSystemArn,
              resolvedAccessPointArns,
              consumers,
            )
          ),
      },
      awsOpts,
    );

    const clientSecurityGroupIds = Object.fromEntries(
      Object.entries(clientSecurityGroups).map(([consumerKey, securityGroup]) => [
        consumerKey,
        securityGroup.id,
      ]),
    );

    const outputs = {
      region,
      fileSystemId: fileSystem.id,
      fileSystemArn: fileSystem.arn,
      mountTargetSecurityGroupId: mountTargetSecurityGroup.id,
      accessPointIds: pulumi.output(accessPointIds),
      accessPointArns: pulumi.output(accessPointArns),
      clientSecurityGroupIds: pulumi.output(clientSecurityGroupIds),
    };

    (state as any).accessPointIds = accessPointIds;
    (state as any).accessPointArns = accessPointArns;
    (state as any).clientSecurityGroupIds = clientSecurityGroupIds;
    state.consumerFingerprints = consumerFingerprints;
    state.kmsKeyArnFingerprint = kmsKeyArnFingerprint;
    state.region = outputs.region;
    state.fileSystemId = outputs.fileSystemId;
    state.fileSystemArn = outputs.fileSystemArn;
    state.mountTargetSecurityGroupId = outputs.mountTargetSecurityGroupId;

    return outputs;
  },
});

export default component;
