import { z } from "zod";

import {
  CloudProvider,
  InfraComponent,
  connectionHandler,
} from "@sdlcworks/components";

import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";

import { S3BucketCI } from "../_internal/interfaces";

const S3_OBJECT_OWNERSHIP = "BucketOwnerEnforced";
const S3_SSE_AES256 = "AES256";
const S3_SSE_KMS = "aws:kms";
const S3_VERSIONING_ENABLED = "Enabled";
const S3_VERSIONING_SUSPENDED = "Suspended";
const S3_LIFECYCLE_ENABLED = "Enabled";
const S3_ABORT_MULTIPART_DAYS = 7;
const S3_EMPTY_PUBLIC_URL = "";

const HttpMethod = z.enum(["GET", "PUT", "HEAD", "POST", "DELETE"]);

const LifecycleRuleSchema = z.object({
  id: z.string().optional(),
  prefix: z.string().default("").optional(),
  enabled: z.boolean().default(true).optional(),
  expirationDays: z.number().int().positive().optional(),
  noncurrentVersionExpirationDays: z.number().int().positive().optional(),
});

const CorsRuleSchema = z.object({
  allowedOrigins: z.array(z.string()).min(1),
  allowedMethods: z.array(HttpMethod).min(1),
  allowedHeaders: z.array(z.string()).optional(),
  exposeHeaders: z.array(z.string()).optional(),
  maxAgeSeconds: z.number().int().nonnegative().optional(),
});

const ConfigSchema = z.object({
  versioning: z.boolean(),
  forceDestroy: z.boolean().default(false),
  kmsKeyArn: z.string().optional(),
  lifecycleRules: z.array(LifecycleRuleSchema).default([]),
  corsRules: z.array(CorsRuleSchema).default([]),
  labels: z.record(z.string(), z.string()).default({}),
});

type Config = z.infer<typeof ConfigSchema>;
type LifecycleRule = z.infer<typeof LifecycleRuleSchema>;

function lifecycleStatus(enabled: boolean | undefined): string {
  return enabled === false ? "Disabled" : S3_LIFECYCLE_ENABLED;
}

function configuredLifecycleRules(
  lifecycleRules: LifecycleRule[],
): aws.types.input.s3.BucketLifecycleConfigurationRule[] {
  return lifecycleRules.map((rule, index) => ({
    id: rule.id ?? `rule-${index}`,
    status: lifecycleStatus(rule.enabled),
    filter: {
      prefix: rule.prefix ?? "",
    },
    expiration: rule.expirationDays
      ? {
          days: rule.expirationDays,
        }
      : undefined,
    noncurrentVersionExpiration: rule.noncurrentVersionExpirationDays
      ? {
          noncurrentDays: rule.noncurrentVersionExpirationDays,
        }
      : undefined,
  }));
}

const component = new InfraComponent({
  metadata: {
    stateful: true,
    proxiable: false,
  },
  connectionTypes: {
    s3: {
      description: "provides non-public S3 bucket coordinates",
      interface: S3BucketCI,
    },
  } as const,
  connectionInterfaces: [S3BucketCI],
  configSchema: ConfigSchema,
  appComponentTypes: {},
  outputSchema: z.object({
    bucketName: z.string(),
    arn: z.string(),
    regionalDomainName: z.string(),
    region: z.string(),
  }),
});

