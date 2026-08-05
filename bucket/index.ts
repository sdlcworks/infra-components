import { z } from "zod";
import { createHash } from "crypto";

import {
  InfraComponent,
  connectionHandler,
} from "@sdlcworks/components";

import * as gcp from "@pulumi/gcp";
import * as cloudflare from "@pulumi/cloudflare";
import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";

import { ServiceAccountCI, R2BucketCI, S3BucketCI } from "../_internal/interfaces";

// ---- Zod Enums for Config Options ----

const StorageClass = z.enum(["STANDARD", "NEARLINE", "COLDLINE", "ARCHIVE"]);

const PublicAccessPrevention = z.enum(["inherited", "enforced"]);

const UniformBucketLevelAccess = z.boolean();

// R2-specific enums
const R2Jurisdiction = z.enum(["default", "eu", "fedramp"]);

const R2Location = z.enum(["apac", "eeur", "enam", "weur", "wnam", "oc"]);

const R2StorageClass = z.enum(["Standard", "InfrequentAccess"]);

// ---- Reusable Schema Definitions ----

const LifecycleRuleSchema = z.object({
  action: z.object({
    type: z.enum([
      "Delete",
      "SetStorageClass",
      "AbortIncompleteMultipartUpload",
    ]),
    storageClass: StorageClass.optional(),
  }),
  condition: z.object({
    age: z.number().optional(),
    createdBefore: z.string().optional(),
    withState: z.enum(["LIVE", "ARCHIVED", "ANY"]).optional(),
    matchesPrefix: z.array(z.string()).optional(),
    matchesSuffix: z.array(z.string()).optional(),
    numNewerVersions: z.number().optional(),
    daysSinceNoncurrentTime: z.number().optional(),
    daysSinceCustomTime: z.number().optional(),
  }),
});

const CorsRuleSchema = z.object({
  origins: z.array(z.string()),
  methods: z.array(z.string()),
  responseHeaders: z.array(z.string()).optional(),
  maxAgeSeconds: z.number().optional(),
});

const RetentionPolicySchema = z.object({
  retentionPeriod: z.number().describe("Retention period in seconds"),
  isLocked: z.boolean().default(false),
});

// ---- Component Definition ----

const component = new InfraComponent({
  metadata: {
    stateful: true,
    proxiable: false,
  },
  connectionTypes: {
    read: {
      description: "allows read-only access to bucket objects",
      interface: ServiceAccountCI,
    },
    write: {
      description: "allows read and write access to bucket objects",
      interface: ServiceAccountCI,
    },
  } as const,
  connectionInterfaces: [R2BucketCI, S3BucketCI],
  configSchema: z.object({
    // Core (GCloud)
    location: z
      .string()
      .default("us-central1")
      .optional()
      .describe("Region or multi-region (e.g., 'US', 'EU', 'us-central1')"),

    // Storage Configuration (GCloud)
    storageClass: StorageClass.default("STANDARD").optional(),
    uniformBucketLevelAccess: UniformBucketLevelAccess.default(true).optional(),
    publicAccessPrevention: PublicAccessPrevention.default("inherited").optional(),

    // Versioning
    versioning: z.boolean().default(false),

    // Lifecycle Management
    lifecycleRules: z.array(LifecycleRuleSchema).default([]),

    // CORS Configuration
    corsRules: z.array(CorsRuleSchema).default([]),

    // Retention Policy (GCloud)
    retentionPolicy: RetentionPolicySchema.optional(),

    // Encryption (optional - uses Google-managed keys by default) (GCloud)
    encryptionKeyName: z
      .string()
      .optional()
      .describe("Customer-managed encryption key"),

    // Labels (GCloud)
    labels: z.record(z.string(), z.string()).default({}),

    // Force destroy (for development)
    forceDestroy: z
      .boolean()
      .default(false)
      .describe("Allow deletion of non-empty bucket"),

    // Cloudflare R2-specific fields
    accountId: z.string().optional(),
    jurisdiction: R2Jurisdiction.optional(),
    r2Location: R2Location.optional(),
    r2StorageClass: R2StorageClass.optional(),
  }),
  appComponentTypes: {
    "default": z.object({}),
    "bucket": z.object({
      name: z.string(),
      publicAccess: z.boolean().default(false),
    }),
  },
  outputSchema: z.object({
    id: z.string(),
    name: z.string(),
    selfLink: z.string().optional(),
    url: z.string(),
    location: z.string(),
    storageClass: z.string(),
  }),
});

