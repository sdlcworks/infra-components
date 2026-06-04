import { z } from "zod";

import {
  CloudProvider,
  InfraComponent,
  connectionHandler,
} from "@sdlcworks/components";

import * as gcp from "@pulumi/gcp";
import * as cloudflare from "@pulumi/cloudflare";
import * as pulumi from "@pulumi/pulumi";

import { ServiceAccountCI, R2BucketCI } from "../_internal/interfaces";

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
  connectionInterfaces: [R2BucketCI],
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
  appComponentTypes: {},
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

component.implement(CloudProvider.gcloud, {
  stateSchema: z.object({
    bucketName: z.string(),
  }),
  initialState: {},

  pulumi: async ({ $, inputs, state }) => {
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
    });

    return {
      id: bucket.id,
      name: bucket.name,
      selfLink: bucket.selfLink,
      url: bucket.url,
      location: bucket.location,
      storageClass: bucket.storageClass,
    };
  },

  connect: [
    connectionHandler({
      interface: ServiceAccountCI,
      handler: async (ctx) => {
        const role =
          ctx.connectionType === "read"
            ? "roles/storage.objectViewer"
            : "roles/storage.objectAdmin";

        new gcp.storage.BucketIAMMember(`iam-${ctx.connectionType}`, {
          bucket: ctx.state.bucketName,
          role: role,
          member: pulumi.interpolate`serviceAccount:${ctx.connectionData.email}`,
        });

        return {
          uri: pulumi.interpolate`gs://${ctx.state.bucketName}`,
          metadata: { role },
        };
      },
    }),
  ],
});

// ---- Cloudflare Provider Implementation ----

component.implement(CloudProvider.cloudflare, {
  stateSchema: z.object({
    bucketName: z.string(),
    accountId: z.string(),
  }),
  initialState: {},

  pulumi: async ({ $, inputs, state }) => {
    const {
      accountId,
      jurisdiction,
      r2Location,
      r2StorageClass,
      lifecycleRules,
      corsRules,
      forceDestroy,
    } = inputs;

    if (!accountId) {
      throw new Error("accountId is required for Cloudflare provider");
    }

    // Generate bucket name and store in state
    const bucketName = $`bucket`;
    state.bucketName = bucketName;
    state.accountId = accountId;

    // Create R2 Bucket
    const bucket = new cloudflare.R2Bucket(bucketName, {
      accountId: accountId,
      name: bucketName,
      location: r2Location || "enam",
      storageClass: r2StorageClass || "Standard",
      jurisdiction: jurisdiction || "default",
    });

    // Create R2 Bucket Lifecycle if rules provided
    if (lifecycleRules.length > 0) {
      const r2LifecycleRules = lifecycleRules.map((rule) => {
        // Map GCS lifecycle actions to R2
        let action: string;
        if (rule.action.type === "Delete") {
          action = "Expire";
        } else if (rule.action.type === "SetStorageClass") {
          action = "Transition";
        } else if (rule.action.type === "AbortIncompleteMultipartUpload") {
          action = "AbortIncompleteMultipartUpload";
        } else {
          throw new Error(`Unsupported lifecycle action for R2: ${rule.action.type}`);
        }

        return {
          action: action,
          enabled: true,
          filter: {
            prefix: rule.condition.matchesPrefix?.[0],
          },
          expiration: rule.condition.age
            ? {
                days: rule.condition.age,
              }
            : undefined,
          transition:
            action === "Transition"
              ? {
                  days: rule.condition.age || 30,
                  storageClass: "InfrequentAccess",
                }
              : undefined,
          abortIncompleteMultipartUpload:
            action === "AbortIncompleteMultipartUpload"
              ? {
                  daysAfterInitiation: rule.condition.age || 7,
                }
              : undefined,
        };
      });

      new cloudflare.R2BucketLifecycle(`${bucketName}-lifecycle`, {
        accountId: accountId,
        bucket: bucketName,
        rules: r2LifecycleRules,
      });
    }

    // Create R2 Bucket CORS if rules provided
    if (corsRules.length > 0) {
      const r2CorsRules = corsRules.map((rule) => ({
        allowedOrigins: rule.origins,
        allowedMethods: rule.methods,
        allowedHeaders: rule.responseHeaders || [],
        maxAgeSeconds: rule.maxAgeSeconds || 3600,
      }));

      new cloudflare.R2BucketCors(`${bucketName}-cors`, {
        accountId: accountId,
        bucket: bucketName,
        corsRules: r2CorsRules,
      });
    }

    return {
      id: bucket.id,
      name: bucket.name,
      url: pulumi.interpolate`https://${accountId}.r2.cloudflarestorage.com/${bucketName}`,
      location: bucket.location,
      storageClass: bucket.storageClass || "Standard",
    };
  },

  connect: [
    connectionHandler({
      interface: R2BucketCI,
      handler: async (ctx) => {
        // Workers connect to R2 via bindings configured on the Worker side
        // Return bucket info that can be referenced in cfBindings config
        // e.g., cfBindings.r2[0].bucketName = "${outputs.storage-bucket.name}"
        return {
          uri: pulumi.interpolate`r2://${ctx.state.bucketName}`,
          metadata: {
            bucketName: ctx.state.bucketName,
          },
        };
      },
    }),
  ],
});

export default component;
