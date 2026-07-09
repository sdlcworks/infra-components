import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";

import {
  DescribeServicesCommand,
  ECSClient,
  RegisterTaskDefinitionCommand,
  type RegisterTaskDefinitionCommandInput,
  UpdateServiceCommand,
} from "@aws-sdk/client-ecs";
import {
  CompleteLayerUploadCommand,
  DescribeImagesCommand,
  ECRClient,
  InitiateLayerUploadCommand,
  PutImageCommand,
  UploadLayerPartCommand,
} from "@aws-sdk/client-ecr";
import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import {
  CloudProvider,
  DeploymentArtifactType,
  InfraComponent,
  connectionHandler,
  type CloudCredentialAWS,
} from "@sdlcworks/components";
import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";
import { z } from "zod";

import { InternalServiceCI, PublicCI } from "../_internal/interfaces";

const ECS_TASKS_SERVICE_PRINCIPAL = "ecs-tasks.amazonaws.com";
const ECS_SERVICE_PRINCIPAL = "ecs.amazonaws.com";
const TASK_EXECUTION_POLICY_ARN =
  "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy";
const AWS_POLICY_VERSION = "2012-10-17";
const DEFAULT_LOG_RETENTION_DAYS = 30;
const DEFAULT_ARCHITECTURE = "x86_64";
const DEFAULT_HEALTH_PATH = "/";
const DEFAULT_HEALTH_GRACE_SECONDS = 0;
const DEFAULT_EPHEMERAL_STORAGE_GB = 20;
const DEFAULT_TARGET_CPU_PERCENT = 70;
const DEFAULT_DEREGISTRATION_DELAY_SECONDS = 300;
const DEFAULT_BLUE_GREEN_HTTPS_TEST_PORT = 8443;
const DEFAULT_BLUE_GREEN_HTTP_TEST_PORT = 8080;
const DEFAULT_BLUE_GREEN_BAKE_MINUTES = 5;
const FARGATE_PLATFORM_VERSION = "1.4.0";
const CONTAINER_NAME = "app";
const SERVICE_CONNECT_PROTOCOL_HTTP = "http";
const TLS_POLICY = "ELBSecurityPolicy-TLS13-1-2-2021-06";
const SEED_IMAGE_TAG = "sdlc-seed";
const ROLLOUT_POLL_INTERVAL_MS = 15_000;
const ROLLOUT_MAX_ATTEMPTS = 120;
const CONFIG_SNAPSHOT_MISSING_ERROR =
  "aws-ecs: config snapshot missing from state; pulumi() must run before allocateComponent or upsertArtifacts.";
const ECR_DIRECT_ERROR =
  "image artifacts must be published through a same-account, same-region ECR-backed artifact registry (`aws-ecr`)";
const DOCKER_MANIFEST_MEDIA_TYPE =
  "application/vnd.docker.distribution.manifest.v2+json";
const DOCKER_CONFIG_MEDIA_TYPE =
  "application/vnd.docker.container.image.v1+json";
const DOCKER_LAYER_MEDIA_TYPE =
  "application/vnd.docker.image.rootfs.diff.tar.gzip";
const EMPTY_TAR = Buffer.alloc(1024);
const MAX_TASK_SECURITY_GROUPS = 5;
const ECS_TASK_BASE_SECURITY_GROUPS = 2;
const ECS_SERVICE_NAMESPACE = "ecs";
const ECS_DESIRED_COUNT_DIMENSION = "ecs:service:DesiredCount";
const TARGET_TRACKING_POLICY_TYPE = "TargetTrackingScaling";
const CPU_METRIC_TYPE = "ECSServiceAverageCPUUtilization";
const MEMORY_METRIC_TYPE = "ECSServiceAverageMemoryUtilization";
const ALB_REQUEST_METRIC_TYPE = "ALBRequestCountPerTarget";
const HTTP_PORT = 80;
const HTTPS_PORT = 443;
const EFS_TRANSIT_ENCRYPTION_ENABLED = "ENABLED";
const EFS_IAM_ENABLED = "ENABLED";

const ArchitectureSchema = z.enum(["x86_64", "arm64"]);
const CapacitySchema = z.union([
  z.enum(["on-demand", "spot"]),
  z
    .object({
      baseOnDemand: z.number().int().min(0),
      spotWeight: z.number().int().min(0),
    })
    .strict()
    .refine(
      (value) => value.baseOnDemand > 0 || value.spotWeight > 0,
      "aws-ecs: capacity object requires baseOnDemand > 0 or spotWeight > 0.",
    ),
]);

const RollingDeploymentSchema = z
  .object({
    posture: z.literal("rolling"),
    circuitBreaker: z
      .object({
        enabled: z.boolean().default(true),
        rollback: z.boolean().default(true),
      })
      .default({ enabled: true, rollback: true }),
    minimumHealthyPercent: z.number().int().min(0).max(100).default(100),
    maximumPercent: z.number().int().min(100).max(200).default(200),
  })
  .strict();

const BlueGreenDeploymentSchema = z
  .object({
    posture: z.literal("blue-green"),
    bakeTimeMinutes: z
      .number()
      .int()
      .min(0)
      .max(1440)
      .default(DEFAULT_BLUE_GREEN_BAKE_MINUTES),
    testListenerPort: z.number().int().min(1).max(65535).optional(),
  })
  .strict();

const DeploymentSchema = z.discriminatedUnion("posture", [
  RollingDeploymentSchema,
  BlueGreenDeploymentSchema,
]);

const ExposureSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("none") }).strict(),
  z.object({ mode: z.literal("internal") }).strict(),
  z
    .object({
      mode: z.literal("external-attachment"),
      targetGroupArn: z.string().min(1),
    })
    .strict(),
  z
    .object({
      mode: z.literal("owned-alb"),
      allowedIngressCidrs: z.array(z.string()).min(1),
      publicNames: z.array(z.string().min(1)).default([]),
      certificateArn: z.string().optional(),
      redirectHttpToHttps: z.boolean().optional(),
      testAccessCidrs: z.array(z.string()).optional(),
      deregistrationDelaySeconds: z
        .number()
        .int()
        .min(0)
        .max(3600)
        .default(DEFAULT_DEREGISTRATION_DELAY_SECONDS),
    })
    .strict(),
]);

const VolumeSchema = z
  .object({
    name: z.string().min(1),
    mountPath: z.string().min(1),
    readOnly: z.boolean().default(false),
    fileSystemId: z.string().min(1),
    fileSystemArn: z.string().min(1),
    accessPointId: z.string().min(1),
    accessPointArn: z.string().min(1),
    clientSecurityGroupId: z.string().min(1),
  })
  .strict();

const HealthSchema = z
  .object({
    command: z.array(z.string().min(1)).optional(),
    intervalSeconds: z.number().int().min(5).max(300).optional(),
    retries: z.number().int().min(1).max(10).optional(),
    startPeriodSeconds: z.number().int().min(0).max(300).optional(),
    path: z.string().default(DEFAULT_HEALTH_PATH),
    gracePeriodSeconds: z
      .number()
      .int()
      .min(0)
      .default(DEFAULT_HEALTH_GRACE_SECONDS),
  })
  .strict()
  .default({
    path: DEFAULT_HEALTH_PATH,
    gracePeriodSeconds: DEFAULT_HEALTH_GRACE_SECONDS,
  });

const ScalingSchema = z
  .object({
    min: z.number().int().min(0),
    max: z.number().int().min(0),
    targetCpuPercent: z
      .number()
      .int()
      .min(1)
      .max(100)
      .default(DEFAULT_TARGET_CPU_PERCENT),
    targetMemoryPercent: z.number().int().min(1).max(100).optional(),
    requestsPerTarget: z.number().int().min(1).optional(),
  })
  .strict();

const ServiceConfigSchema = z
  .object({
    cpu: z.number().int().optional(),
    memoryMb: z.number().int().optional(),
    capacity: CapacitySchema.optional(),
    deployment: DeploymentSchema.optional(),
    logRetentionDays: z.number().int().positive().optional(),
    architecture: ArchitectureSchema.optional(),
    scaling: ScalingSchema,
    exposure: ExposureSchema,
    port: z.number().int().min(1).max(65535).optional(),
    environment: z.record(z.string(), z.string()).default({}),
    secrets: z.record(z.string(), z.string()).default({}),
    secretsKmsKeyArn: z.string().min(1).optional(),
    volumes: z.array(VolumeSchema).default([]),
    health: HealthSchema,
    ephemeralStorageGb: z
      .number()
      .int()
      .min(DEFAULT_EPHEMERAL_STORAGE_GB)
      .max(200)
      .default(DEFAULT_EPHEMERAL_STORAGE_GB),
    enableExecuteCommand: z.boolean().default(false),
    command: z.array(z.string()).optional(),
    entrypoint: z.array(z.string()).optional(),
    taskPolicyStatements: z.array(z.record(z.string(), z.any())).default([]),
  })
  .strict();

const DefaultsSchema = z
  .object({
    cpu: z.number().int(),
    memoryMb: z.number().int(),
    capacity: CapacitySchema,
    deployment: DeploymentSchema,
    logRetentionDays: z
      .number()
      .int()
      .positive()
      .default(DEFAULT_LOG_RETENTION_DAYS),
    architecture: ArchitectureSchema.default(DEFAULT_ARCHITECTURE),
  })
  .strict();

const DiscoveryNamespaceSchema = z
  .object({
    name: z.string().min(1),
    arn: z.string().min(1),
  })
  .strict();

