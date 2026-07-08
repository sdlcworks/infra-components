import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

import {
  CompleteLayerUploadCommand,
  DescribeImagesCommand,
  ECRClient,
  InitiateLayerUploadCommand,
  PutImageCommand,
  UploadLayerPartCommand,
} from "@aws-sdk/client-ecr";
import {
  GetFunctionConfigurationCommand,
  LambdaClient,
  UpdateFunctionCodeCommand,
} from "@aws-sdk/client-lambda";
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

import { PublicCI } from "../_internal/interfaces";

const LAMBDA_SERVICE_PRINCIPAL = "lambda.amazonaws.com";
const BASIC_EXECUTION_POLICY_ARN =
  "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole";
const VPC_ACCESS_POLICY_ARN =
  "arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole";
const PACKAGE_TYPE_IMAGE = "Image";
const PACKAGE_TYPE_ZIP = "Zip";
const SEED_IMAGE_TAG = "sdlc-seed";
const DEFAULT_TIMEOUT_SECONDS = 30;
const DEFAULT_LOG_RETENTION_DAYS = 30;
const DEFAULT_ARCHITECTURE = "x86_64";
const DEFAULT_EPHEMERAL_STORAGE_MB = 512;
const UPDATE_POLL_INTERVAL_MS = 5_000;
const UPDATE_MAX_ATTEMPTS = 120;
const DOCKER_MANIFEST_MEDIA_TYPE =
  "application/vnd.docker.distribution.manifest.v2+json";
const DOCKER_CONFIG_MEDIA_TYPE =
  "application/vnd.docker.container.image.v1+json";
const DOCKER_LAYER_MEDIA_TYPE =
  "application/vnd.docker.image.rootfs.diff.tar.gzip";
const EMPTY_TAR = Buffer.alloc(1024);
const CONFIG_SNAPSHOT_MISSING_ERROR =
  "aws-lambda: config snapshot missing from state; pulumi() must run before allocateComponent or upsertArtifacts.";
const PACKAGING_FINGERPRINT_ERROR_PREFIX =
  "aws-lambda: packaging change refused";
const PACKAGING_FINGERPRINT_ERROR_MESSAGE =
  "Changing a function packaging mode would replace the Lambda function and churn provision-time identities. Create a new function key and migrate traffic explicitly.";
const ECR_DIRECT_ERROR =
  "image artifacts must be published through a same-account, same-region ECR-backed artifact registry (`aws-ecr`)";

const PackagingSchema = z.enum(["image", "zip"]);
const ArchitectureSchema = z.enum(["x86_64", "arm64"]);
const FunctionUrlAuthorizationSchema = z.enum(["none", "iam"]);

const FunctionUrlSchema = z.object({
  authorization: FunctionUrlAuthorizationSchema,
});

const OnAsyncFailureSchema = z.object({
  destinationArn: z.string().min(1),
});

const FunctionConfigSchema = z
  .object({
    packaging: PackagingSchema,
    memoryMb: z.number().int().min(128).max(10240),
    handler: z.string().min(1).optional(),
    runtime: z.string().min(1).optional(),
    functionUrl: FunctionUrlSchema.optional(),
    onAsyncFailure: OnAsyncFailureSchema.optional(),
    reservedConcurrency: z.number().int().min(0).optional(),
    timeoutSeconds: z
      .number()
      .int()
      .min(1)
      .max(900)
      .default(DEFAULT_TIMEOUT_SECONDS),
    logRetentionDays: z
      .number()
      .int()
      .positive()
      .default(DEFAULT_LOG_RETENTION_DAYS),
    architecture: ArchitectureSchema.default(DEFAULT_ARCHITECTURE),
    ephemeralStorageMb: z
      .number()
      .int()
      .min(512)
      .max(10240)
      .default(DEFAULT_EPHEMERAL_STORAGE_MB),
    environment: z.record(z.string(), z.string()).default({}),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.packaging === "zip") {
      if (!value.handler) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["handler"],
          message: "aws-lambda: zip functions require handler.",
        });
      }
      if (!value.runtime) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["runtime"],
          message: "aws-lambda: zip functions require runtime.",
        });
      }
      return;
    }

    if (value.handler) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["handler"],
        message: "aws-lambda: image functions must not set handler.",
      });
    }
    if (value.runtime) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["runtime"],
        message: "aws-lambda: image functions must not set runtime.",
      });
    }
  });