// ---- GCloud Provider Implementation ----

component.implement("gcloud", {
  stateSchema: z.object({
    bucketName: z.string(),
    allocations: z.record(z.string(), z.object({
      bucketName: z.string(),
    })).default({}),
  }),
  initialState: { allocations: {} },

  pulumi: async ({ $, inputs, state, gcp: gcpProvider }) => {
    const {
      location,
      storageClass,
      uniformBucketLevelAccess,
      publicAccessPrevention,
      versioning,
      lifecycleRules,
      corsRules,
      retentionPolicy,
      encryptionKeyName,
      labels,
      forceDestroy,
    } = inputs;

    const gcpOpts: pulumi.CustomResourceOptions = gcpProvider
      ? { provider: gcpProvider }
      : {};

    // Generate bucket name and store in state for connection handlers
    const bucketName = $`bucket`;
    state.bucketName = bucketName;

    const bucket = new gcp.storage.Bucket(bucketName, {
      name: bucketName,
      location: location,
      storageClass: storageClass,
      uniformBucketLevelAccess: uniformBucketLevelAccess,
      publicAccessPrevention: publicAccessPrevention,
      versioning: versioning ? { enabled: true } : undefined,
      lifecycleRules: lifecycleRules.map((rule) => ({
        action: {
          type: rule.action.type,
          storageClass: rule.action.storageClass,
        },
        condition: {
          age: rule.condition.age,
          createdBefore: rule.condition.createdBefore,
          withState: rule.condition.withState,
          matchesPrefixes: rule.condition.matchesPrefix,
          matchesSuffixes: rule.condition.matchesSuffix,
          numNewerVersions: rule.condition.numNewerVersions,
          daysSinceNoncurrentTime: rule.condition.daysSinceNoncurrentTime,
          daysSinceCustomTime: rule.condition.daysSinceCustomTime,
        },
      })),
      cors:
        corsRules.length > 0
          ? corsRules.map((rule) => ({
              origins: rule.origins,
              methods: rule.methods,
              responseHeaders: rule.responseHeaders,
              maxAgeSeconds: rule.maxAgeSeconds,
            }))
          : undefined,
      retentionPolicy: retentionPolicy
        ? {
            retentionPeriod: retentionPolicy.retentionPeriod,
            isLocked: retentionPolicy.isLocked,
          }
        : undefined,
      encryption: encryptionKeyName
        ? { defaultKmsKeyName: encryptionKeyName }
        : undefined,
      labels: labels,
      forceDestroy: forceDestroy,
    }, gcpOpts);

    return {
      id: bucket.id,
      name: bucket.name,
      selfLink: bucket.selfLink,
      url: bucket.url,
      location: bucket.location,
      storageClass: bucket.storageClass,
    };
  },

  allocateWithPulumiCtx: async ({ name, state }: any) => {
    if (!state.allocations) state.allocations = {};
    state.allocations[name] = { bucketName: state.bucketName };
  },

  connect: ({ state, selfComponentName }: any) => [
    connectionHandler({
      interface: ServiceAccountCI,
      handler: async (ctx: any) => {
        const a = (state.allocations ?? {})[selfComponentName] ?? { bucketName: state.bucketName };
        const role =
          ctx.connectionType === "read"
            ? "roles/storage.objectViewer"
            : "roles/storage.objectAdmin";

        // Per-consumer IAM binding cannot be auto-created in v2 (the
        // consumer's identity is no longer plumbed through ctx.connectionData
        // — that channel was removed). Consumers must use a service
        // account with appropriate project-level GCS access.

        return {
          uri: pulumi.interpolate`gs://${a.bucketName}`,
          metadata: {
            role,
            email: undefined,
          },
        };
      },
    }),
  ],
});

