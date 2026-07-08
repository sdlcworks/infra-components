import { Buffer } from "node:buffer";
import { execFileSync } from "node:child_process";

import {
  CreateRepositoryCommand,
  DescribeRepositoriesCommand,
  ECRClient,
  GetAuthorizationTokenCommand,
  PutLifecyclePolicyCommand,
} from "@aws-sdk/client-ecr";
import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import {
  ArtifactRegistry,
  DeploymentArtifactType,
  type CloudCredentialAWS,
} from "@sdlcworks/components";
import { z } from "zod";

const DEFAULT_IMAGE_TAG_MUTABILITY = "IMMUTABLE";
const DEFAULT_SCAN_ON_PUSH = true;
const DEFAULT_UNTAGGED_IMAGE_EXPIRY_DAYS = 7;
const ECR_HOST_SUFFIX = "amazonaws.com";
const LIFECYCLE_RULE_PRIORITY = 1;
const LIFECYCLE_RULE_DESCRIPTION =
  "Expire untagged publish debris after the configured retention window";
const CREDENTIAL_ERROR =
  "aws-ecr: AWS credentials must include AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, and AWS_REGION.";
const REPOSITORY_NAME_ERROR =
  "aws-ecr: repository names must be lowercase ECR repository paths with no leading or trailing slash.";

const RepositoryPathSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(
    /^[a-z0-9]+(?:[._/-]?[a-z0-9]+)*$/,
    REPOSITORY_NAME_ERROR,
  )
  .refine((value) => !value.includes("//"), REPOSITORY_NAME_ERROR)
  .refine((value) => !value.startsWith("/"), REPOSITORY_NAME_ERROR)
  .refine((value) => !value.endsWith("/"), REPOSITORY_NAME_ERROR);

const ImageTagMutabilitySchema = z.enum(["IMMUTABLE", "MUTABLE"]);

const ConfigSchema = z.object({
  repositoryPrefix: RepositoryPathSchema,
  imageTagMutability: ImageTagMutabilitySchema.default(
    DEFAULT_IMAGE_TAG_MUTABILITY,
  ),
  scanOnPush: z.boolean().default(DEFAULT_SCAN_ON_PUSH),
  untaggedImageExpiryDays: z
    .number()
    .int()
    .positive()
    .default(DEFAULT_UNTAGGED_IMAGE_EXPIRY_DAYS),
  kmsKeyArn: z.string().min(1).optional(),
  labels: z.record(z.string(), z.string()).default({}),
});

const StateSchema = z.object({
  accountId: z.string(),
  region: z.string(),
  repositoryPrefix: z.string(),
  imageTagMutability: ImageTagMutabilitySchema,
  scanOnPush: z.boolean(),
  untaggedImageExpiryDays: z.number().int().positive(),
  kmsKeyArn: z.string().optional(),
  labels: z.record(z.string(), z.string()).default({}),
});

type AwsEcrConfig = z.infer<typeof ConfigSchema>;
type AwsEcrState = z.infer<typeof StateSchema>;
type AwsCredentials = CloudCredentialAWS & {
  AWS_SESSION_TOKEN?: string;
};

function credentialsFrom(getCredentials: () => unknown): AwsCredentials {
  const creds = getCredentials() as AwsCredentials;
  if (
    !creds?.AWS_ACCESS_KEY_ID ||
    !creds?.AWS_SECRET_ACCESS_KEY ||
    !creds?.AWS_REGION
  ) {
    throw new Error(CREDENTIAL_ERROR);
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
    throw new Error("aws-ecr: STS caller identity did not include an account ID.");
  }

  return identity.Account;
}

function registryHost(state: AwsEcrState): string {
  return `${state.accountId}.dkr.ecr.${state.region}.${ECR_HOST_SUFFIX}`;
}

function repositoryName(
  state: AwsEcrState,
  componentName: string,
  label: string,
): string {
  const name = `${state.repositoryPrefix}/${componentName}-${label}`;
  const parsed = RepositoryPathSchema.safeParse(name);
  if (!parsed.success) {
    throw new Error(`${REPOSITORY_NAME_ERROR} Received "${name}".`);
  }

  return name;
}

