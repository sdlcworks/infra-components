import { z } from "zod";
import { createHash } from "crypto";

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

component.implement(CloudProvider.gcloud, {
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

component.implement(CloudProvider.cloudflare, {
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

export default component;