// ---- Cloudflare Provider Implementation ----

component.implement("cloudflare", {
  stateSchema: z.object({
    // Instance-level — set in pulumi(), shared by all bucket targets.
    r2AccessKeyId: z.string().optional(),
    r2SecretAccessKey: z.string().optional(),
    // Per-target.
    allocations: z.record(z.string(), z.object({
      bucketName: z.string(),
      accountId: z.string(),
      publicUrl: z.string(),
    })).default({}),
  }),
  initialState: { allocations: {} },

  // Per-instance: mint an account-scoped R2 API token using CLOUDFLARE_API_TOKEN
  // from cloud_credentials. Permission group IDs are looked up by name at
  // provision time (no hardcoding, no KV). R2 S3 keys derive from the token:
  //   access_key_id     = token.id
  //   secret_access_key = sha256_hex(token.value)
  pulumi: async ({
    $,
    state,
    getCredentials,
  }) => {
    const creds = (getCredentials() as Record<string, string>) || {};
    const accountId = creds.CLOUDFLARE_ACCOUNT_ID;
    const apiToken = creds.CLOUDFLARE_API_TOKEN;
    if (!accountId || !apiToken) {
      throw new Error(
        "bucket(cloudflare): CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN must be present in cloud_credentials.cloudflare",
      );
    }

    // Resolve R2 perm group IDs by name at provision time. The Pulumi
    // cloudflare data source only knows the /user/ endpoint, which 403s for
    // account-scoped (cfat_) tokens. Hit the account endpoint directly.
    const pgRes = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/tokens/permission_groups?scope=com.cloudflare.api.account`,
      { headers: { Authorization: `Bearer ${apiToken}` } },
    );
    if (!pgRes.ok) {
      const text = await pgRes.text();
      throw new Error(
        `bucket(cloudflare): failed to list permission groups (${pgRes.status}): ${text}`,
      );
    }
    const pgJson = (await pgRes.json()) as {
      result?: Array<{ id: string; name: string }>;
    };
    const allPgs = pgJson.result ?? [];
    const findPgId = (name: string): string => {
      const match = allPgs.find((p) => p.name === name);
      if (!match) {
        throw new Error(
          `bucket(cloudflare): permission group '${name}' not found in account-scoped catalogue (${allPgs.length} total)`,
        );
      }
      return match.id;
    };
    const readPgId = findPgId("Workers R2 Storage Read");
    const writePgId = findPgId("Workers R2 Storage Write");

    // The cloudflare.ApiToken Pulumi resource hits /user/tokens which 403s
    // for account-scoped (cfat_) tokens. Mint via the account endpoint
    // directly. Idempotency: if we already have an accessKeyId in state,
    // skip the mint.
    const existingId: string | undefined = (state as any).r2AccessKeyId;
    if (!existingId) {
      const tokenName = `${$`r2-token`}`;
      const tokenRes = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${accountId}/tokens`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            name: tokenName,
            policies: [
              {
                effect: "allow",
                permission_groups: [{ id: readPgId }, { id: writePgId }],
                resources: {
                  [`com.cloudflare.api.account.${accountId}`]: "*",
                },
              },
            ],
          }),
        },
      );
      if (!tokenRes.ok) {
        const text = await tokenRes.text();
        throw new Error(
          `bucket(cloudflare): R2 token mint failed (${tokenRes.status}): ${text}`,
        );
      }
      const tokenJson = (await tokenRes.json()) as {
        result?: { id?: string; value?: string };
      };
      const t = tokenJson.result ?? {};
      if (!t.id || !t.value) {
        throw new Error(
          `bucket(cloudflare): R2 token mint response missing fields: ${JSON.stringify(tokenJson)}`,
        );
      }
      // R2 S3 secret = sha256_hex(token.value). Per Cloudflare R2 docs.
      const secret = createHash("sha256").update(t.value).digest("hex");
      (state as any).r2AccessKeyId = t.id;
      (state as any).r2SecretAccessKey = secret;
    }

    return {} as any;
  },

  // Per-target: create the R2 bucket and (optional) public managed domain.
  allocateWithPulumiCtx: async ({
    name,
    deploymentConfig,
    state,
    $,
    getCredentials,
    cloudflare: cfProvider,
  }) => {
    const creds = (getCredentials() as Record<string, string>) || {};
    const accountId = creds.CLOUDFLARE_ACCOUNT_ID;

    const bucketName: string = deploymentConfig.name;
    const publicAccess: boolean = deploymentConfig.publicAccess === true;

    const cfOpts: pulumi.CustomResourceOptions = cfProvider
      ? { provider: cfProvider }
      : {};

    const bucket = new cloudflare.R2Bucket(
      $`r2-${name}`,
      {
        accountId,
        name: bucketName,
        location: "enam",
      },
      cfOpts,
    );

    let publicUrl: pulumi.Output<string> = pulumi.output("");
    if (publicAccess) {
      const managed = new cloudflare.R2ManagedDomain(
        $`r2-pub-${name}`,
        {
          accountId,
          bucketName,
          enabled: true,
        },
        { dependsOn: [bucket], ...cfOpts },
      );
      publicUrl = pulumi.interpolate`https://${managed.domain}`;
    }

    if (!(state as any).allocations) {
      (state as any).allocations = {};
    }
    (state as any).allocations[name] = {
      bucketName,
      accountId,
      publicUrl,
    };
  },

  connect: (({ state, selfComponentName }: any) => [
    connectionHandler({
      interface: R2BucketCI,
      handler: async (_ctx: any) => {
        const allocations = (state.allocations ?? {}) as Record<string, any>;
        const a = allocations[selfComponentName];
        if (!a) {
          throw new Error(
            `bucket(cloudflare): no allocation found for '${selfComponentName}' — was it allocated via allocateWithPulumiCtx?`,
          );
        }
        return {
          uri: pulumi.interpolate`r2://${a.bucketName}`,
          metadata: {
            bucketName: a.bucketName,
            accountId: a.accountId,
            accessKeyId: state.r2AccessKeyId,
            secretAccessKey: state.r2SecretAccessKey,
            publicUrl: a.publicUrl ?? "",
          },
        };
      },
    }),
  ]),
});