function lifecyclePolicy(expiryDays: number): string {
  return JSON.stringify({
    rules: [
      {
        rulePriority: LIFECYCLE_RULE_PRIORITY,
        description: LIFECYCLE_RULE_DESCRIPTION,
        selection: {
          tagStatus: "untagged",
          countType: "sinceImagePushed",
          countUnit: "days",
          countNumber: expiryDays,
        },
        action: {
          type: "expire",
        },
      },
    ],
  });
}

async function dockerLogin(ecr: ECRClient, host: string): Promise<void> {
  const auth = await ecr.send(new GetAuthorizationTokenCommand({}));
  const token = auth.authorizationData?.[0]?.authorizationToken;
  if (!token) {
    throw new Error("aws-ecr: ECR did not return an authorization token.");
  }

  const decoded = Buffer.from(token, "base64").toString("utf8");
  const [username, password] = decoded.split(":", 2);
  if (!username || !password) {
    throw new Error("aws-ecr: ECR authorization token was malformed.");
  }

  execFileSync(
    "docker",
    ["login", "--username", username, "--password-stdin", host],
    { input: password, stdio: ["pipe", "inherit", "inherit"] },
  );
}

async function ensureRepository(
  ecr: ECRClient,
  state: AwsEcrState,
  name: string,
): Promise<void> {
  try {
    await ecr.send(new DescribeRepositoriesCommand({ repositoryNames: [name] }));
    return;
  } catch (error) {
    if ((error as { name?: string }).name !== "RepositoryNotFoundException") {
      throw error;
    }
  }

  try {
    await ecr.send(
      new CreateRepositoryCommand({
        repositoryName: name,
        imageTagMutability: state.imageTagMutability,
        imageScanningConfiguration: {
          scanOnPush: state.scanOnPush,
        },
        encryptionConfiguration: state.kmsKeyArn
          ? {
              encryptionType: "KMS",
              kmsKey: state.kmsKeyArn,
            }
          : undefined,
        tags: Object.entries(state.labels).map(([Key, Value]) => ({
          Key,
          Value,
        })),
      }),
    );
  } catch (error) {
    if ((error as { name?: string }).name !== "RepositoryAlreadyExistsException") {
      throw error;
    }
  }

  await ecr.send(
    new PutLifecyclePolicyCommand({
      repositoryName: name,
      lifecyclePolicyText: lifecyclePolicy(state.untaggedImageExpiryDays),
    }),
  );
}

const registry = new ArtifactRegistry({
  acceptedArtifactTypes: [DeploymentArtifactType.oci_spec_image],
  configSchema: ConfigSchema,
  stateSchema: StateSchema,
  provision: async ({ config, state, getCredentials }) => {
    const effective = config as unknown as AwsEcrConfig;
    const creds = credentialsFrom(getCredentials);
    const accountId = await resolveAccountId(creds);

    state.accountId = accountId;
    state.region = creds.AWS_REGION;
    state.repositoryPrefix = effective.repositoryPrefix;
    state.imageTagMutability = effective.imageTagMutability;
    state.scanOnPush = effective.scanOnPush;
    state.untaggedImageExpiryDays = effective.untaggedImageExpiryDays;
    state.kmsKeyArn = effective.kmsKeyArn;
    state.labels = effective.labels;
  },
  publish: async ({ componentName, artifacts, version, state, getCredentials }) => {
    const effectiveState = state as unknown as AwsEcrState;
    const creds = credentialsFrom(getCredentials);
    const ecr = new ECRClient(clientConfig(creds));
    const host = registryHost(effectiveState);

    await dockerLogin(ecr, host);

    const pushed: Record<string, { uri: string }> = {};
    for (const [label, artifact] of Object.entries(artifacts)) {
      const name = repositoryName(effectiveState, componentName, label);
      const target = `${host}/${name}:${version}`;

      await ensureRepository(ecr, effectiveState, name);

      execFileSync("docker", ["tag", artifact.uri, target], {
        stdio: ["inherit", "inherit", "inherit"],
      });
      execFileSync("docker", ["push", target], {
        stdio: ["inherit", "inherit", "inherit"],
      });

      console.error(`Pushed ${target}`);
      pushed[label] = { uri: target };
    }

    return { artifacts: pushed };
  },
});

export default registry;