export const ConfigSchema = z
  .object({
    vpcId: z.string().min(1),
    privateSubnetIds: z.array(z.string().min(1)).min(1),
    publicSubnetIds: z.array(z.string().min(1)).optional(),
    discoveryNamespace: DiscoveryNamespaceSchema,
    observability: z
      .object({
        containerInsights: z.enum(["disabled", "enabled", "enhanced"]),
      })
      .strict(),
    defaults: DefaultsSchema,
    services: z.record(z.string(), ServiceConfigSchema).refine(
      (services) => Object.keys(services).length > 0,
      "aws-ecs: services must declare at least one service.",
    ),
    labels: z.record(z.string(), z.string()).default({}),
  })
  .strict()
  .superRefine((config, ctx) => {
    const hasOwnedAlb = Object.values(config.services).some(
      (service) => service.exposure.mode === "owned-alb",
    );
    if (hasOwnedAlb && (!config.publicSubnetIds || config.publicSubnetIds.length < 2)) {
      ctx.addIssue({
        code: "custom",
        path: ["publicSubnetIds"],
        message:
          "aws-ecs: publicSubnetIds must include at least two public subnets for owned-alb exposure.",
      });
    }
    for (const [serviceKey, service] of Object.entries(config.services)) {
      if (
        service.exposure.mode === "owned-alb" &&
        service.exposure.certificateArn &&
        service.exposure.publicNames.length === 0
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["services", serviceKey, "exposure", "publicNames"],
          message: `aws-ecs: service "${serviceKey}" certificateArn requires at least one publicName.`,
        });
      }
    }
  });

const AppComponentSchema = z.object({
  service: z.string().min(1),
});

const AllocationSchema = z.object({
  service: z.string(),
});

const DeployedArtifactSchema = z.object({
  service: z.string(),
  deliveredUri: z.string(),
  digest: z.string(),
  digestPinnedUri: z.string(),
  taskDefinitionArn: z.string(),
});

type Config = z.infer<typeof ConfigSchema>;
type ServiceConfig = z.infer<typeof ServiceConfigSchema>;
type ResolvedServiceConfig = ServiceConfig & {
  cpu: number;
  memoryMb: number;
  capacity: z.infer<typeof CapacitySchema>;
  deployment: z.infer<typeof DeploymentSchema>;
  logRetentionDays: number;
  architecture: z.infer<typeof ArchitectureSchema>;
};
type AppComponentConfig = z.infer<typeof AppComponentSchema>;
type Allocation = z.infer<typeof AllocationSchema>;
type DeployedArtifact = z.infer<typeof DeployedArtifactSchema>;
type AwsCredentials = CloudCredentialAWS & {
  AWS_SESSION_TOKEN?: string;
};
type EcrImageReference = {
  accountId: string;
  region: string;
  host: string;
  repository: string;
  tag?: string;
  digest?: string;
};
type TaskDefinitionTemplate = RegisterTaskDefinitionCommandInput;

export type WorkloadTarget = {
  targetType: "ip";
  port: number;
  protocol: "HTTP";
  health: {
    protocol: "HTTP";
    path: string;
    gracePeriodSeconds: number;
  };
  deregistrationDelaySeconds: number;
};

const WorkloadTargetSchema = z
  .object({
    targetType: z.literal("ip"),
    port: z.number().int().min(1).max(65535),
    protocol: z.literal("HTTP"),
    health: z
      .object({
        protocol: z.literal("HTTP"),
        path: z.string(),
        gracePeriodSeconds: z.number().int().min(0),
      })
      .strict(),
    deregistrationDelaySeconds: z.number().int().min(0).max(3600),
  })
  .strict();

const component = new InfraComponent({
  metadata: {
    stateful: true,
    proxiable: true,
  },
  acceptedArtifactTypes: [DeploymentArtifactType.oci_spec_image],
  connectionTypes: {
    public: {
      description: "public endpoint for an owned-ALB ECS service",
      interface: PublicCI,
    },
    internal: {
      description: "internal Service Connect endpoint for an ECS service",
      interface: InternalServiceCI,
    },
  } as const,
  connectionInterfaces: [PublicCI, InternalServiceCI],
  configSchema: ConfigSchema,
  appComponentTypes: {
    service: AppComponentSchema,
  },
  outputSchema: z.object({
    region: z.string(),
    clusterArn: z.string(),
    serviceNames: z.record(z.string(), z.string()),
    serviceArns: z.record(z.string(), z.string()),
    taskRoleArns: z.record(z.string(), z.string()),
    publicEndpoints: z.record(z.string(), z.string()),
    ownedAlbDnsNames: z.record(z.string(), z.string()),
    ownedAlbZoneIds: z.record(z.string(), z.string()),
    internalEndpoints: z.record(z.string(), z.string()),
    workloadTargets: z.record(z.string(), WorkloadTargetSchema),
    namespaceArn: z.string(),
  }),
});

function assumeRolePolicy(servicePrincipal: string): string {
  return JSON.stringify({
    Version: AWS_POLICY_VERSION,
    Statement: [
      {
        Effect: "Allow",
        Principal: { Service: servicePrincipal },
        Action: "sts:AssumeRole",
      },
    ],
  });
}

function inlinePolicyDocument(statements: Array<Record<string, any>>): string {
  return JSON.stringify({
    Version: AWS_POLICY_VERSION,
    Statement: statements,
  });
}

function credentialsFrom(getCredentials: () => unknown): AwsCredentials {
  const creds = getCredentials() as AwsCredentials;
  if (
    !creds?.AWS_ACCESS_KEY_ID ||
    !creds?.AWS_SECRET_ACCESS_KEY ||
    !creds?.AWS_REGION
  ) {
    throw new Error(
      "aws-ecs: AWS credentials must include AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, and AWS_REGION.",
    );
  }

  return creds;
}

function clientConfig(creds: AwsCredentials) {
  return {
    region: creds.AWS_REGION,
    credentials: {
      accessKeyId: creds.AWS_ACCESS_KEY_ID,
      secretAccessKey: creds.AWS_SECRET_ACCESS_KEY,
      sessionToken: creds.AWS_SESSION_TOKEN,
    },
  };
}

async function resolveAccountId(creds: AwsCredentials): Promise<string> {
  const sts = new STSClient(clientConfig(creds));
  const identity = await sts.send(new GetCallerIdentityCommand({}));
  if (!identity.Account) {
    throw new Error("aws-ecs: could not resolve AWS account id.");
  }

  return identity.Account;
}

function sha256(content: Buffer | string): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

async function uploadSeedBlob(
  ecr: ECRClient,
  repositoryName: string,
  content: Buffer,
  digest: string,
): Promise<void> {
  try {
    const upload = await ecr.send(
      new InitiateLayerUploadCommand({ repositoryName }),
    );
    if (!upload.uploadId || !upload.partSize) {
      throw new Error("aws-ecs: ECR did not return upload coordinates.");
    }

    await ecr.send(
      new UploadLayerPartCommand({
        repositoryName,
        uploadId: upload.uploadId,
        partFirstByte: 0,
        partLastByte: content.length - 1,
        layerPartBlob: content,
      }),
    );
    await ecr.send(
      new CompleteLayerUploadCommand({
        repositoryName,
        uploadId: upload.uploadId,
        layerDigests: [digest],
      }),
    );
  } catch (error) {
    if (
      error instanceof Error &&
      error.name === "LayerAlreadyExistsException"
    ) {
      return;
    }
    throw error;
  }
}

function repositoryNameFromUrl(repositoryUrl: string): string {
  const marker = ".amazonaws.com/";
  const markerIndex = repositoryUrl.indexOf(marker);
  if (markerIndex === -1) {
    throw new Error(
      `aws-ecs: seed repository URL "${repositoryUrl}" is not an ECR repository URL.`,
    );
  }

  return repositoryUrl.slice(markerIndex + marker.length);
}

async function seedImageExists(
  ecr: ECRClient,
  repositoryName: string,
): Promise<boolean> {
  try {
    await ecr.send(
      new DescribeImagesCommand({
        repositoryName,
        imageIds: [{ imageTag: SEED_IMAGE_TAG }],
      }),
    );
    return true;
  } catch (error) {
    if ((error as { name?: string }).name === "ImageNotFoundException") {
      return false;
    }
    throw error;
  }
}

async function ensureSeedImage(
  repositoryUrl: string,
  architecture: string,
  creds: AwsCredentials,
): Promise<string> {
  const repositoryName = repositoryNameFromUrl(repositoryUrl);
  const ecr = new ECRClient(clientConfig(creds));
  if (await seedImageExists(ecr, repositoryName)) {
    return `${repositoryUrl}:${SEED_IMAGE_TAG}`;
  }

  const layer = gzipSync(EMPTY_TAR);
  const layerDigest = sha256(layer);
  const config = Buffer.from(
    JSON.stringify({
      architecture: architecture === "arm64" ? "arm64" : "amd64",
      os: "linux",
      config: {
        Cmd: [
          "sh",
          "-c",
          "echo 'No deployment artifact has been uploaded yet.' && sleep 3600",
        ],
      },
      rootfs: { type: "layers", diff_ids: [sha256(EMPTY_TAR)] },
    }),
  );
  const configDigest = sha256(config);

  await uploadSeedBlob(ecr, repositoryName, layer, layerDigest);
  await uploadSeedBlob(ecr, repositoryName, config, configDigest);
  await ecr.send(
    new PutImageCommand({
      repositoryName,
      imageTag: SEED_IMAGE_TAG,
      imageManifest: JSON.stringify({
        schemaVersion: 2,
        mediaType: DOCKER_MANIFEST_MEDIA_TYPE,
        config: {
          mediaType: DOCKER_CONFIG_MEDIA_TYPE,
          size: config.length,
          digest: configDigest,
        },
        layers: [
          {
            mediaType: DOCKER_LAYER_MEDIA_TYPE,
            size: layer.length,
            digest: layerDigest,
          },
        ],
      }),
      imageManifestMediaType: DOCKER_MANIFEST_MEDIA_TYPE,
    }),
  );

  return `${repositoryUrl}:${SEED_IMAGE_TAG}`;
}