// ---- AWS Provider Implementation ----

const AWS_S3_EMPTY_PUBLIC_URL = "";
const AWS_S3_DEFAULT_SSE_ALGORITHM = "AES256";
const AWS_S3_KMS_SSE_ALGORITHM = "aws:kms";
const AWS_S3_OBJECT_OWNERSHIP = "BucketOwnerEnforced";
const AWS_S3_LIFECYCLE_STATUS_ENABLED = "Enabled";
const AWS_S3_VERSIONING_STATUS_ENABLED = "Enabled";
const AWS_S3_LIFECYCLE_VERSIONING_DEPENDENCY_MISSING_ERROR =
  "bucket(aws): lifecycle rules require versioning but BucketVersioning was not created";
const AWS_POLICY_VERSION = "2012-10-17";
const AWS_S3_PUBLIC_READ_ACTION = "s3:GetObject";
const AWS_S3_PUBLIC_PRINCIPAL = "*";

type BucketLifecycleRule = z.infer<typeof LifecycleRuleSchema>;
type AwsLifecycleRule = aws.types.input.s3.BucketLifecycleConfigurationRule;

function isPositiveAwsLifecycleDay(value: number | undefined): value is number {
  return typeof value === "number" && value > 0;
}

function hasUnsupportedAwsLifecycleCondition(rule: BucketLifecycleRule): boolean {
  const condition = rule.condition;
  return Boolean(
    condition.createdBefore ||
      (condition.matchesSuffix && condition.matchesSuffix.length > 0) ||
      condition.daysSinceCustomTime !== undefined,
  );
}