const VpcConfigSchema = z.object({
  subnetIds: z.array(z.string().min(1)).min(1),
  securityGroupIds: z.array(z.string().min(1)).optional(),
});

const ConfigSchema = z
  .object({
    functions: z.record(z.string(), FunctionConfigSchema).refine(
      (functions) => Object.keys(functions).length > 0,
      "aws-lambda: functions must declare at least one function.",
    ),
    vpcConfig: VpcConfigSchema.optional(),
    executionRoleArn: z.string().min(1).optional(),
    policyStatements: z.array(z.record(z.string(), z.any())).default([]),
    labels: z.record(z.string(), z.string()).default({}),
  })
  .superRefine((value, ctx) => {
    if (value.executionRoleArn && value.policyStatements.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["executionRoleArn"],
        message:
          "aws-lambda: executionRoleArn is mutually exclusive with policyStatements because external roles own their own policy surface.",
      });
    }
  });

const AppComponentSchema = z.object({
  function: z.string().min(1),
});

const AllocationSchema = z.object({
  function: z.string(),
});

const DeployedArtifactSchema = z.object({
  function: z.string(),
  type: z.nativeEnum(DeploymentArtifactType),
  deliveredUri: z.string(),
  digest: z.string().optional(),
  digestPinnedUri: z.string().optional(),
});

type Config = z.infer<typeof ConfigSchema>;
type FunctionConfig = z.infer<typeof FunctionConfigSchema>;
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

const component = new InfraComponent({
  metadata: {
    stateful: true,
    proxiable: true,
  },
  acceptedArtifactTypes: [
    DeploymentArtifactType.oci_spec_image,
    DeploymentArtifactType.file,
  ],
  connectionTypes: {
    public: {
      description: "public Lambda function URL for a mapped app function",
      interface: PublicCI,
    },
  } as const,
  connectionInterfaces: [PublicCI],
  configSchema: ConfigSchema,
  appComponentTypes: {
    function: AppComponentSchema,
  },
  outputSchema: z.object({
    region: z.string(),
    functionNames: z.record(z.string(), z.string()),
    functionArns: z.record(z.string(), z.string()),
    functionUrls: z.record(z.string(), z.string()),
  }),
});

function assumeRolePolicy(): string {
  return JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Principal: {
          Service: LAMBDA_SERVICE_PRINCIPAL,
        },
        Action: "sts:AssumeRole",
      },
    ],
  });
}

function inlinePolicyDocument(statements: Array<Record<string, any>>): string {
  return JSON.stringify({
    Version: "2012-10-17",
    Statement: statements,
  });
}

function packagingFingerprint(fn: FunctionConfig): string {
  return JSON.stringify({ packaging: fn.packaging });
}

function assertPackagingFingerprint(
  functionKey: string,
  storedFingerprint: string | undefined,
  requestedFingerprint: string,
): void {
  if (storedFingerprint && storedFingerprint !== requestedFingerprint) {
    throw new Error(
      `${PACKAGING_FINGERPRINT_ERROR_PREFIX} for function "${functionKey}". ${PACKAGING_FINGERPRINT_ERROR_MESSAGE}`,
    );
  }
}

function zipSeedArchive(): pulumi.asset.AssetArchive {
  return new pulumi.asset.AssetArchive({
    "index.js": new pulumi.asset.StringAsset(
      "exports.handler = async () => ({ statusCode: 503, body: 'No deployment artifact has been uploaded yet.' });\n",
    ),
  });
}

function functionUrlAuthorization(value: "none" | "iam"): string {
  return value === "none" ? "NONE" : "AWS_IAM";
}

function lambdaArchitecture(value: "x86_64" | "arm64"): string {
  return value === "x86_64" ? "x86_64" : "arm64";
}

function dockerArchitecture(value: "x86_64" | "arm64"): string {
  return value === "x86_64" ? "amd64" : "arm64";
}