component.implement(CloudProvider.aws, {
  stateSchema: z.object({
    bucketName: z.string(),
    arn: z.string(),
    region: z.string(),
    regionalDomainName: z.string(),
  }),
  initialState: {
    bucketName: "",
    arn: "",
    region: "",
    regionalDomainName: "",
  },

  pulumi: async ({ $, inputs, state, aws: provider }) => {
    const {
      versioning,
      forceDestroy,
      kmsKeyArn,
      lifecycleRules,
      corsRules,
      labels,
    } = inputs as Config;

    const awsOpts: pulumi.CustomResourceOptions = { provider };

    const bucket = new aws.s3.Bucket(
      $`s3`,
      {
        forceDestroy,
        tags: labels,
      },
      awsOpts,
    );

    new aws.s3.BucketOwnershipControls(
      $`s3-ownership`,
      {
        bucket: bucket.bucket,
        rule: {
          objectOwnership: S3_OBJECT_OWNERSHIP,
        },
      },
      { ...awsOpts, dependsOn: [bucket] },
    );

    new aws.s3.BucketPublicAccessBlock(
      $`s3-public-access`,
      {
        bucket: bucket.bucket,
        blockPublicAcls: true,
        blockPublicPolicy: true,
        ignorePublicAcls: true,
        restrictPublicBuckets: true,
      },
      { ...awsOpts, dependsOn: [bucket] },
    );

    new aws.s3.BucketServerSideEncryptionConfiguration(
      $`s3-encryption`,
      {
        bucket: bucket.bucket,
        rules: [
          {
            applyServerSideEncryptionByDefault: kmsKeyArn
              ? {
                  sseAlgorithm: S3_SSE_KMS,
                  kmsMasterKeyId: kmsKeyArn,
                }
              : {
                  sseAlgorithm: S3_SSE_AES256,
                },
            bucketKeyEnabled: kmsKeyArn ? true : undefined,
          },
        ],
      },
      { ...awsOpts, dependsOn: [bucket] },
    );

    new aws.s3.BucketVersioning(
      $`s3-versioning`,
      {
        bucket: bucket.bucket,
        versioningConfiguration: {
          status: versioning ? S3_VERSIONING_ENABLED : S3_VERSIONING_SUSPENDED,
        },
      },
      { ...awsOpts, dependsOn: [bucket] },
    );

    const lifecycleConfigurationRules = [
      {
        id: "abort-incomplete-multipart-upload",
        status: S3_LIFECYCLE_ENABLED,
        filter: {
          prefix: "",
        },
        abortIncompleteMultipartUpload: {
          daysAfterInitiation: S3_ABORT_MULTIPART_DAYS,
        },
      },
      ...configuredLifecycleRules(lifecycleRules),
    ];

    new aws.s3.BucketLifecycleConfiguration(
      $`s3-lifecycle`,
      {
        bucket: bucket.bucket,
        rules: lifecycleConfigurationRules,
      },
      { ...awsOpts, dependsOn: [bucket] },
    );

    if (corsRules.length > 0) {
      new aws.s3.BucketCorsConfiguration(
        $`s3-cors`,
        {
          bucket: bucket.bucket,
          corsRules: corsRules.map((rule, index) => ({
            id: `cors-${index}`,
            allowedOrigins: rule.allowedOrigins,
            allowedMethods: rule.allowedMethods,
            allowedHeaders: rule.allowedHeaders,
            exposeHeaders: rule.exposeHeaders,
            maxAgeSeconds: rule.maxAgeSeconds,
          })),
        },
        { ...awsOpts, dependsOn: [bucket] },
      );
    }

    state.bucketName = bucket.bucket;
    state.arn = bucket.arn;
    state.region = bucket.bucketRegion;
    state.regionalDomainName = bucket.bucketRegionalDomainName;

    return {
      bucketName: bucket.bucket,
      arn: bucket.arn,
      regionalDomainName: bucket.bucketRegionalDomainName,
      region: bucket.bucketRegion,
    };
  },

  connect: ({ state }) => [
    connectionHandler({
      interface: S3BucketCI,
      handler: async () => ({
        uri: pulumi.interpolate`s3://${state.bucketName}`,
        metadata: {
          bucketName: state.bucketName,
          region: state.region,
          arn: state.arn,
          publicUrl: S3_EMPTY_PUBLIC_URL,
          accessKeyId: undefined,
          secretAccessKey: undefined,
        },
      }),
    }),
  ],
});

export default component;