function awsLifecyclePrefixes(rule: BucketLifecycleRule): string[] {
  const prefixes = rule.condition.matchesPrefix;
  return prefixes && prefixes.length > 0 ? prefixes : [""];
}

function translateAwsLifecycleRules(
  lifecycleRules: BucketLifecycleRule[],
  versioningEnabled: boolean,
): AwsLifecycleRule[] {
  const translated: AwsLifecycleRule[] = [];

  for (const [index, rule] of lifecycleRules.entries()) {
    // Equivalent subset only. Skip cases that would require broadening scope
    // or inventing an AWS-specific meaning:
    // - SetStorageClass transitions (GCP and S3 storage-class enums differ)
    // - createdBefore, matchesSuffix, daysSinceCustomTime
    // - Delete rules without a positive age/current-days value
    // - Noncurrent-version rules without versioning enabled or without
    //   daysSinceNoncurrentTime
    if (hasUnsupportedAwsLifecycleCondition(rule)) {
      continue;
    }

    const prefixes = awsLifecyclePrefixes(rule);

    for (const [prefixIndex, prefix] of prefixes.entries()) {
      const idSuffix = prefixes.length > 1 ? `${index}-${prefixIndex}` : `${index}`;
      const baseRule = {
        id: `rule-${idSuffix}`,
        status: AWS_S3_LIFECYCLE_STATUS_ENABLED,
        filter: { prefix },
      };

      if (rule.action.type === "Delete") {
        const isNoncurrentRule =
          rule.condition.daysSinceNoncurrentTime !== undefined ||
          rule.condition.withState === "ARCHIVED" ||
          rule.condition.numNewerVersions !== undefined;

        if (isNoncurrentRule) {
          if (
            !versioningEnabled ||
            !isPositiveAwsLifecycleDay(rule.condition.daysSinceNoncurrentTime)
          ) {
            continue;
          }

          translated.push({
            ...baseRule,
            noncurrentVersionExpiration: {
              noncurrentDays: rule.condition.daysSinceNoncurrentTime,
              ...(isPositiveAwsLifecycleDay(rule.condition.numNewerVersions)
                ? { newerNoncurrentVersions: rule.condition.numNewerVersions }
                : {}),
            },
          });
          continue;
        }

        if (!isPositiveAwsLifecycleDay(rule.condition.age)) {
          continue;
        }

        translated.push({
          ...baseRule,
          expiration: {
            days: rule.condition.age,
          },
        });
        continue;
      }

      if (rule.action.type === "AbortIncompleteMultipartUpload") {
        if (!isPositiveAwsLifecycleDay(rule.condition.age)) {
          continue;
        }

        translated.push({
          ...baseRule,
          abortIncompleteMultipartUpload: {
            daysAfterInitiation: rule.condition.age,
          },
        });
      }
    }
  }

  return translated;
}

function awsLifecycleRulesRequireVersioningCapability(
  lifecycleRules: AwsLifecycleRule[],
): boolean {
  return lifecycleRules.some(
    (rule) => rule.noncurrentVersionExpiration !== undefined,
  );
}