function sha256(buffer: Buffer): string {
  return `sha256:${createHash("sha256").update(buffer).digest("hex")}`;
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

function credentialsFrom(getCredentials: () => unknown): AwsCredentials {
  const creds = getCredentials() as AwsCredentials;
  if (
    !creds?.AWS_ACCESS_KEY_ID ||
    !creds?.AWS_SECRET_ACCESS_KEY ||
    !creds?.AWS_REGION
  ) {
    throw new Error(
      "aws-lambda: AWS credentials must include AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, and AWS_REGION.",
    );
  }

  return creds;
}

async function resolveAccountId(creds: AwsCredentials): Promise<string> {
  const sts = new STSClient(clientConfig(creds));
  const identity = await sts.send(new GetCallerIdentityCommand({}));
  if (!identity.Account) {
    throw new Error("aws-lambda: STS caller identity did not include an account ID.");
  }

  return identity.Account;
}

function repositoryNameFromUrl(repositoryUrl: string): string {
  const marker = ".amazonaws.com/";
  const markerIndex = repositoryUrl.indexOf(marker);
  if (markerIndex === -1) {
    throw new Error(
      `aws-lambda: seed repository URL "${repositoryUrl}" is not an ECR repository URL.`,
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
  architecture: "x86_64" | "arm64",
  creds: AwsCredentials,
): Promise<string> {
  const repositoryName = repositoryNameFromUrl(repositoryUrl);
  const ecr = new ECRClient(clientConfig(creds));
  if (await seedImageExists(ecr, repositoryName)) {
    return `${repositoryUrl}:${SEED_IMAGE_TAG}`;
  }

  const layer = gzipSync(EMPTY_TAR);
  const layerDigest = sha256(layer);
  const diffId = sha256(EMPTY_TAR);
  const config = Buffer.from(
    JSON.stringify({
      architecture: dockerArchitecture(architecture),
      os: "linux",
      config: {
        Entrypoint: ["/bootstrap"],
      },
      rootfs: {
        type: "layers",
        diff_ids: [diffId],
      },
      history: [
        {
          created_by: "sdlc aws-lambda seed image",
        },
      ],
    }),
  );
  const configDigest = sha256(config);

  const upload = await ecr.send(
    new InitiateLayerUploadCommand({ repositoryName }),
  );
  if (!upload.uploadId) {
    throw new Error("aws-lambda: ECR did not return a layer upload ID.");
  }

  await ecr.send(
    new UploadLayerPartCommand({
      repositoryName,
      uploadId: upload.uploadId,
      partFirstByte: 0,
      partLastByte: layer.length - 1,
      layerPartBlob: layer,
    }),
  );
  await ecr.send(
    new CompleteLayerUploadCommand({
      repositoryName,
      uploadId: upload.uploadId,
      layerDigests: [layerDigest],
    }),
  );

  const manifest = {
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
  };

  await ecr.send(
    new PutImageCommand({
      repositoryName,
      imageTag: SEED_IMAGE_TAG,
      imageManifest: JSON.stringify(manifest),
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
      `aws-lambda: ${ECR_DIRECT_ERROR}; received "${uri}". Cross-registry image delivery awaits the platform artifact-materialization contract.`,
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
      `aws-lambda: ${ECR_DIRECT_ERROR}; received "${receivedUri}", expected account "${expectedAccount}" / region "${expectedRegion}". Cross-registry image delivery awaits the platform artifact-materialization contract.`,
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
        image.digest
          ? { imageDigest: image.digest }
          : { imageTag: image.tag },
      ],
    }),
  );
  const digest = result.imageDetails?.[0]?.imageDigest ?? image.digest;
  if (!digest) {
    throw new Error(
      `aws-lambda: could not resolve an ECR manifest digest for "${image.repository}".`,
    );
  }

  return {
    digest,
    uri: `${image.host}/${image.repository}@${digest}`,
  };
}

function artifactFilePath(uri: string): string {
  if (uri.startsWith("file://")) {
    return fileURLToPath(uri);
  }

  return uri;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForLambdaUpdate(
  lambda: LambdaClient,
  functionName: string,
): Promise<void> {
  for (let attempt = 0; attempt < UPDATE_MAX_ATTEMPTS; attempt += 1) {
    const config = await lambda.send(
      new GetFunctionConfigurationCommand({ FunctionName: functionName }),
    );
    if (config.LastUpdateStatus === "Successful") {
      return;
    }
    if (config.LastUpdateStatus === "Failed") {
      throw new Error(
        `aws-lambda: update failed for "${functionName}": ${config.LastUpdateStatusReason ?? "no reason returned"}`,
      );
    }

    await sleep(UPDATE_POLL_INTERVAL_MS);
  }

  throw new Error(
    `aws-lambda: timed out waiting for update to finish for "${functionName}".`,
  );
}

component.implement(CloudProvider.aws, {
  stateSchema: z.object({
    accountId: z.string().optional(),
    region: z.string().optional(),
    packagingFingerprints: z.record(z.string(), z.string()).default({}),
    functionPackagings: z.record(z.string(), PackagingSchema).default({}),
    functionNames: z.record(z.string(), z.string()).default({}),
    functionArns: z.record(z.string(), z.string()).default({}),
    functionUrls: z.record(z.string(), z.string()).default({}),
    functionUrlHosts: z.record(z.string(), z.string()).default({}),
    imageRepositoryUrls: z.record(z.string(), z.string()).default({}),
    allocations: z.record(z.string(), AllocationSchema).default({}),
    deployedArtifacts: z.record(z.string(), DeployedArtifactSchema).default({}),
  }),
  initialState: {
    packagingFingerprints: {},
    functionPackagings: {},
    functionNames: {},
    functionArns: {},
    functionUrls: {},
    functionUrlHosts: {},
    imageRepositoryUrls: {},
    allocations: {},
    deployedArtifacts: {},
  },

  pulumi: async ({ $, inputs, state, aws: provider, getCredentials }) => {
    const config = inputs as Config;
    const creds = credentialsFrom(getCredentials);
    const awsOpts: pulumi.CustomResourceOptions = provider
      ? { provider }
      : {};

    const caller = aws.getCallerIdentityOutput({}, awsOpts);
    const region = aws.getRegionOutput({}, awsOpts).name;
    const role =
      config.executionRoleArn === undefined
        ? new aws.iam.Role(
            $`role`,
            {
              assumeRolePolicy: assumeRolePolicy(),
              tags: config.labels,
            },
            awsOpts,
        )
        : undefined;
    const executionRoleArn = config.executionRoleArn ?? role!.arn;
    const roleDependencies: pulumi.Resource[] = [];

    if (role) {
      roleDependencies.push(
        new aws.iam.RolePolicyAttachment(
          $`basic-logs-policy`,
          {
            role: role.name,
            policyArn: BASIC_EXECUTION_POLICY_ARN,
          },
          awsOpts,
        ),
      );

      if (config.vpcConfig) {
        roleDependencies.push(
          new aws.iam.RolePolicyAttachment(
            $`vpc-access-policy`,
            {
              role: role.name,
              policyArn: VPC_ACCESS_POLICY_ARN,
            },
            awsOpts,
          ),
        );
      }

      if (config.policyStatements.length > 0) {
        roleDependencies.push(
          new aws.iam.RolePolicy(
            $`inline-policy`,
            {
              role: role.name,
              policy: inlinePolicyDocument(config.policyStatements),
            },
            awsOpts,
          ),
        );
      }
    }

    const packagingFingerprints =
      (state.packagingFingerprints ?? {}) as Record<string, string>;
    const functionPackagings: Record<string, "image" | "zip"> = {};
    const functionNames: Record<string, pulumi.Output<string>> = {};
    const functionArns: Record<string, pulumi.Output<string>> = {};
    const functionUrls: Record<string, pulumi.Output<string>> = {};
    const functionUrlHosts: Record<string, pulumi.Output<string>> = {};
    const imageRepositoryUrls: Record<string, pulumi.Output<string>> = {};

    for (const [functionKey, fn] of Object.entries(config.functions)) {
      const fingerprint = packagingFingerprint(fn);
      assertPackagingFingerprint(
        functionKey,
        packagingFingerprints[functionKey],
        fingerprint,
      );

      const functionName = $`fn-${functionKey}`;
      const logGroup = new aws.cloudwatch.LogGroup(
        $`logs-${functionKey}`,
        {
          name: `/aws/lambda/${functionName}`,
          retentionInDays: fn.logRetentionDays,
          tags: config.labels,
        },
        awsOpts,
      );

      let imageUri: pulumi.Output<string> | undefined;
      if (fn.packaging === "image") {
        const repository = new aws.ecr.Repository(
          $`seed-repo-${functionKey}`,
          {
            imageTagMutability: "IMMUTABLE",
            imageScanningConfiguration: {
              scanOnPush: true,
            },
            tags: config.labels,
          },
          awsOpts,
        );

        imageRepositoryUrls[functionKey] = repository.repositoryUrl;
        imageUri = repository.repositoryUrl.apply((repositoryUrl) =>
          ensureSeedImage(repositoryUrl, fn.architecture, creds),
        );
      }

      const lambdaFunction = new aws.lambda.Function(
        $`function-${functionKey}`,
        {
          name: functionName,
          role: executionRoleArn,
          packageType: fn.packaging === "image"
            ? PACKAGE_TYPE_IMAGE
            : PACKAGE_TYPE_ZIP,
          architectures: [lambdaArchitecture(fn.architecture)],
          memorySize: fn.memoryMb,
          timeout: fn.timeoutSeconds,
          ephemeralStorage: {
            size: fn.ephemeralStorageMb,
          },
          reservedConcurrentExecutions: fn.reservedConcurrency,
          environment:
            Object.keys(fn.environment).length > 0
              ? { variables: fn.environment }
              : undefined,
          vpcConfig: config.vpcConfig
            ? {
                subnetIds: config.vpcConfig.subnetIds,
                securityGroupIds: config.vpcConfig.securityGroupIds ?? [],
              }
            : undefined,
          handler: fn.packaging === "zip" ? fn.handler : undefined,
          runtime: fn.packaging === "zip" ? fn.runtime : undefined,
          code: fn.packaging === "zip" ? zipSeedArchive() : undefined,
          imageUri,
          tags: config.labels,
        },
        {
          ...awsOpts,
          dependsOn: [logGroup, ...roleDependencies],
          ignoreChanges: [
            "code",
            "sourceCodeHash",
            "codeSha256",
            "imageUri",
            "s3Bucket",
            "s3Key",
            "s3ObjectVersion",
          ],
        },
      );

      functionNames[functionKey] = lambdaFunction.name;
      functionArns[functionKey] = lambdaFunction.arn;
      functionPackagings[functionKey] = fn.packaging;
      packagingFingerprints[functionKey] = fingerprint;

      if (fn.functionUrl) {
        const functionUrl = new aws.lambda.FunctionUrl(
          $`url-${functionKey}`,
          {
            functionName: lambdaFunction.name,
            authorizationType: functionUrlAuthorization(
              fn.functionUrl.authorization,
            ),
          },
          awsOpts,
        );
        functionUrls[functionKey] = functionUrl.functionUrl;
        functionUrlHosts[functionKey] = functionUrl.functionUrl.apply(
          (value) => new URL(value).host,
        );
      }

      if (fn.onAsyncFailure) {
        new aws.lambda.FunctionEventInvokeConfig(
          $`async-${functionKey}`,
          {
            functionName: lambdaFunction.name,
            destinationConfig: {
              onFailure: {
                destination: fn.onAsyncFailure.destinationArn,
              },
            },
          },
          awsOpts,
        );
      }
    }

    state.accountId = caller.accountId as any;
    state.region = region as any;
    state.packagingFingerprints = packagingFingerprints;
    state.functionPackagings = functionPackagings;
    (state as any).functionNames = functionNames;
    (state as any).functionArns = functionArns;
    (state as any).functionUrls = functionUrls;
    (state as any).functionUrlHosts = functionUrlHosts;
    (state as any).imageRepositoryUrls = imageRepositoryUrls;

    return {
      region,
      functionNames: pulumi.output(functionNames),
      functionArns: pulumi.output(functionArns),
      functionUrls: pulumi.output(functionUrls),
    };
  },

  allocateComponent: async ({ name, deploymentConfig, state }: any) => {
    const config = deploymentConfig as AppComponentConfig;
    const functionPackagings =
      (state.functionPackagings ?? {}) as Record<string, "image" | "zip">;
    const allocations = (state.allocations ?? {}) as Record<string, Allocation>;

    if (!state.functionPackagings) {
      throw new Error(CONFIG_SNAPSHOT_MISSING_ERROR);
    }
    if (!(config.function in functionPackagings)) {
      throw new Error(
        `aws-lambda: app component "${name}" requested unknown function "${config.function}".`,
      );
    }

    for (const [allocatedApp, allocation] of Object.entries(allocations)) {
      if (allocatedApp !== name && allocation.function === config.function) {
        throw new Error(
          `aws-lambda: function "${config.function}" is already allocated to app component "${allocatedApp}". Function mappings must be injective.`,
        );
      }
    }

    allocations[name] = { function: config.function };
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
            `aws-lambda: no function mapping found for app component "${selfComponentName}".`,
          );
        }

        const host = (state.functionUrlHosts ?? {})[allocation.function];
        const url = (state.functionUrls ?? {})[allocation.function];
        if (!host || !url) {
          throw new Error(
            `aws-lambda: function "${allocation.function}" has no configured function URL.`,
          );
        }

        return {
          uri: url,
          metadata: {
            appComponentType: "function",
            host,
            protocol: "https" as const,
            port: 443,
          },
        };
      },
    }),
  ]),

  upsertArtifacts: async ({ buildArtifacts, state, getCredentials }) => {
    const entries = Object.entries(buildArtifacts);
    if (entries.length === 0) {
      console.error("aws-lambda: no artifacts to deploy");
      return;
    }

    const creds = credentialsFrom(getCredentials);
    const accountId = await resolveAccountId(creds);
    const lambda = new LambdaClient(clientConfig(creds));
    const ecr = new ECRClient(clientConfig(creds));
    const allocations = (state.allocations ?? {}) as Record<string, Allocation>;
    const functionNames = (state.functionNames ?? {}) as Record<string, string>;
    const functionPackagings =
      (state.functionPackagings ?? {}) as Record<string, "image" | "zip">;
    const deployedArtifacts =
      (state.deployedArtifacts ?? {}) as Record<string, DeployedArtifact>;

    for (const [componentName, artifactInfo] of entries) {
      const allocation = allocations[componentName];
      if (!allocation) {
        throw new Error(
          `aws-lambda: no function mapping found for app component "${componentName}".`,
        );
      }

      const functionName = functionNames[allocation.function];
      const packaging = functionPackagings[allocation.function];
      if (!functionName || !packaging) {
        throw new Error(
          `aws-lambda: mapping for app component "${componentName}" points to unknown function "${allocation.function}".`,
        );
      }

      const artifact = artifactInfo.artifact;
      if (
        packaging === "image" &&
        artifact.type !== DeploymentArtifactType.oci_spec_image
      ) {
        throw new Error(
          `aws-lambda: function "${allocation.function}" expects an OCI image artifact, received "${artifact.type}".`,
        );
      }
      if (packaging === "zip" && artifact.type !== DeploymentArtifactType.file) {
        throw new Error(
          `aws-lambda: function "${allocation.function}" expects a file artifact, received "${artifact.type}".`,
        );
      }

      if (packaging === "zip") {
        const path = artifactFilePath(artifact.uri);
        await lambda.send(
          new UpdateFunctionCodeCommand({
            FunctionName: functionName,
            ZipFile: readFileSync(path),
          }),
        );
        await waitForLambdaUpdate(lambda, functionName);
        deployedArtifacts[componentName] = {
          function: allocation.function,
          type: artifact.type,
          deliveredUri: artifact.uri,
        };
        continue;
      }

      const image = parseEcrImageUri(artifact.uri);
      assertSameAccountRegion(image, accountId, creds.AWS_REGION, artifact.uri);
      const pinned = await resolveDigestPinnedUri(ecr, image);
      await lambda.send(
        new UpdateFunctionCodeCommand({
          FunctionName: functionName,
          ImageUri: pinned.uri,
        }),
      );
      await waitForLambdaUpdate(lambda, functionName);

      deployedArtifacts[componentName] = {
        function: allocation.function,
        type: artifact.type,
        deliveredUri: artifact.uri,
        digest: pinned.digest,
        digestPinnedUri: pinned.uri,
      };
    }

    state.deployedArtifacts = deployedArtifacts;
  },
});

export default component;