function parseEcrImageUri(uri: string): EcrImageReference {
  const match = uri.match(
    /^(\d{12})\.dkr\.ecr\.([a-z0-9-]+)\.amazonaws\.com\/(.+?)(?::([^/@:]+)|@(sha256:[a-fA-F0-9]{64}))$/,
  );
  if (!match) {
    throw new Error(
      `aws-ecs: ${ECR_DIRECT_ERROR}; received "${uri}". Cross-registry image delivery awaits the platform artifact-materialization contract.`,
    );
  }

  return {
    accountId: match[1],
    region: match[2],
    host: `${match[1]}.dkr.ecr.${match[2]}.amazonaws.com`,
    repository: match[3],
    tag: match[4],
    digest: match[5],
  };
}

function assertSameAccountRegion(
  image: EcrImageReference,
  expectedAccount: string,
  expectedRegion: string,
  receivedUri: string,
): void {
  if (image.accountId !== expectedAccount || image.region !== expectedRegion) {
    throw new Error(
      `aws-ecs: ${ECR_DIRECT_ERROR}; received "${receivedUri}", expected account "${expectedAccount}" / region "${expectedRegion}". Cross-registry image delivery awaits the platform artifact-materialization contract.`,
    );
  }
}

async function resolveDigestPinnedUri(
  ecr: ECRClient,
  image: EcrImageReference,
): Promise<{ digest: string; uri: string }> {
  const result = await ecr.send(
    new DescribeImagesCommand({
      repositoryName: image.repository,
      imageIds: [
        image.digest ? { imageDigest: image.digest } : { imageTag: image.tag },
      ],
    }),
  );
  const digest = result.imageDetails?.[0]?.imageDigest ?? image.digest;
  if (!digest) {
    throw new Error(
      `aws-ecs: could not resolve an ECR manifest digest for "${image.repository}".`,
    );
  }

  return {
    digest,
    uri: `${image.host}/${image.repository}@${digest}`,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveServiceConfigs(config: Config): Record<string, ResolvedServiceConfig> {
  return Object.fromEntries(
    Object.entries(config.services).map(([serviceKey, service]) => [
      serviceKey,
      {
        ...service,
        cpu: service.cpu ?? config.defaults.cpu,
        memoryMb: service.memoryMb ?? config.defaults.memoryMb,
        capacity: service.capacity ?? config.defaults.capacity,
        deployment: service.deployment ?? config.defaults.deployment,
        logRetentionDays:
          service.logRetentionDays ?? config.defaults.logRetentionDays,
        architecture: service.architecture ?? config.defaults.architecture,
      },
    ]),
  );
}

function validateResolvedConfig(
  config: Config,
  services: Record<string, ResolvedServiceConfig>,
): void {
  for (const [serviceKey, service] of Object.entries(services)) {
    validateFargateSize(serviceKey, service.cpu, service.memoryMb);
    if (service.scaling.min > service.scaling.max) {
      throw new Error(
        `aws-ecs: service "${serviceKey}" scaling.min must be less than or equal to scaling.max.`,
      );
    }
    if (
      service.exposure.mode !== "none" &&
      service.port === undefined
    ) {
      throw new Error(
        `aws-ecs: service "${serviceKey}" port is required for exposure mode "${service.exposure.mode}".`,
      );
    }
    if (
      service.exposure.mode === "owned-alb" &&
      service.exposure.publicNames.length > 0 &&
      !service.exposure.certificateArn
    ) {
      throw new Error(
        `aws-ecs: service "${serviceKey}" publicNames requires certificateArn.`,
      );
    }
    if (
      service.exposure.mode === "owned-alb" &&
      service.exposure.certificateArn &&
      service.exposure.publicNames.length === 0
    ) {
      throw new Error(
        `aws-ecs: service "${serviceKey}" certificateArn requires at least one publicName.`,
      );
    }
    if (
      service.scaling.requestsPerTarget !== undefined &&
      service.exposure.mode !== "external-attachment"
    ) {
      throw new Error(
        `aws-ecs: service "${serviceKey}" requestsPerTarget requires external-attachment exposure. Owned ALB blue-green request-count scaling is deferred until the active target group can be tracked safely.`,
      );
    }
    if (
      service.deployment.posture === "blue-green" &&
      service.exposure.mode !== "owned-alb"
    ) {
      throw new Error(
        `aws-ecs: service "${serviceKey}" blue-green deployment requires owned-alb exposure.`,
      );
    }
    if (
      service.exposure.mode === "owned-alb" &&
      service.deployment.posture !== "blue-green"
    ) {
      throw new Error(
        `aws-ecs: service "${serviceKey}" owned-alb exposure requires blue-green deployment.`,
      );
    }
    if (
      service.exposure.mode === "external-attachment" &&
      service.deployment.posture === "blue-green"
    ) {
      throw new Error(
        `aws-ecs: service "${serviceKey}" blue-green deployment with external-attachment exposure is refused.`,
      );
    }
    if (new Set(service.volumes.map((volume) => volume.name)).size !== service.volumes.length) {
      throw new Error(
        `aws-ecs: service "${serviceKey}" volume names must be unique.`,
      );
    }
    const securityGroupCount =
      ECS_TASK_BASE_SECURITY_GROUPS +
      new Set(service.volumes.map((volume) => volume.clientSecurityGroupId)).size;
    if (securityGroupCount > MAX_TASK_SECURITY_GROUPS) {
      throw new Error(
        `aws-ecs: service "${serviceKey}" would attach ${securityGroupCount} security groups to task ENIs; Fargate allows at most ${MAX_TASK_SECURITY_GROUPS}.`,
      );
    }
  }
  if (
    Object.values(services).some((service) => service.exposure.mode === "owned-alb") &&
    (!config.publicSubnetIds || config.publicSubnetIds.length < 2)
  ) {
    throw new Error(
      "aws-ecs: publicSubnetIds must include at least two public subnets for owned-alb exposure.",
    );
  }
}

export function validateFargateSize(
  serviceKey: string,
  cpu: number,
  memoryMb: number,
): void {
  const matrix: Record<number, number[]> = {
    256: [512, 1024, 2048],
    512: [1024, 2048, 3072, 4096],
    1024: range(2048, 8192, 1024),
    2048: range(4096, 16384, 1024),
    4096: range(8192, 30720, 1024),
    8192: range(16384, 61440, 4096),
    16384: range(32768, 122880, 8192),
    32768: [61440, 122880, 249856],
  };
  if (!matrix[cpu]?.includes(memoryMb)) {
    throw new Error(
      `aws-ecs: service "${serviceKey}" cpu ${cpu} and memoryMb ${memoryMb} are not a valid Fargate size.`,
    );
  }
}

function range(start: number, end: number, step: number): number[] {
  const values: number[] = [];
  for (let value = start; value <= end; value += step) {
    values.push(value);
  }
  return values;
}

function serviceFingerprint(service: ResolvedServiceConfig): string {
  return JSON.stringify({
    exposureMode: service.exposure.mode,
    deploymentPosture: service.deployment.posture,
  });
}

function assertServiceFingerprint(
  serviceKey: string,
  stored: string | undefined,
  requested: string,
): void {
  if (stored && stored !== requested) {
    throw new Error(
      `aws-ecs: service "${serviceKey}" exposure.mode and deployment.posture changes are refused because they would replace provision-time traffic identities. Create a new service key and migrate traffic explicitly.`,
    );
  }
}

function assertFleetFingerprint(stored: string | undefined, requested: string): void {
  if (stored && stored !== requested) {
    throw new Error(
      "aws-ecs: discoveryNamespace changes are refused because they replace in-fleet reachability identity. Create a new fleet and migrate callers explicitly.",
    );
  }
}

function capacityProviderStrategy(capacity: ResolvedServiceConfig["capacity"]) {
  if (capacity === "on-demand") {
    return [{ capacityProvider: "FARGATE", weight: 1, base: 1 }];
  }
  if (capacity === "spot") {
    return [{ capacityProvider: "FARGATE_SPOT", weight: 1 }];
  }

  return [
    ...(capacity.baseOnDemand > 0
      ? [{ capacityProvider: "FARGATE", weight: 1, base: capacity.baseOnDemand }]
      : []),
    ...(capacity.spotWeight > 0
      ? [{ capacityProvider: "FARGATE_SPOT", weight: capacity.spotWeight }]
      : []),
  ];
}

function taskPolicyStatements(service: ResolvedServiceConfig): Array<Record<string, any>> {
  const statements = [...service.taskPolicyStatements];
  for (const volume of service.volumes) {
    statements.push({
      Effect: "Allow",
      Action: [
        "elasticfilesystem:ClientMount",
        ...(volume.readOnly ? [] : ["elasticfilesystem:ClientWrite"]),
      ],
      Resource: volume.fileSystemArn,
      Condition: {
        StringEquals: {
          "elasticfilesystem:AccessPointArn": volume.accessPointArn,
        },
      },
    });
  }
  if (service.enableExecuteCommand) {
    statements.push({
      Effect: "Allow",
      Action: [
        "ssmmessages:CreateControlChannel",
        "ssmmessages:CreateDataChannel",
        "ssmmessages:OpenControlChannel",
        "ssmmessages:OpenDataChannel",
      ],
      Resource: "*",
    });
  }
  return statements;
}

function executionPolicyStatements(service: ResolvedServiceConfig): Array<Record<string, any>> {
  const secretArns = Object.values(service.secrets);
  if (secretArns.length === 0) {
    return [];
  }

  return [
    {
      Effect: "Allow",
      Action: ["secretsmanager:GetSecretValue", "ssm:GetParameters"],
      Resource: secretArns,
    },
    ...(service.secretsKmsKeyArn
      ? [
          {
            Effect: "Allow",
            Action: ["kms:Decrypt"],
            Resource: service.secretsKmsKeyArn,
          },
        ]
      : []),
  ];
}

function containerDefinitions(
  service: ResolvedServiceConfig,
  serviceName: string,
  region: string,
  image: string,
): string {
  const portMappings = service.port
    ? [
        {
          containerPort: service.port,
          protocol: "tcp",
          name: CONTAINER_NAME,
          appProtocol: SERVICE_CONNECT_PROTOCOL_HTTP,
        },
      ]
    : undefined;

  return JSON.stringify([
    {
      name: CONTAINER_NAME,
      image,
      essential: true,
      cpu: service.cpu,
      memory: service.memoryMb,
      environment: Object.entries(service.environment).map(([name, value]) => ({
        name,
        value,
      })),
      secrets: Object.entries(service.secrets).map(([name, valueFrom]) => ({
        name,
        valueFrom,
      })),
      command: service.command,
      entryPoint: service.entrypoint,
      portMappings,
      healthCheck: service.health.command
        ? {
            command: service.health.command,
            interval: service.health.intervalSeconds,
            retries: service.health.retries,
            startPeriod: service.health.startPeriodSeconds,
          }
        : undefined,
      mountPoints: service.volumes.map((volume) => ({
        sourceVolume: volume.name,
        containerPath: volume.mountPath,
        readOnly: volume.readOnly,
      })),
      logConfiguration: {
        logDriver: "awslogs",
        options: {
          "awslogs-group": `/aws/ecs/${serviceName}`,
          "awslogs-region": region,
          "awslogs-stream-prefix": CONTAINER_NAME,
        },
      },
    },
  ]);
}

export function taskTemplate(
  family: string,
  serviceName: string,
  service: ResolvedServiceConfig,
  executionRoleArn: string,
  taskRoleArn: string,
  region: string,
  image: string,
): TaskDefinitionTemplate {
  return {
    family,
    requiresCompatibilities: ["FARGATE"],
    networkMode: "awsvpc",
    cpu: String(service.cpu),
    memory: String(service.memoryMb),
    executionRoleArn,
    taskRoleArn,
    containerDefinitions: JSON.parse(
      containerDefinitions(service, serviceName, region, image),
    ),
    runtimePlatform: {
      operatingSystemFamily: "LINUX",
      cpuArchitecture: service.architecture === "arm64" ? "ARM64" : "X86_64",
    },
    ephemeralStorage:
      service.ephemeralStorageGb > DEFAULT_EPHEMERAL_STORAGE_GB
        ? { sizeInGiB: service.ephemeralStorageGb }
        : undefined,
    volumes: service.volumes.map((volume) => ({
      name: volume.name,
      efsVolumeConfiguration: {
        fileSystemId: volume.fileSystemId,
        transitEncryption: EFS_TRANSIT_ENCRYPTION_ENABLED,
        authorizationConfig: {
          accessPointId: volume.accessPointId,
          iam: EFS_IAM_ENABLED,
        },
      },
    })),
  };
}

export function internalEndpoint(
  serviceKey: string,
  namespaceName: string,
  port: number,
): { dnsName: string; port: number; uri: string } {
  const dnsName = `${serviceKey}.${namespaceName}`;
  return { dnsName, port, uri: `${dnsName}:${port}` };
}

export function desiredCountIgnoreChanges(
  activated: boolean,
  scaling: { min: number; max: number },
): string[] {
  return !activated || scaling.max > scaling.min ? ["desiredCount"] : [];
}

export function publicEndpointHost(
  publicNames: string[],
  albDnsName: string,
): string {
  return publicNames[0] ?? albDnsName;
}

export function assertExternalTargetGroupTargetType(
  serviceKey: string,
  targetType: string,
): void {
  if (targetType !== "ip") {
    throw new Error(
      `aws-ecs: service "${serviceKey}" external-attachment target group must use targetType "ip" for Fargate awsvpc tasks.`,
    );
  }
}

export function workloadTarget(
  service: Pick<ResolvedServiceConfig, "port" | "health">,
): WorkloadTarget {
  return {
    targetType: "ip",
    port: service.port!,
    protocol: "HTTP",
    health: {
      protocol: "HTTP",
      path: service.health.path,
      gracePeriodSeconds: service.health.gracePeriodSeconds,
    },
    deregistrationDelaySeconds: DEFAULT_DEREGISTRATION_DELAY_SECONDS,
  };
}

function withImage(
  template: TaskDefinitionTemplate,
  image: string,
): TaskDefinitionTemplate {
  const definitions = (template.containerDefinitions ?? []).map(
    (definition: any) =>
      definition.name === CONTAINER_NAME ? { ...definition, image } : definition,
  );

  return {
    ...template,
    containerDefinitions: definitions,
  };
}

async function waitForServiceRollout(
  ecs: ECSClient,
  clusterArn: string,
  serviceName: string,
): Promise<void> {
  for (let attempt = 0; attempt < ROLLOUT_MAX_ATTEMPTS; attempt += 1) {
    const result = await ecs.send(
      new DescribeServicesCommand({
        cluster: clusterArn,
        services: [serviceName],
      }),
    );
    const service = result.services?.[0];
    const failed = result.failures?.[0];
    if (failed) {
      throw new Error(
        `aws-ecs: rollout failed for service "${serviceName}": ${failed.reason ?? "no reason returned"}`,
      );
    }
    if (service?.deployments?.length === 1 && service.deployments[0].rolloutState === "COMPLETED") {
      return;
    }
    const failedDeployment = service?.deployments?.find(
      (deployment) => deployment.rolloutState === "FAILED",
    );
    if (failedDeployment) {
      throw new Error(
        `aws-ecs: rollout failed for service "${serviceName}": ${failedDeployment.rolloutStateReason ?? "no reason returned"}`,
      );
    }

    await sleep(ROLLOUT_POLL_INTERVAL_MS);
  }

  throw new Error(
    `aws-ecs: timed out waiting for rollout to finish for service "${serviceName}".`,
  );
}

function publicProtocol(service: ResolvedServiceConfig): "http" | "https" {
  return service.exposure.mode === "owned-alb" && service.exposure.certificateArn
    ? "https"
    : "http";
}

function redirectsHttpToHttps(service: ResolvedServiceConfig): boolean {
  return (
    service.exposure.mode === "owned-alb" &&
    !!service.exposure.certificateArn &&
    (service.exposure.redirectHttpToHttps ?? true)
  );
}

function productionListenerConditions(service: ResolvedServiceConfig) {
  const pathCondition = { pathPattern: { values: ["/*"] } };
  if (
    service.exposure.mode === "owned-alb" &&
    service.exposure.publicNames.length > 0
  ) {
    return [
      { hostHeader: { values: service.exposure.publicNames } },
      pathCondition,
    ];
  }

  return [pathCondition];
}

function externalLoadBalancerArn(
  serviceKey: string,
  targetGroup: pulumi.Output<aws.lb.GetTargetGroupResult>,
): pulumi.Output<string> {
  return targetGroup.loadBalancerArns.apply((loadBalancerArns) => {
    if (loadBalancerArns.length !== 1) {
      throw new Error(
        `aws-ecs: service "${serviceKey}" external-attachment target group must be attached to exactly one load balancer before ECS can authorize inbound traffic.`,
      );
    }

    return loadBalancerArns[0];
  });
}

function externalLoadBalancerSecurityGroupId(
  serviceKey: string,
  loadBalancer: pulumi.Output<aws.lb.GetLoadBalancerResult>,
): pulumi.Output<string> {
  return loadBalancer.securityGroups.apply((securityGroupIds) => {
    if (securityGroupIds.length === 0) {
      throw new Error(
        `aws-ecs: service "${serviceKey}" external-attachment load balancer has no security group for reviewed inbound admission.`,
      );
    }

    return securityGroupIds[0];
  });
}

function externalRequestMetricResourceLabel(
  serviceKey: string,
  targetGroup: pulumi.Output<aws.lb.GetTargetGroupResult>,
  loadBalancer: pulumi.Output<aws.lb.GetLoadBalancerResult>,
): pulumi.Output<string> {
  return pulumi
    .all([
      loadBalancer.arnSuffix,
      targetGroup.arnSuffix,
      loadBalancer.loadBalancerType,
    ])
    .apply(([loadBalancerArnSuffix, targetGroupArnSuffix, loadBalancerType]) => {
      if (loadBalancerType !== "application") {
        throw new Error(
          `aws-ecs: service "${serviceKey}" requestsPerTarget requires an Application Load Balancer target group.`,
        );
      }

      return `${loadBalancerArnSuffix}/${targetGroupArnSuffix}`;
    });
}

component.implement(CloudProvider.aws, {
  stateSchema: z.object({
    accountId: z.string().optional(),
    region: z.string().optional(),
    discoveryNamespace: DiscoveryNamespaceSchema.optional(),
    clusterArn: z.string().optional(),
    fleetFingerprint: z.string().optional(),
    serviceFingerprints: z.record(z.string(), z.string()).default({}),
    serviceNames: z.record(z.string(), z.string()).default({}),
    serviceArns: z.record(z.string(), z.string()).default({}),
    taskDefinitionFamilies: z.record(z.string(), z.string()).default({}),
    taskDefinitionArns: z.record(z.string(), z.string()).default({}),
    taskRoleArns: z.record(z.string(), z.string()).default({}),
    executionRoleArns: z.record(z.string(), z.string()).default({}),
    serviceConfigSnapshots: z.record(z.string(), ServiceConfigSchema).default({}),
    taskDefinitionTemplates: z.record(z.string(), z.any()).default({}),
    publicEndpoints: z.record(z.string(), z.string()).default({}),
    ownedAlbDnsNames: z.record(z.string(), z.string()).default({}),
    ownedAlbZoneIds: z.record(z.string(), z.string()).default({}),
    internalEndpoints: z.record(z.string(), z.string()).default({}),
    workloadTargets: z.record(z.string(), WorkloadTargetSchema).default({}),
    imageRepositoryUrl: z.string().optional(),
    allocations: z.record(z.string(), AllocationSchema).default({}),
    activated: z.record(z.string(), z.boolean()).default({}),
    deployedArtifacts: z.record(z.string(), DeployedArtifactSchema).default({}),
  }),
  initialState: {
    serviceFingerprints: {},
    serviceNames: {},
    serviceArns: {},
    taskDefinitionFamilies: {},
    taskDefinitionArns: {},
    taskRoleArns: {},
    executionRoleArns: {},
    serviceConfigSnapshots: {},
    taskDefinitionTemplates: {},
    publicEndpoints: {},
    ownedAlbDnsNames: {},
    ownedAlbZoneIds: {},
    internalEndpoints: {},
    workloadTargets: {},
    allocations: {},
    activated: {},
    deployedArtifacts: {},
  },

  pulumi: async ({ $, inputs, state, aws: provider, getCredentials }) => {
    const config = inputs as Config;
    const services = resolveServiceConfigs(config);
    validateResolvedConfig(config, services);
    const creds = credentialsFrom(getCredentials);
    const awsOpts: pulumi.CustomResourceOptions = provider
      ? { provider }
      : {};
    const awsInvokeOpts: pulumi.InvokeOutputOptions = provider
      ? { provider }
      : {};

    const caller = aws.getCallerIdentityOutput({}, awsOpts);
    const region = aws.getRegionOutput({}, awsOpts).name;
    const cluster = new aws.ecs.Cluster(
      $`cluster`,
      {
        settings: [
          {
            name: "containerInsights",
            value: config.observability.containerInsights,
          },
        ],
        serviceConnectDefaults: {
          namespace: config.discoveryNamespace.arn,
        },
        tags: config.labels,
      },
      awsOpts,
    );
    const clusterCapacityProviders = new aws.ecs.ClusterCapacityProviders(
      $`capacity-providers`,
      {
        clusterName: cluster.name,
        capacityProviders: ["FARGATE", "FARGATE_SPOT"],
      },
      awsOpts,
    );
    const seedRepository = new aws.ecr.Repository(
      $`seed-repo`,
      {
        imageTagMutability: "IMMUTABLE",
        imageScanningConfiguration: { scanOnPush: true },
        tags: config.labels,
      },
      awsOpts,
    );
    const seedImageUri = seedRepository.repositoryUrl.apply((repositoryUrl) =>
      ensureSeedImage(repositoryUrl, config.defaults.architecture, creds),
    );
    const fleetSecurityGroup = new aws.ec2.SecurityGroup(
      $`sg-fleet`,
      {
        name: $`sg-fleet`,
        description: "Managed by sdlc.works aws-ecs component",
        vpcId: config.vpcId,
        egress: [
          {
            protocol: "-1",
            fromPort: 0,
            toPort: 0,
            cidrBlocks: ["0.0.0.0/0"],
            description: "Allow all outbound",
          },
        ],
        revokeRulesOnDelete: true,
        tags: { ...config.labels, Name: $`sg-fleet` },
      },
      awsOpts,
    );

    const fleetFingerprint = JSON.stringify({
      discoveryNamespace: config.discoveryNamespace,
    });
    assertFleetFingerprint(state.fleetFingerprint as string | undefined, fleetFingerprint);
    const serviceFingerprints =
      (state.serviceFingerprints ?? {}) as Record<string, string>;
    const deployedArtifacts =
      (state.deployedArtifacts ?? {}) as Record<string, DeployedArtifact>;
    const allocations = (state.allocations ?? {}) as Record<string, Allocation>;
    const activated = (state.activated ?? {}) as Record<string, boolean>;
    const serviceNames: Record<string, pulumi.Output<string>> = {};
    const serviceArns: Record<string, pulumi.Output<string>> = {};
    const taskDefinitionFamilies: Record<string, string> = {};
    const taskDefinitionArns: Record<string, pulumi.Output<string>> = {};
    const taskRoleArns: Record<string, pulumi.Output<string>> = {};
    const executionRoleArns: Record<string, pulumi.Output<string>> = {};
    const serviceConfigSnapshots: Record<string, ResolvedServiceConfig> = {};
    const taskDefinitionTemplates: Record<string, pulumi.Output<TaskDefinitionTemplate>> = {};
    const publicEndpoints: Record<string, pulumi.Output<string>> = {};
    const ownedAlbDnsNames: Record<string, pulumi.Output<string>> = {};
    const ownedAlbZoneIds: Record<string, pulumi.Output<string>> = {};
    const internalEndpoints: Record<string, string> = {};
    const workloadTargets: Record<string, WorkloadTarget> = {};

    for (const [serviceKey, service] of Object.entries(services)) {
      const serviceActivated = !!activated[serviceKey];
      const serviceDeps: pulumi.Resource[] = [clusterCapacityProviders];
      const fingerprint = serviceFingerprint(service);
      assertServiceFingerprint(serviceKey, serviceFingerprints[serviceKey], fingerprint);
      serviceFingerprints[serviceKey] = fingerprint;

      const serviceName = $`svc-${serviceKey}`;
      const family = $`task-${serviceKey}`;
      const logGroup = new aws.cloudwatch.LogGroup(
        $`logs-${serviceKey}`,
        {
          name: `/aws/ecs/${serviceName}`,
          retentionInDays: service.logRetentionDays,
          tags: config.labels,
        },
        awsOpts,
      );
      const executionRole = new aws.iam.Role(
        $`execution-role-${serviceKey}`,
        {
          assumeRolePolicy: assumeRolePolicy(ECS_TASKS_SERVICE_PRINCIPAL),
          tags: config.labels,
        },
        awsOpts,
      );
      const executionDeps: pulumi.Resource[] = [
        new aws.iam.RolePolicyAttachment(
          $`execution-policy-${serviceKey}`,
          {
            role: executionRole.name,
            policyArn: TASK_EXECUTION_POLICY_ARN,
          },
          awsOpts,
        ),
      ];
      const executionStatements = executionPolicyStatements(service);
      if (executionStatements.length > 0) {
        executionDeps.push(
          new aws.iam.RolePolicy(
            $`execution-inline-${serviceKey}`,
            {
              role: executionRole.name,
              policy: inlinePolicyDocument(executionStatements),
            },
            awsOpts,
          ),
        );
      }
      const taskRole = new aws.iam.Role(
        $`task-role-${serviceKey}`,
        {
          assumeRolePolicy: assumeRolePolicy(ECS_TASKS_SERVICE_PRINCIPAL),
          tags: config.labels,
        },
        awsOpts,
      );
      const taskStatements = taskPolicyStatements(service);
      const taskDeps: pulumi.Resource[] = [];
      if (taskStatements.length > 0) {
        taskDeps.push(
          new aws.iam.RolePolicy(
            $`task-inline-${serviceKey}`,
            {
              role: taskRole.name,
              policy: inlinePolicyDocument(taskStatements),
            },
            awsOpts,
          ),
        );
      }

      const serviceSecurityGroup = new aws.ec2.SecurityGroup(
        $`sg-${serviceKey}`,
        {
          name: $`sg-${serviceKey}`,
          description: "Managed by sdlc.works aws-ecs component",
          vpcId: config.vpcId,
          egress: [
            {
              protocol: "-1",
              fromPort: 0,
              toPort: 0,
              cidrBlocks: ["0.0.0.0/0"],
              description: "Allow all outbound",
            },
          ],
          revokeRulesOnDelete: true,
          tags: { ...config.labels, Name: $`sg-${serviceKey}` },
        },
        awsOpts,
      );
      if (service.exposure.mode === "internal") {
        serviceDeps.push(
          new aws.ec2.SecurityGroupRule(
            $`sg-${serviceKey}-from-fleet`,
            {
              type: "ingress",
              securityGroupId: serviceSecurityGroup.id,
              sourceSecurityGroupId: fleetSecurityGroup.id,
              protocol: "tcp",
              fromPort: service.port!,
              toPort: service.port!,
              description: "Allow in-fleet Service Connect traffic",
            },
            awsOpts,
          ),
        );
      }

      let loadBalancers: aws.types.input.ecs.ServiceLoadBalancer[] | undefined;
      let requestMetricResourceLabel: pulumi.Output<string> | undefined;
      if (service.exposure.mode === "external-attachment") {
        const externalTargetGroup = aws.lb.getTargetGroupOutput(
          { arn: service.exposure.targetGroupArn },
          awsInvokeOpts,
        );
        const validatedTargetGroupArn = pulumi
          .all([externalTargetGroup.arn, externalTargetGroup.targetType])
          .apply(([arn, targetType]) => {
            assertExternalTargetGroupTargetType(serviceKey, targetType);
            return arn;
          });
        const externalLoadBalancer = aws.lb.getLoadBalancerOutput(
          {
            arn: externalLoadBalancerArn(serviceKey, externalTargetGroup),
          },
          awsInvokeOpts,
        );
        const validatedLoadBalancerSecurityGroupId = pulumi
          .all([
            validatedTargetGroupArn,
            externalLoadBalancerSecurityGroupId(
              serviceKey,
              externalLoadBalancer,
            ),
          ])
          .apply(([, securityGroupId]) => securityGroupId);
        serviceDeps.push(
          new aws.ec2.SecurityGroupRule(
            $`sg-${serviceKey}-from-attachment`,
            {
              type: "ingress",
              securityGroupId: serviceSecurityGroup.id,
              sourceSecurityGroupId: validatedLoadBalancerSecurityGroupId,
              protocol: "tcp",
              fromPort: service.port!,
              toPort: service.port!,
              description: "Allow external target attachment traffic",
            },
            awsOpts,
          ),
        );
        loadBalancers = [
          {
            targetGroupArn: validatedTargetGroupArn,
            containerName: CONTAINER_NAME,
            containerPort: service.port!,
          },
        ];
        workloadTargets[serviceKey] = workloadTarget(service);
        if (service.scaling.requestsPerTarget !== undefined) {
          requestMetricResourceLabel = externalRequestMetricResourceLabel(
            serviceKey,
            externalTargetGroup,
            externalLoadBalancer,
          );
        }
      }
      if (service.exposure.mode === "owned-alb") {
        const blueGreenDeployment =
          service.deployment as z.infer<typeof BlueGreenDeploymentSchema>;
        const albSecurityGroup = new aws.ec2.SecurityGroup(
          $`alb-sg-${serviceKey}`,
          {
            name: $`alb-sg-${serviceKey}`,
            description: "Managed by sdlc.works aws-ecs component",
            vpcId: config.vpcId,
            ingress: [
              {
                protocol: "tcp",
                fromPort: service.exposure.certificateArn ? HTTPS_PORT : HTTP_PORT,
                toPort: service.exposure.certificateArn ? HTTPS_PORT : HTTP_PORT,
                cidrBlocks: service.exposure.allowedIngressCidrs,
                description: "Allow production traffic",
              },
              {
                protocol: "tcp",
                fromPort:
                  blueGreenDeployment.testListenerPort ??
                  (service.exposure.certificateArn
                    ? DEFAULT_BLUE_GREEN_HTTPS_TEST_PORT
                    : DEFAULT_BLUE_GREEN_HTTP_TEST_PORT),
                toPort:
                  blueGreenDeployment.testListenerPort ??
                  (service.exposure.certificateArn
                    ? DEFAULT_BLUE_GREEN_HTTPS_TEST_PORT
                    : DEFAULT_BLUE_GREEN_HTTP_TEST_PORT),
                cidrBlocks:
                  service.exposure.testAccessCidrs ??
                  service.exposure.allowedIngressCidrs,
                description: "Allow test traffic",
              },
              ...(redirectsHttpToHttps(service)
                ? [
                    {
                      protocol: "tcp",
                      fromPort: HTTP_PORT,
                      toPort: HTTP_PORT,
                      cidrBlocks: service.exposure.allowedIngressCidrs,
                      description: "Allow HTTP redirect traffic",
                    },
                  ]
                : []),
            ],
            egress: [
              {
                protocol: "-1",
                fromPort: 0,
                toPort: 0,
                cidrBlocks: ["0.0.0.0/0"],
                description: "Allow all outbound",
              },
            ],
            revokeRulesOnDelete: true,
            tags: { ...config.labels, Name: $`alb-sg-${serviceKey}` },
          },
          awsOpts,
        );
        serviceDeps.push(
          new aws.ec2.SecurityGroupRule(
            $`sg-${serviceKey}-from-alb`,
            {
              type: "ingress",
              securityGroupId: serviceSecurityGroup.id,
              sourceSecurityGroupId: albSecurityGroup.id,
              protocol: "tcp",
              fromPort: service.port!,
              toPort: service.port!,
              description: "Allow ALB traffic",
            },
            awsOpts,
          ),
        );
        const loadBalancer = new aws.lb.LoadBalancer(
          $`alb-${serviceKey}`,
          {
            name: $`alb-${serviceKey}`,
            loadBalancerType: "application",
            internal: false,
            subnets: config.publicSubnetIds!,
            securityGroups: [albSecurityGroup.id],
            enableHttp2: true,
            dropInvalidHeaderFields: true,
            tags: { ...config.labels, Name: $`alb-${serviceKey}` },
          },
          awsOpts,
        );
        const targetGroupArgs = {
          targetType: "ip",
          port: service.port!,
          protocol: "HTTP",
          vpcId: config.vpcId,
          deregistrationDelay: service.exposure.deregistrationDelaySeconds,
          healthCheck: {
            path: service.health.path,
            protocol: "HTTP",
          },
          tags: config.labels,
        };
        const blueTargetGroup = new aws.lb.TargetGroup(
          $`tg-${serviceKey}-blue`,
          { ...targetGroupArgs, name: $`tg-${serviceKey}-blue` },
          awsOpts,
        );
        const greenTargetGroup = new aws.lb.TargetGroup(
          $`tg-${serviceKey}-green`,
          { ...targetGroupArgs, name: $`tg-${serviceKey}-green` },
          awsOpts,
        );
        const productionListener = new aws.lb.Listener(
          $`listener-${serviceKey}-prod`,
          {
            loadBalancerArn: loadBalancer.arn,
            port: service.exposure.certificateArn ? HTTPS_PORT : HTTP_PORT,
            protocol: service.exposure.certificateArn ? "HTTPS" : "HTTP",
            certificateArn: service.exposure.certificateArn,
            sslPolicy: service.exposure.certificateArn ? TLS_POLICY : undefined,
            defaultActions: [
              {
                type: "fixed-response",
                fixedResponse: {
                  contentType: "text/plain",
                  messageBody: "No ECS service deployment is active.",
                  statusCode: "503",
                },
              },
            ],
            tags: config.labels,
          },
          awsOpts,
        );
        const productionRule = new aws.lb.ListenerRule(
          $`rule-${serviceKey}-prod`,
          {
            listenerArn: productionListener.arn,
            priority: 1,
            actions: [{ type: "forward", targetGroupArn: blueTargetGroup.arn }],
            conditions: productionListenerConditions(service),
            tags: config.labels,
          },
          awsOpts,
        );
        const testListener = new aws.lb.Listener(
          $`listener-${serviceKey}-test`,
          {
            loadBalancerArn: loadBalancer.arn,
            port:
              blueGreenDeployment.testListenerPort ??
              (service.exposure.certificateArn
                ? DEFAULT_BLUE_GREEN_HTTPS_TEST_PORT
                : DEFAULT_BLUE_GREEN_HTTP_TEST_PORT),
            protocol: service.exposure.certificateArn ? "HTTPS" : "HTTP",
            certificateArn: service.exposure.certificateArn,
            sslPolicy: service.exposure.certificateArn ? TLS_POLICY : undefined,
            defaultActions: [
              {
                type: "fixed-response",
                fixedResponse: {
                  contentType: "text/plain",
                  messageBody: "No ECS test deployment is active.",
                  statusCode: "503",
                },
              },
            ],
            tags: config.labels,
          },
          awsOpts,
        );
        const testRule = new aws.lb.ListenerRule(
          $`rule-${serviceKey}-test`,
          {
            listenerArn: testListener.arn,
            priority: 1,
            actions: [{ type: "forward", targetGroupArn: greenTargetGroup.arn }],
            conditions: [{ pathPattern: { values: ["/*"] } }],
            tags: config.labels,
          },
          awsOpts,
        );
        if (redirectsHttpToHttps(service)) {
          new aws.lb.Listener(
            $`listener-${serviceKey}-redirect`,
            {
              loadBalancerArn: loadBalancer.arn,
              port: HTTP_PORT,
              protocol: "HTTP",
              defaultActions: [
                {
                  type: "redirect",
                  redirect: {
                    protocol: "HTTPS",
                    port: String(HTTPS_PORT),
                    statusCode: "HTTP_301",
                  },
                },
              ],
              tags: config.labels,
            },
            awsOpts,
          );
        }
        const cutoverRole = new aws.iam.Role(
          $`cutover-role-${serviceKey}`,
          {
            assumeRolePolicy: assumeRolePolicy(ECS_SERVICE_PRINCIPAL),
            tags: config.labels,
          },
          awsOpts,
        );
        const cutoverPolicy = new aws.iam.RolePolicy(
          $`cutover-policy-${serviceKey}`,
          {
            role: cutoverRole.name,
            policy: pulumi
              .all([
                productionRule.arn,
                testRule.arn,
                productionListener.arn,
                testListener.arn,
                blueTargetGroup.arn,
                greenTargetGroup.arn,
              ])
              .apply(
                ([
                  productionRuleArn,
                  testRuleArn,
                  productionListenerArn,
                  testListenerArn,
                  blueTargetGroupArn,
                  greenTargetGroupArn,
                ]) =>
                inlinePolicyDocument([
                  {
                    Effect: "Allow",
                    Action: ["elasticloadbalancing:ModifyRule"],
                    Resource: [productionRuleArn, testRuleArn],
                  },
                  {
                    Effect: "Allow",
                    Action: ["elasticloadbalancing:ModifyListener"],
                    Resource: [productionListenerArn, testListenerArn],
                  },
                  {
                    Effect: "Allow",
                    Action: [
                      "elasticloadbalancing:RegisterTargets",
                      "elasticloadbalancing:DeregisterTargets",
                    ],
                    Resource: [blueTargetGroupArn, greenTargetGroupArn],
                  },
                  {
                    Effect: "Allow",
                    Action: [
                      "elasticloadbalancing:DescribeListeners",
                      "elasticloadbalancing:DescribeRules",
                      "elasticloadbalancing:DescribeTargetGroups",
                      "elasticloadbalancing:DescribeTargetHealth",
                    ],
                    Resource: "*",
                  },
                ]),
              ),
          },
          awsOpts,
        );
        serviceDeps.push(cutoverPolicy);
        loadBalancers = [
          {
            targetGroupArn: blueTargetGroup.arn,
            containerName: CONTAINER_NAME,
            containerPort: service.port!,
            advancedConfiguration: {
              alternateTargetGroupArn: greenTargetGroup.arn,
              productionListenerRule: productionRule.arn,
              testListenerRule: testRule.arn,
              roleArn: cutoverRole.arn,
            },
          },
        ];
        const publicNames = service.exposure.publicNames;
        publicEndpoints[serviceKey] = loadBalancer.dnsName.apply(
          (dnsName) =>
            `${publicProtocol(service)}://${publicEndpointHost(
              publicNames,
              dnsName,
            )}`,
        );
        ownedAlbDnsNames[serviceKey] = loadBalancer.dnsName;
        ownedAlbZoneIds[serviceKey] = loadBalancer.zoneId;
      }

      const deployedApp = Object.entries(allocations).find(
        ([, allocation]) => allocation.service === serviceKey,
      )?.[0];
      const deployedImage =
        deployedApp && deployedArtifacts[deployedApp]?.digestPinnedUri
          ? deployedArtifacts[deployedApp].digestPinnedUri
          : undefined;
      const taskDefinition = pulumi
        .all([executionRole.arn, taskRole.arn, region, seedImageUri])
        .apply(([executionRoleArn, taskRoleArn, resolvedRegion, seedImage]) =>
          taskTemplate(
            family,
            serviceName,
            service,
            executionRoleArn,
            taskRoleArn,
            resolvedRegion,
            deployedImage ?? seedImage,
          ),
        );
      const pulumiTaskDefinition = new aws.ecs.TaskDefinition(
        $`task-${serviceKey}`,
        {
          family,
          requiresCompatibilities: ["FARGATE"],
          networkMode: "awsvpc",
          cpu: String(service.cpu),
          memory: String(service.memoryMb),
          executionRoleArn: executionRole.arn,
          taskRoleArn: taskRole.arn,
          containerDefinitions: pulumi
            .all([seedImageUri])
            .apply(([seedImage]) =>
              containerDefinitions(
                service,
                serviceName,
                creds.AWS_REGION,
                deployedImage ?? seedImage,
              ),
            ),
          runtimePlatform: {
            operatingSystemFamily: "LINUX",
            cpuArchitecture: service.architecture === "arm64" ? "ARM64" : "X86_64",
          },
          ephemeralStorage:
            service.ephemeralStorageGb > DEFAULT_EPHEMERAL_STORAGE_GB
              ? { sizeInGib: service.ephemeralStorageGb }
              : undefined,
          volumes: service.volumes.map((volume) => ({
            name: volume.name,
            efsVolumeConfiguration: {
              fileSystemId: volume.fileSystemId,
              transitEncryption: EFS_TRANSIT_ENCRYPTION_ENABLED,
              authorizationConfig: {
                accessPointId: volume.accessPointId,
                iam: EFS_IAM_ENABLED,
              },
            },
          })),
          tags: config.labels,
        },
        {
          ...awsOpts,
          dependsOn: [logGroup, ...executionDeps, ...taskDeps],
        },
      );

      const endpoint =
        service.exposure.mode === "internal"
          ? internalEndpoint(
              serviceKey,
              config.discoveryNamespace.name,
              service.port!,
            )
          : undefined;
      const serviceConnectConfiguration = {
        enabled: true,
        namespace: config.discoveryNamespace.arn,
        services:
          endpoint
            ? [
                {
                  portName: CONTAINER_NAME,
                  discoveryName: serviceKey,
                  clientAlias: [
                    {
                      dnsName: endpoint.dnsName,
                      port: endpoint.port,
                    },
                  ],
                },
              ]
            : undefined,
      };
      if (endpoint) {
        internalEndpoints[serviceKey] = endpoint.uri;
      }

      const ecsService = new aws.ecs.Service(
        $`service-${serviceKey}`,
        {
          name: serviceName,
          cluster: cluster.arn,
          taskDefinition: pulumiTaskDefinition.arn,
          capacityProviderStrategies: capacityProviderStrategy(service.capacity),
          platformVersion: FARGATE_PLATFORM_VERSION,
          desiredCount: serviceActivated ? service.scaling.min : 0,
          networkConfiguration: {
            subnets: config.privateSubnetIds,
            securityGroups: [
              fleetSecurityGroup.id,
              serviceSecurityGroup.id,
              ...Array.from(
                new Set(
                  service.volumes.map((volume) => volume.clientSecurityGroupId),
                ),
              ),
            ],
            assignPublicIp: false,
          },
          deploymentCircuitBreaker:
            service.deployment.posture === "rolling"
              ? {
                  enable: service.deployment.circuitBreaker.enabled,
                  rollback: service.deployment.circuitBreaker.rollback,
                }
              : undefined,
          deploymentConfiguration:
            service.deployment.posture === "rolling"
              ? {
                  strategy: "ROLLING",
                }
              : {
                  strategy: "BLUE_GREEN",
                  bakeTimeInMinutes: String(service.deployment.bakeTimeMinutes),
                },
          deploymentMinimumHealthyPercent:
            service.deployment.posture === "rolling"
              ? service.deployment.minimumHealthyPercent
              : undefined,
          deploymentMaximumPercent:
            service.deployment.posture === "rolling"
              ? service.deployment.maximumPercent
              : undefined,
          deploymentController: { type: "ECS" },
          healthCheckGracePeriodSeconds: service.health.gracePeriodSeconds,
          enableExecuteCommand: service.enableExecuteCommand,
          serviceConnectConfiguration,
          loadBalancers,
          tags: config.labels,
        },
        {
          ...awsOpts,
          dependsOn: serviceDeps,
          ignoreChanges: desiredCountIgnoreChanges(
            serviceActivated,
            service.scaling,
          ),
        },
      );

      if (service.scaling.max > service.scaling.min) {
        const resourceId = pulumi.interpolate`service/${cluster.name}/${ecsService.name}`;
        const target = new aws.appautoscaling.Target(
          $`scaling-${serviceKey}`,
          {
            maxCapacity: service.scaling.max,
            minCapacity: serviceActivated ? service.scaling.min : 0,
            resourceId,
            scalableDimension: ECS_DESIRED_COUNT_DIMENSION,
            serviceNamespace: ECS_SERVICE_NAMESPACE,
          },
          awsOpts,
        );
        const policyBase = {
          policyType: TARGET_TRACKING_POLICY_TYPE,
          resourceId: target.resourceId,
          scalableDimension: target.scalableDimension,
          serviceNamespace: target.serviceNamespace,
        };
        new aws.appautoscaling.Policy(
          $`scaling-${serviceKey}-cpu`,
          {
            ...policyBase,
            targetTrackingScalingPolicyConfiguration: {
              targetValue: service.scaling.targetCpuPercent,
              disableScaleIn: !serviceActivated,
              predefinedMetricSpecification: {
                predefinedMetricType: CPU_METRIC_TYPE,
              },
            },
          },
          awsOpts,
        );
        if (service.scaling.targetMemoryPercent !== undefined) {
          new aws.appautoscaling.Policy(
            $`scaling-${serviceKey}-memory`,
            {
              ...policyBase,
              targetTrackingScalingPolicyConfiguration: {
                targetValue: service.scaling.targetMemoryPercent,
                disableScaleIn: !serviceActivated,
                predefinedMetricSpecification: {
                  predefinedMetricType: MEMORY_METRIC_TYPE,
                },
              },
            },
            awsOpts,
          );
        }
        if (
          service.scaling.requestsPerTarget !== undefined &&
          requestMetricResourceLabel
        ) {
          new aws.appautoscaling.Policy(
            $`scaling-${serviceKey}-requests`,
            {
              ...policyBase,
              targetTrackingScalingPolicyConfiguration: {
                targetValue: service.scaling.requestsPerTarget,
                disableScaleIn: !serviceActivated,
                predefinedMetricSpecification: {
                  predefinedMetricType: ALB_REQUEST_METRIC_TYPE,
                  resourceLabel: requestMetricResourceLabel,
                },
              },
            },
            awsOpts,
          );
        }
      }

      serviceNames[serviceKey] = ecsService.name;
      serviceArns[serviceKey] = ecsService.arn;
      taskDefinitionFamilies[serviceKey] = family;
      taskDefinitionArns[serviceKey] = pulumiTaskDefinition.arn;
      taskRoleArns[serviceKey] = taskRole.arn;
      executionRoleArns[serviceKey] = executionRole.arn;
      serviceConfigSnapshots[serviceKey] = service;
      taskDefinitionTemplates[serviceKey] = taskDefinition;
    }

    state.accountId = caller.accountId as any;
    state.region = region as any;
    state.discoveryNamespace = config.discoveryNamespace;
    (state as any).clusterArn = cluster.arn;
    state.fleetFingerprint = fleetFingerprint;
    state.serviceFingerprints = serviceFingerprints;
    (state as any).serviceNames = serviceNames;
    (state as any).serviceArns = serviceArns;
    state.taskDefinitionFamilies = taskDefinitionFamilies;
    (state as any).taskDefinitionArns = taskDefinitionArns;
    (state as any).taskRoleArns = taskRoleArns;
    (state as any).executionRoleArns = executionRoleArns;
    state.serviceConfigSnapshots = serviceConfigSnapshots;
    (state as any).taskDefinitionTemplates = taskDefinitionTemplates;
    (state as any).publicEndpoints = publicEndpoints;
    (state as any).ownedAlbDnsNames = ownedAlbDnsNames;
    (state as any).ownedAlbZoneIds = ownedAlbZoneIds;
    state.internalEndpoints = internalEndpoints;
    state.workloadTargets = workloadTargets;
    (state as any).imageRepositoryUrl = seedRepository.repositoryUrl;

    return {
      region,
      clusterArn: cluster.arn,
      serviceNames: pulumi.output(serviceNames),
      serviceArns: pulumi.output(serviceArns),
      taskRoleArns: pulumi.output(taskRoleArns),
      publicEndpoints: pulumi.output(publicEndpoints),
      ownedAlbDnsNames: pulumi.output(ownedAlbDnsNames),
      ownedAlbZoneIds: pulumi.output(ownedAlbZoneIds),
      internalEndpoints: pulumi.output(internalEndpoints),
      workloadTargets: pulumi.output(workloadTargets),
      namespaceArn: pulumi.output(config.discoveryNamespace.arn),
    };
  },

  allocateComponent: async ({ name, deploymentConfig, state }: any) => {
    const config = deploymentConfig as AppComponentConfig;
    const snapshots =
      (state.serviceConfigSnapshots ?? {}) as Record<string, ResolvedServiceConfig>;
    const allocations = (state.allocations ?? {}) as Record<string, Allocation>;

    if (!state.serviceConfigSnapshots) {
      throw new Error(CONFIG_SNAPSHOT_MISSING_ERROR);
    }
    if (!(config.service in snapshots)) {
      throw new Error(
        `aws-ecs: app component "${name}" requested unknown service "${config.service}".`,
      );
    }
    for (const [allocatedApp, allocation] of Object.entries(allocations)) {
      if (allocatedApp !== name && allocation.service === config.service) {
        throw new Error(
          `aws-ecs: service "${config.service}" is already allocated to app component "${allocatedApp}". Service mappings must be injective.`,
        );
      }
    }

    allocations[name] = { service: config.service };
    state.allocations = allocations;
  },

  connect: (({ state, selfComponentName }: any) => [
    connectionHandler({
      interface: PublicCI,
      handler: async (_ctx: any) => {
        const allocations = (state.allocations ?? {}) as Record<string, Allocation>;
        const allocation = allocations[selfComponentName];
        if (!allocation) {
          throw new Error(
            `aws-ecs: no service mapping found for app component "${selfComponentName}" while resolving public connection.`,
          );
        }
        const service = ((state.serviceConfigSnapshots ?? {}) as Record<string, ResolvedServiceConfig>)[allocation.service];
        const endpoint = (state.publicEndpoints ?? {})[allocation.service];
        if (!service || service.exposure.mode !== "owned-alb" || !endpoint) {
          throw new Error(
            `aws-ecs: service "${allocation.service}" does not expose a public connection.`,
          );
        }
        const host = (state.ownedAlbDnsNames ?? {})[allocation.service];
        const protocol = publicProtocol(service);
        return {
          uri: endpoint,
          metadata: {
            appComponentType: "service",
            host,
            protocol,
            port: protocol === "https" ? HTTPS_PORT : HTTP_PORT,
            originAddressed: false,
            serviceName: allocation.service,
          },
        };
      },
    }),
    connectionHandler({
      interface: InternalServiceCI,
      handler: async (_ctx: any) => {
        const allocations = (state.allocations ?? {}) as Record<string, Allocation>;
        const allocation = allocations[selfComponentName];
        if (!allocation) {
          throw new Error(
            `aws-ecs: no service mapping found for app component "${selfComponentName}" while resolving internal connection.`,
          );
        }
        const service = ((state.serviceConfigSnapshots ?? {}) as Record<string, ResolvedServiceConfig>)[allocation.service];
        if (!service || service.exposure.mode !== "internal") {
          throw new Error(
            `aws-ecs: service "${allocation.service}" does not expose an internal connection.`,
          );
        }
        const endpoint = (state.internalEndpoints ?? {})[allocation.service];
        const [endpointHost, rawPort] = endpoint.split(":");
        const port = Number(rawPort);
        return {
          uri: pulumi.output(`http://${endpoint}`),
          metadata: {
            uri: `http://${endpoint}`,
            host: endpointHost,
            port,
            protocol: "http" as const,
            serviceName: allocation.service,
          },
        };
      },
    }),
  ]) as any,

  upsertArtifacts: async ({ buildArtifacts, state, getCredentials }) => {
    const entries = Object.entries(buildArtifacts);
    if (entries.length === 0) {
      console.error("aws-ecs: no artifacts to deploy");
      return;
    }

    const serviceNames = (state.serviceNames ?? {}) as Record<string, string>;
    const clusterArn = (state.clusterArn as string | undefined);
    const templates =
      (state.taskDefinitionTemplates ?? {}) as Record<string, TaskDefinitionTemplate>;
    const snapshots =
      (state.serviceConfigSnapshots ?? {}) as Record<string, ResolvedServiceConfig>;
    if (!state.serviceConfigSnapshots || !state.serviceNames || !state.taskDefinitionTemplates) {
      throw new Error(CONFIG_SNAPSHOT_MISSING_ERROR);
    }
    if (!clusterArn) {
      throw new Error(CONFIG_SNAPSHOT_MISSING_ERROR);
    }

    const creds = credentialsFrom(getCredentials);
    const accountId = await resolveAccountId(creds);
    const ecs = new ECSClient(clientConfig(creds));
    const ecr = new ECRClient(clientConfig(creds));
    const allocations = (state.allocations ?? {}) as Record<string, Allocation>;
    const deployedArtifacts =
      (state.deployedArtifacts ?? {}) as Record<string, DeployedArtifact>;
    const activated = (state.activated ?? {}) as Record<string, boolean>;

    for (const [componentName, artifactInfo] of entries) {
      const allocation = allocations[componentName];
      if (!allocation) {
        throw new Error(
          `aws-ecs: no service mapping found for app component "${componentName}".`,
        );
      }
      const serviceName = serviceNames[allocation.service];
      const snapshot = snapshots[allocation.service];
      const template = templates[allocation.service];
      if (!serviceName || !snapshot || !template) {
        throw new Error(
          `aws-ecs: mapping for app component "${componentName}" points to unknown service "${allocation.service}".`,
        );
      }
      const artifact = artifactInfo.artifact;
      if (artifact.type !== DeploymentArtifactType.oci_spec_image) {
        throw new Error(
          `aws-ecs: service "${allocation.service}" expects an OCI image artifact, received "${artifact.type}".`,
        );
      }

      const image = parseEcrImageUri(artifact.uri);
      assertSameAccountRegion(image, accountId, creds.AWS_REGION, artifact.uri);
      const pinned = await resolveDigestPinnedUri(ecr, image);
      const registration = await ecs.send(
        new RegisterTaskDefinitionCommand(withImage(template, pinned.uri)),
      );
      const taskDefinitionArn = registration.taskDefinition?.taskDefinitionArn;
      if (!taskDefinitionArn) {
        throw new Error(
          `aws-ecs: ECS did not return a task definition ARN for service "${allocation.service}".`,
        );
      }

      await ecs.send(
        new UpdateServiceCommand({
          cluster: clusterArn,
          service: serviceName,
          taskDefinition: taskDefinitionArn,
          desiredCount: activated[allocation.service]
            ? undefined
            : snapshot.scaling.min,
        }),
      );
      await waitForServiceRollout(ecs, clusterArn, serviceName);

      deployedArtifacts[componentName] = {
        service: allocation.service,
        deliveredUri: artifact.uri,
        digest: pinned.digest,
        digestPinnedUri: pinned.uri,
        taskDefinitionArn,
      };
      activated[allocation.service] = true;
    }

    state.deployedArtifacts = deployedArtifacts;
    state.activated = activated;
  },
});

export default component;