component.implement("aws", {
  stateSchema: z.object({
    config: z.object({
      versioning: z.boolean().default(false),
      lifecycleRules: z.array(LifecycleRuleSchema).default([]),
      corsRules: z.array(CorsRuleSchema).default([]),
      uniformBucketLevelAccess: UniformBucketLevelAccess.default(true).optional(),
      publicAccessPrevention: PublicAccessPrevention.default("inherited").optional(),
      encryptionKeyName: z.string().optional(),
      labels: z.record(z.string(), z.string()).default({}),
      forceDestroy: z.boolean().default(false),
    }).optional(),
    allocations: z.record(z.string(), z.object({
      bucketName: z.string(),
      region: z.string(),
      arn: z.string(),
      publicUrl: z.string(),
    })).default({}),
  }),
  initialState: { allocations: {} },

  pulumi: async ({ inputs, state }) => {
    // No AWS resources are created at instance scope. The config snapshot is
    // required because allocateWithPulumiCtx receives deploymentConfig but not
    // component inputs in the current SDK.
    (state as any).config = {
      versioning: inputs.versioning,
      lifecycleRules: inputs.lifecycleRules,
      corsRules: inputs.corsRules,
      uniformBucketLevelAccess: inputs.uniformBucketLevelAccess,
      publicAccessPrevention: inputs.publicAccessPrevention,
      encryptionKeyName: inputs.encryptionKeyName,
      labels: inputs.labels,
      forceDestroy: inputs.forceDestroy,
    };

    return {} as any;
  },

  allocateWithPulumiCtx: async ({
    name,
    deploymentConfig,
    state,
    $,
    aws: provider,
  }) => {
    const config = (state as any).config as
      | {
          versioning: boolean;
          lifecycleRules: BucketLifecycleRule[];
          corsRules: Array<z.infer<typeof CorsRuleSchema>>;
          uniformBucketLevelAccess?: boolean;
          publicAccessPrevention?: "inherited" | "enforced";
          encryptionKeyName?: string;
          labels: Record<string, string>;
          forceDestroy: boolean;
        }
      | undefined;

    if (!config) {
      throw new Error(
        "bucket(aws): config snapshot missing from state; pulumi() must run before allocateWithPulumiCtx",
      );
    }

    const configuredBucketName = deploymentConfig?.name as string | undefined;
    const bucketName =
      configuredBucketName && configuredBucketName.length > 0
        ? configuredBucketName
        : $`s3-${name}`;
    const publicAccess = deploymentConfig?.publicAccess === true;

    const awsOpts: pulumi.CustomResourceOptions = provider
      ? { provider }
      : {};

    const bucket = new aws.s3.Bucket(
      $`s3-${name}`,
      {
        bucket: bucketName,
        forceDestroy: config.forceDestroy,
        tags: config.labels,
      },
      awsOpts,
    );

    const ownershipControls = new aws.s3.BucketOwnershipControls(
      $`s3-ownership-${name}`,
      {
        bucket: bucket.bucket,
        rule: {
          objectOwnership: AWS_S3_OBJECT_OWNERSHIP,
        },
      },
      { ...awsOpts, dependsOn: [bucket] },
    );

    const publicAccessBlock = new aws.s3.BucketPublicAccessBlock(
      $`s3-pab-${name}`,
      {
        bucket: bucket.bucket,
        blockPublicAcls: true,
        ignorePublicAcls: true,
        blockPublicPolicy: !publicAccess,
        restrictPublicBuckets: !publicAccess,
      },
      { ...awsOpts, dependsOn: [bucket] },
    );

    new aws.s3.BucketServerSideEncryptionConfiguration(
      $`s3-sse-${name}`,
      {
        bucket: bucket.bucket,
        rules: [
          {
            applyServerSideEncryptionByDefault: config.encryptionKeyName
              ? {
                  sseAlgorithm: AWS_S3_KMS_SSE_ALGORITHM,
                  kmsMasterKeyId: config.encryptionKeyName,
                }
              : {
                  sseAlgorithm: AWS_S3_DEFAULT_SSE_ALGORITHM,
                },
          },
        ],
      },
      { ...awsOpts, dependsOn: [bucket] },
    );

    let bucketVersioning: aws.s3.BucketVersioning | undefined;
    if (config.versioning) {
      bucketVersioning = new aws.s3.BucketVersioning(
        $`s3-versioning-${name}`,
        {
          bucket: bucket.bucket,
          versioningConfiguration: {
            status: AWS_S3_VERSIONING_STATUS_ENABLED,
          },
        },
        { ...awsOpts, dependsOn: [bucket] },
      );
    }

    if (config.corsRules.length > 0) {
      new aws.s3.BucketCorsConfiguration(
        $`s3-cors-${name}`,
        {
          bucket: bucket.bucket,
          corsRules: config.corsRules.map((rule, index) => ({
            id: `cors-${index}`,
            allowedOrigins: rule.origins,
            allowedMethods: rule.methods,
            exposeHeaders: rule.responseHeaders,
            maxAgeSeconds: rule.maxAgeSeconds,
          })),
        },
        { ...awsOpts, dependsOn: [bucket] },
      );
    }

    const lifecycleRules = translateAwsLifecycleRules(
      config.lifecycleRules,
      config.versioning,
    );
    if (lifecycleRules.length > 0) {
      const lifecycleDependsOn: pulumi.Resource[] = [bucket];
      if (awsLifecycleRulesRequireVersioningCapability(
        lifecycleRules,
      )) {
        if (!bucketVersioning) {
          throw new Error(AWS_S3_LIFECYCLE_VERSIONING_DEPENDENCY_MISSING_ERROR);
        }
        lifecycleDependsOn.push(bucketVersioning);
      }

      new aws.s3.BucketLifecycleConfiguration(
        $`s3-lifecycle-${name}`,
        {
          bucket: bucket.bucket,
          rules: lifecycleRules,
        },
        { ...awsOpts, dependsOn: lifecycleDependsOn },
      );
    }

    let publicUrl: pulumi.Output<string> = pulumi.output(AWS_S3_EMPTY_PUBLIC_URL);
    if (publicAccess) {
      new aws.s3.BucketPolicy(
        $`s3-policy-${name}`,
        {
          bucket: bucket.bucket,
          policy: bucket.arn.apply((arn) => JSON.stringify({
            Version: AWS_POLICY_VERSION,
            Statement: [
              {
                Sid: "PublicReadGetObject",
                Effect: "Allow",
                Principal: AWS_S3_PUBLIC_PRINCIPAL,
                Action: AWS_S3_PUBLIC_READ_ACTION,
                Resource: `${arn}/*`,
              },
            ],
          })),
        },
        {
          ...awsOpts,
          dependsOn: [bucket, ownershipControls, publicAccessBlock],
        },
      );
      publicUrl = pulumi.interpolate`https://${bucket.bucketRegionalDomainName}`;
    }

    if (!(state as any).allocations) {
      (state as any).allocations = {};
    }
    (state as any).allocations[name] = {
      bucketName,
      region: bucket.bucketRegion,
      arn: bucket.arn,
      publicUrl,
    };
  },

  connect: (({ state, selfComponentName }: any) => [
    connectionHandler({
      interface: S3BucketCI,
      handler: async (_ctx: any) => {
        const allocations = (state.allocations ?? {}) as Record<string, any>;
        const a = allocations[selfComponentName];
        if (!a) {
          throw new Error(
            `bucket(aws): no allocation found for '${selfComponentName}' — was it allocated via allocateWithPulumiCtx?`,
          );
        }
        return {
          uri: pulumi.interpolate`s3://${a.bucketName}`,
          metadata: {
            bucketName: a.bucketName,
            region: a.region,
            arn: a.arn,
            publicUrl: pulumi.output(a.publicUrl).apply((v) => v || undefined),
            accessKeyId: undefined,
            secretAccessKey: undefined,
          },
        };
      },
    }),
  ]),
});

export default component;
