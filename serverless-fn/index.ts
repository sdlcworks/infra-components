import { z } from "zod";
import { createHash } from "crypto";
import { readFileSync, readdirSync, statSync, mkdtempSync, existsSync } from "fs";
import { execFileSync } from "child_process";
import { join, relative, extname } from "path";
import { tmpdir } from "os";
import { fileURLToPath } from "url";

import {
  InfraComponent,
  connectionHandler,
  DeploymentArtifactType,
} from "@sdlcworks/components";

import * as gcp from "@pulumi/gcp";
import * as cloudflare from "@pulumi/cloudflare";
import * as pulumi from "@pulumi/pulumi";

import {
  ServiceAccountCI,
  InternalServiceCI,
  BackendServiceCI,
  ServiceBindingCI,
  CloudRunServiceHTTPCI,
  CloudRunJobHTTPCI,
  HTTPPublicCI,
  R2BucketCI,
  PublicCI,
  PostgresCI,
} from "../_internal/interfaces";

import { cloudflareProviderFromCredentials } from "../_internal/cloudflare-provider";
import {
  mintGcpAccessToken,
  waitForCloudRunOperation,
} from "../_internal/gcp-helpers";

// ---- Default Placeholder Worker Script ----

const DEFAULT_WORKER_SCRIPT = `export default {
  async fetch(request, env, ctx) {
    return new Response('Hello from Cloudflare Worker!\\n\\nThis is a placeholder script deployed without a build artifact.\\n\\nTo deploy your own code, provide a bundled JavaScript file as a build artifact.', {
      status: 200,
      headers: {
        'content-type': 'text/plain; charset=utf-8',
      },
    });
  },
};`;

function artifactFilePath(uri: string): string {
  return uri.startsWith("file://") ? fileURLToPath(uri) : uri;
}

// ---- Workers upload (script, static-site, worker-assets) ----

const CLOUDFLARE_API_BASE = "https://api.cloudflare.com/client/v4";
const ASSETS_BINDING_NAME = "ASSETS";
const WORKER_MAIN_MODULE = "index.js";
const WORKER_ASSETS_WORKER_DIR = "worker";
const WORKER_ASSETS_ASSETS_DIR = "assets";
const WORKER_ASSETS_COMPATIBILITY_FLOOR = "2024-09-23";
const NODEJS_COMPAT_FLAG = "nodejs_compat";
const DEFAULT_COMPATIBILITY_DATE = "2024-01-01";
const DEFAULT_HTML_HANDLING = "auto-trailing-slash";
const STATIC_SITE_NOT_FOUND_HANDLING = "404-page";
const WORKER_ASSETS_NOT_FOUND_HANDLING = "none";
const ESM_MODULE_CONTENT_TYPE = "application/javascript+module";
const SECRET_TEXT_BINDING = "secret_text";

const ASSET_MODES = ["script", "static-site", "worker-assets"] as const;
type AssetMode = (typeof ASSET_MODES)[number];

const WORKER_MODULE_CONTENT_TYPES: Record<string, string> = {
  js: ESM_MODULE_CONTENT_TYPE,
  mjs: ESM_MODULE_CONTENT_TYPE,
  cjs: "application/javascript",
  wasm: "application/wasm",
  map: "application/source-map",
  txt: "text/plain",
  html: "text/plain",
  sql: "text/plain",
};

const STATIC_SITE_WORKER_SCRIPT = `export default {
  async fetch(request, env) {
    return env.ASSETS.fetch(request);
  },
};`;

const ASSET_MIME_TYPES: Record<string, string> = {
  html: "text/html",
  css: "text/css",
  js: "text/javascript",
  mjs: "text/javascript",
  json: "application/json",
  xml: "application/xml",
  txt: "text/plain",
  md: "text/markdown",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  ico: "image/x-icon",
  mp4: "video/mp4",
  webm: "video/webm",
  mp3: "audio/mpeg",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  pdf: "application/pdf",
  wasm: "application/wasm",
  map: "application/json",
};

function assetMime(filePath: string): string {
  const ext = extname(filePath).slice(1).toLowerCase();
  return ASSET_MIME_TYPES[ext] ?? "application/octet-stream";
}

function walkFiles(root: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root)) {
    const full = join(root, entry);
    if (statSync(full).isDirectory()) out.push(...walkFiles(full));
    else out.push(full);
  }
  return out;
}

// Manifest hash per the documented direct-upload contract:
// sha256 over base64(content) + extension (no leading dot), first 32 hex chars.
function assetManifestHash(content: Buffer, filePath: string): string {
  const ext = extname(filePath).slice(1);
  return createHash("sha256")
    .update(content.toString("base64") + ext)
    .digest("hex")
    .slice(0, 32);
}

interface ScriptSettings {
  compatibility_date: string;
  compatibility_flags: string[];
  bindings: Record<string, unknown>[];
  assets?: { html_handling?: string; not_found_handling?: string };
  secret_refs?: { name: string; secret_name: string }[];
}

interface WorkerModule {
  name: string;
  content: Buffer | string;
  contentType: string;
}

interface DeployArgs {
  accountId: string;
  scriptName: string;
  apiToken: string;
  artifactPath: string;
  settings: ScriptSettings;
  bindings: Record<string, unknown>[];
}

function workerModuleContentType(filePath: string): string {
  const ext = extname(filePath).slice(1).toLowerCase();
  return WORKER_MODULE_CONTENT_TYPES[ext] ?? "application/octet-stream";
}

function requireSecretValue(
  credentials: Record<string, unknown>,
  name: string,
  secretName: string,
): string {
  const value = credentials[secretName];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(
      `serverless-fn(cloudflare): secret '${name}' names credential key '${secretName}', which the bound credential does not carry`,
    );
  }
  return value;
}

function deployBindings(
  settings: ScriptSettings,
  credentials: Record<string, unknown>,
): Record<string, unknown>[] {
  return [
    ...settings.bindings,
    ...(settings.secret_refs ?? []).map((ref) => ({
      type: SECRET_TEXT_BINDING,
      name: ref.name,
      text: requireSecretValue(credentials, ref.name, ref.secret_name),
    })),
  ];
}

function extractArtifact(artifactPath: string, prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  execFileSync("tar", ["-xzf", artifactPath, "-C", dir]);
  return dir;
}

function assetsMetadata(
  settings: ScriptSettings,
  jwt: string,
  notFoundDefault: string,
): { jwt: string; config: { html_handling: string; not_found_handling: string } } {
  return {
    jwt,
    config: {
      html_handling: settings.assets?.html_handling ?? DEFAULT_HTML_HANDLING,
      not_found_handling: settings.assets?.not_found_handling ?? notFoundDefault,
    },
  };
}

async function uploadAssetManifest(
  accountId: string,
  scriptName: string,
  apiToken: string,
  distDir: string,
): Promise<string> {
  const files = walkFiles(distDir);
  const byHash = new Map<string, { path: string; content: Buffer }>();
  const manifest: Record<string, { hash: string; size: number }> = {};

  for (const file of files) {
    const content = readFileSync(file);
    const hash = assetManifestHash(content, file);
    const key = "/" + relative(distDir, file).split("\\").join("/");
    manifest[key] = { hash, size: content.length };
    byHash.set(hash, { path: file, content });
  }

  console.error(
    `static-assets: ${files.length} files in manifest for worker '${scriptName}'`,
  );

  const sessionResponse = await fetch(
    `${CLOUDFLARE_API_BASE}/accounts/${accountId}/workers/scripts/${scriptName}/assets-upload-session`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ manifest }),
    },
  );
  if (!sessionResponse.ok) {
    throw new Error(
      `assets-upload-session failed (${sessionResponse.status}): ${await sessionResponse.text()}`,
    );
  }
  const session = (await sessionResponse.json()) as {
    result: { jwt: string; buckets?: string[][] };
  };

  let completionJwt = session.result.jwt;
  const buckets = session.result.buckets ?? [];

  for (const bucket of buckets) {
    const form = new FormData();
    for (const hash of bucket) {
      const entry = byHash.get(hash);
      if (!entry) throw new Error(`asset bucket names unknown hash ${hash}`);
      form.append(
        hash,
        new Blob([entry.content.toString("base64")], {
          type: assetMime(entry.path),
        }),
        hash,
      );
    }
    const uploadResponse = await fetch(
      `${CLOUDFLARE_API_BASE}/accounts/${accountId}/workers/assets/upload?base64=true`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${session.result.jwt}` },
        body: form,
      },
    );
    if (!uploadResponse.ok) {
      throw new Error(
        `asset upload failed (${uploadResponse.status}): ${await uploadResponse.text()}`,
      );
    }
    const uploadResult = (await uploadResponse.json()) as {
      result?: { jwt?: string };
    };
    if (uploadResult.result?.jwt) completionJwt = uploadResult.result.jwt;
  }

  return completionJwt;
}

async function putWorkerScript(
  accountId: string,
  scriptName: string,
  apiToken: string,
  metadata: Record<string, unknown>,
  modules: WorkerModule[],
): Promise<void> {
  const form = new FormData();
  form.append(
    "metadata",
    new Blob([JSON.stringify(metadata)], { type: "application/json" }),
  );
  for (const module of modules) {
    form.append(
      module.name,
      new Blob([module.content], { type: module.contentType }),
      module.name,
    );
  }
  const response = await fetch(
    `${CLOUDFLARE_API_BASE}/accounts/${accountId}/workers/scripts/${scriptName}`,
    {
      method: "PUT",
      headers: { Authorization: `Bearer ${apiToken}` },
      body: form,
    },
  );
  if (!response.ok) {
    throw new Error(
      `serverless-fn(cloudflare): worker script upload failed (${response.status}): ${await response.text()}`,
    );
  }
}

function baseMetadata(settings: ScriptSettings): Record<string, unknown> {
  return {
    main_module: WORKER_MAIN_MODULE,
    compatibility_date: settings.compatibility_date,
    compatibility_flags: settings.compatibility_flags,
  };
}

async function deployScript(args: DeployArgs): Promise<void> {
  await putWorkerScript(
    args.accountId,
    args.scriptName,
    args.apiToken,
    { ...baseMetadata(args.settings), bindings: args.bindings },
    [
      {
        name: WORKER_MAIN_MODULE,
        content: readFileSync(args.artifactPath, "utf-8"),
        contentType: ESM_MODULE_CONTENT_TYPE,
      },
    ],
  );
}

async function deployStaticSite(args: DeployArgs): Promise<void> {
  const distDir = extractArtifact(args.artifactPath, "sdlc-static-site-");
  const jwt = await uploadAssetManifest(
    args.accountId,
    args.scriptName,
    args.apiToken,
    distDir,
  );
  await putWorkerScript(
    args.accountId,
    args.scriptName,
    args.apiToken,
    {
      ...baseMetadata(args.settings),
      bindings: [...args.bindings, { type: "assets", name: ASSETS_BINDING_NAME }],
      assets: assetsMetadata(args.settings, jwt, STATIC_SITE_NOT_FOUND_HANDLING),
    },
    [
      {
        name: WORKER_MAIN_MODULE,
        content: STATIC_SITE_WORKER_SCRIPT,
        contentType: ESM_MODULE_CONTENT_TYPE,
      },
    ],
  );
}

async function deployWorkerWithAssets(args: DeployArgs): Promise<void> {
  const root = extractArtifact(args.artifactPath, "sdlc-worker-assets-");
  const workerDir = join(root, WORKER_ASSETS_WORKER_DIR);
  const assetsDir = join(root, WORKER_ASSETS_ASSETS_DIR);
  if (!existsSync(join(workerDir, WORKER_MAIN_MODULE))) {
    throw new Error(
      `serverless-fn(cloudflare): worker-assets artifact carries no ${WORKER_ASSETS_WORKER_DIR}/${WORKER_MAIN_MODULE} entry module`,
    );
  }
  if (!existsSync(assetsDir) || !statSync(assetsDir).isDirectory()) {
    throw new Error(
      `serverless-fn(cloudflare): worker-assets artifact carries no ${WORKER_ASSETS_ASSETS_DIR}/ directory`,
    );
  }
  const modules: WorkerModule[] = walkFiles(workerDir).map((file) => ({
    name: relative(workerDir, file).split("\\").join("/"),
    content: readFileSync(file),
    contentType: workerModuleContentType(file),
  }));
  const jwt = await uploadAssetManifest(
    args.accountId,
    args.scriptName,
    args.apiToken,
    assetsDir,
  );
  await putWorkerScript(
    args.accountId,
    args.scriptName,
    args.apiToken,
    {
      ...baseMetadata(args.settings),
      bindings: [...args.bindings, { type: "assets", name: ASSETS_BINDING_NAME }],
      assets: assetsMetadata(args.settings, jwt, WORKER_ASSETS_NOT_FOUND_HANDLING),
    },
    modules,
  );
  console.error(
    `worker-assets: worker '${args.scriptName}' deployed with ${modules.length} modules`,
  );
}

// ---- Zod Enums for Config Options ----

const IngressType = z.enum([
  "INGRESS_TRAFFIC_ALL",
  "INGRESS_TRAFFIC_INTERNAL_ONLY",
  "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER",
]);

const VpcEgressType = z.enum(["ALL_TRAFFIC", "PRIVATE_RANGES_ONLY"]);

const ExecutionEnvironment = z.enum([
  "EXECUTION_ENVIRONMENT_GEN1",
  "EXECUTION_ENVIRONMENT_GEN2",
]);

// ---- Reusable Schema Definitions ----

const EnvVarSchema = z.object({
  name: z.string(),
  value: z.string(),
});

const SecretEnvVarSchema = z.object({
  name: z.string(),
  secretName: z.string(),
  version: z.string().default("latest"),
});

const ResourceLimitsSchema = z.object({
  cpu: z.string().default("1000m"),
  memory: z.string().default("512Mi"),
});

const VpcAccessSchema = z.object({
  subnetId: z.string(),
  egress: VpcEgressType.default("PRIVATE_RANGES_ONLY"),
});

const LoadBalancerIntegrationSchema = z.object({
  enabled: z.boolean().default(false),
});

// ---- Cloudflare-specific Schema Definitions ----

const CloudflareRoutingSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("route"),
    zoneId: z.string(),
    pattern: z.string(),
  }),
  z.object({
    type: z.literal("customDomain"),
    zoneId: z.string(),
    hostname: z.string(),
  }),
  z.object({
    type: z.literal("subdomain"),
    enabled: z.boolean().default(true),
    previewsEnabled: z.boolean().default(false),
  }),
]);

// ---- Cloudflare Binding Schema Definitions ----

const R2BindingSchema = z.object({
  name: z.string().describe("Binding name accessible in Worker code"),
  bucketName: z
    .string()
    .describe("R2 bucket name (use ${outputs.bucket.name})"),
});

const WorkerServiceBindingSchema = z.object({
  name: z.string().describe("Binding name accessible in Worker code"),
  service: z.string().describe("Worker script name to bind to"),
  environment: z.string().optional().describe("Optional environment name"),
});

const KVBindingSchema = z.object({
  name: z.string().describe("Binding name accessible in Worker code"),
  namespaceId: z.string().describe("KV namespace ID"),
});

const D1BindingSchema = z.object({
  name: z.string().describe("Binding name accessible in Worker code"),
  databaseId: z.string().describe("D1 database ID"),
});

const QueueBindingSchema = z.object({
  name: z.string().describe("Binding name accessible in Worker code"),
  queueName: z.string().describe("Queue name"),
});

const CloudflareBindingsSchema = z.object({
  r2: z.array(R2BindingSchema).default([]).describe("R2 bucket bindings"),
  services: z
    .array(WorkerServiceBindingSchema)
    .default([])
    .describe("Worker service bindings"),
  kv: z.array(KVBindingSchema).default([]).describe("KV namespace bindings"),
  d1: z.array(D1BindingSchema).default([]).describe("D1 database bindings"),
  queues: z.array(QueueBindingSchema).default([]).describe("Queue bindings"),
});

const CloudflareObservabilitySchema = z.object({
  enabled: z.boolean().default(false),
  headSamplingRate: z.number().min(0).max(1).default(1),
  logs: z
    .object({
      enabled: z.boolean().default(false),
      invocationLogs: z.boolean().default(false),
    })
    .optional(),
});

const CloudflarePlacementSchema = z.object({
  mode: z.enum(["smart", "off"]).default("off"),
});

const CloudflareLimitsSchema = z.object({
  cpuMs: z.number().min(5).max(30000).default(50),
});

// ---- Per-App-Component Schemas (dezite allocation model) ----

const IngressRuleSchema = z.object({
  host: z.string(),
  path: z.string().default("/"),
});

const AllocationSchema = z.object({
  serviceName: z.string(),
  region: z.string(),
  serviceUri: z.string(),
  ingressHosts: z.array(z.string()).default([]),
});

// ---- Component Definition ----

const component = new InfraComponent({
  metadata: {
    stateful: false,
    proxiable: true,
  },
  acceptedArtifactTypes: [
    DeploymentArtifactType.oci_spec_image,
    DeploymentArtifactType.file,
  ],
  connectionTypes: {
    internal: {
      description: "allows internal VPC communication to this service",
      interface: InternalServiceCI,
    },
    postgres: {
      description:
        "consumer-side: a Cloud Run service connects to a Postgres database",
      interface: PostgresCI,
    },
    "r2-bucket": {
      description:
        "consumer-side: a Cloud Run service connects to an R2 bucket",
      interface: R2BucketCI,
    },
  } as const,
  connectionInterfaces: [
    ServiceAccountCI,
    BackendServiceCI,
    CloudRunServiceHTTPCI,
    CloudRunJobHTTPCI,
    ServiceBindingCI,
    HTTPPublicCI,
    R2BucketCI,
    PublicCI,
  ],
  configSchema: z.object({
    // Core (GCloud)
    region: z.string().default("us-central1").optional(),

    // Ingress Configuration (GCloud)
    ingress: IngressType.default("INGRESS_TRAFFIC_ALL").optional(),

    // VPC Configuration (GCloud)
    vpcAccess: VpcAccessSchema.optional(),

    // Container Configuration (GCloud)
    containerPort: z.number().default(8080).optional(),
    secretEnvironmentVariables: z.array(SecretEnvVarSchema).default([]),

    // Resource Configuration (GCloud)
    resources: ResourceLimitsSchema.default({
      cpu: "1000m",
      memory: "512Mi",
    }).optional(),

    // Scaling Configuration (GCloud)
    minScale: z.number().min(0).default(0).optional(),
    maxScale: z.number().min(1).default(100).optional(),
    maxConcurrency: z.number().min(1).default(80).optional(),

    // Execution Environment (GCloud)
    executionEnvironment: ExecutionEnvironment.default(
      "EXECUTION_ENVIRONMENT_GEN2"
    ).optional(),

    // Timeouts (GCloud)
    requestTimeout: z.string().default("300s").optional(),
    startupTimeout: z.string().optional(),

    // Session Affinity (GCloud)
    sessionAffinity: z.boolean().default(false).optional(),

    // Load Balancer Integration (GCloud)
    loadBalancerIntegration: LoadBalancerIntegrationSchema.optional(),

    // Shared: Environment Variables
    environmentVariables: z.array(EnvVarSchema).default([]),

    // Cloudflare-specific fields
    accountId: z.string().optional(),
    routing: CloudflareRoutingSchema.optional(),
    compatibilityDate: z.string().default("2024-01-01").optional(),
    compatibilityFlags: z
      .array(z.string())
      .default(["nodejs_compat"])
      .optional(),
    cfLimits: CloudflareLimitsSchema.optional(),
    cfPlacement: CloudflarePlacementSchema.optional(),
    cfObservability: CloudflareObservabilitySchema.optional(),
    logpush: z.boolean().default(false).optional(),
    cfBindings: CloudflareBindingsSchema.optional().describe(
      "Cloudflare Worker bindings (R2, KV, D1, Queues, Services)"
    ),
    assetMode: z
      .enum(ASSET_MODES)
      .default("script")
      .optional()
      .describe(
        "script: deploy artifact is a bundled Worker module. static-site: deploy artifact is a tar.gz of a built static site served via Workers Static Assets. worker-assets: deploy artifact is a tar.gz with worker/ (entry worker/index.js plus modules) and assets/ (served via the ASSETS binding)"
      ),
    assetsConfig: z
      .object({
        htmlHandling: z
          .enum(["auto-trailing-slash", "force-trailing-slash", "drop-trailing-slash", "none"])
          .default("auto-trailing-slash"),
        notFoundHandling: z
          .enum(["none", "404-page", "single-page-application"])
          .default("404-page"),
      })
      .optional(),
  }),
  appComponentTypes: {
    "http-service": z.object({
      service: z.string().optional(),
      region: z.string().default("us-central1"),
      containerPort: z.number().default(8080),
      cpu: z.string().default("1"),
      memory: z.string().default("512Mi"),
      minInstances: z.number().min(0).default(0),
      maxInstances: z.number().min(1).default(100),
      concurrency: z.number().min(1).optional(),
      cpuIdle: z.boolean().default(true),
      startupCpuBoost: z.boolean().default(true),
      ingress: z.object({
        rules: z.array(IngressRuleSchema).default([]),
      }).optional(),
    }),
    "default": z.object({}),
  },
  outputSchema: z.object({
    id: z.string(),
    name: z.string(),
    uri: z.string(),
    latestReadyRevision: z.string(),
    location: z.string(),
    backendServiceId: z.string().optional(),
    negId: z.string().optional(),
  }),
});

// ---- GCloud Provider Implementation ----

component.implement("gcloud", {
  stateSchema: z.object({
    serviceName: z.string(),
    region: z.string(),
    project: z.string(),
    serviceUri: z.string(),
    serviceAccountEmail: z.string(),
    containerPort: z.number(),
    backendServiceId: z.string().optional(),
    negId: z.string().optional(),
    // HTTP trigger SA credentials
    httpTriggerSaEmail: z.string(),
    httpTriggerSaKeyJson: z.string(),
    // Per-app-component allocations
    allocations: z.record(z.string(), AllocationSchema).default({}),
  }),
  initialState: { allocations: {} },

  pulumi: async ({
    $,
    inputs,
    state,
    buildArtifacts,
    envStore,
    getCredentials,
    gcp: gcpProvider,
  }) => {
    const {
      region,
      ingress,
      vpcAccess,
      containerPort,
      environmentVariables,
      secretEnvironmentVariables,
      resources,
      minScale,
      maxScale,
      maxConcurrency,
      executionEnvironment,
      requestTimeout,
      startupTimeout,
      sessionAffinity,
      loadBalancerIntegration,
    } = inputs;

    // When app components target this infra, allocateWithPulumiCtx creates
    // per-app Cloud Run services. The singleton resources below are only
    // needed when NO app components target this infra (standalone mode).
    // Detect the per-app allocation case via buildArtifacts or envStore
    // having entries — the orchestrator populates both for every app
    // component with an active infra_target pointing here.
    const hasAppComponentTargets =
      Object.keys(buildArtifacts).length > 0 ||
      Object.keys(envStore).length > 0;

    if (hasAppComponentTargets) {
      // Per-app allocation mode: allocateWithPulumiCtx handles all Cloud Run
      // services. Skip singleton resources to avoid waste.
      const project = (getCredentials() as Record<string, string>).GCP_PROJECT_ID;
      state.region = region;
      state.project = project;
      state.containerPort = containerPort;
      return {
        id: "",
        name: "",
        uri: "",
        latestReadyRevision: "",
        location: region,
      };
    }

    // Standalone mode: no app components target this infra, create the
    // singleton Cloud Run service directly.

    // Default opts for all GCP resources — uses the explicit provider
    const gcpOpts: pulumi.CustomResourceOptions = gcpProvider
      ? { provider: gcpProvider }
      : {};

    // Get container image from buildArtifacts (first component being deployed)
    const componentEntries = Object.entries(buildArtifacts);
    const containerImage =
      componentEntries.length > 0
        ? componentEntries[0][1].artifact.uri
        : "us-docker.pkg.dev/cloudrun/container/hello";

    // Create service account
    const serviceAccount = new gcp.serviceaccount.Account($`service-account`, {
      accountId: $`sa`,
      displayName: "Service account for Cloud Run service",
    }, gcpOpts);

    // Build environment variables
    const envVars = [
      ...environmentVariables.map((env) => ({
        name: env.name,
        value: env.value,
      })),
      ...secretEnvironmentVariables.map((env) => ({
        name: env.name,
        valueSource: {
          secretKeyRef: {
            secret: env.secretName,
            version: env.version,
          },
        },
      })),
    ];

    const service = new gcp.cloudrunv2.Service($`service`, {
      location: region,
      ingress: ingress,
      template: {
        executionEnvironment: executionEnvironment,
        serviceAccount: serviceAccount.email,
        sessionAffinity: sessionAffinity,
        timeout: requestTimeout,
        maxInstanceRequestConcurrency: maxConcurrency,
        scaling: {
          minInstanceCount: minScale,
          maxInstanceCount: maxScale,
        },
        vpcAccess: vpcAccess
          ? {
              networkInterfaces: [
                {
                  subnetwork: vpcAccess.subnetId,
                },
              ],
              egress: vpcAccess.egress,
            }
          : undefined,
        containers: [
          {
            image: containerImage,
            resources: {
              limits: {
                cpu: resources.cpu,
                memory: resources.memory,
              },
              startupCpuBoost: true,
            },
            ports: [
              {
                name: "http1",
                containerPort: containerPort,
              },
            ],
            envs: envVars.length > 0 ? envVars : undefined,
            startupProbe: startupTimeout
              ? {
                  timeoutSeconds: parseInt(startupTimeout),
                  tcpSocket: {
                    port: containerPort,
                  },
                }
              : undefined,
          },
        ],
      },
    }, gcpOpts);

    // Get GCP project from credentials (v2 credential shape)
    const project = (getCredentials() as Record<string, string>).GCP_PROJECT_ID;

    // Create dedicated service account for HTTP triggering
    const httpTriggerSa = new gcp.serviceaccount.Account($`http-trigger-sa`, {
      accountId: $`http-sa`,
      displayName: "Service account for HTTP triggering of Cloud Run service",
    }, gcpOpts);

    // Grant the HTTP trigger SA permission to invoke the service
    new gcp.cloudrunv2.ServiceIamMember($`http-trigger-iam`, {
      location: region,
      name: service.name,
      role: "roles/run.invoker",
      member: pulumi.interpolate`serviceAccount:${httpTriggerSa.email}`,
    }, gcpOpts);

    // Create a key for the HTTP trigger SA
    const httpTriggerSaKey = new gcp.serviceaccount.Key($`http-trigger-sa-key`, {
      serviceAccountId: httpTriggerSa.name,
    }, gcpOpts);

    // Store state for connection handlers
    state.serviceName = service.name;
    state.region = region;
    state.project = project;
    state.serviceUri = service.uri;
    state.httpTriggerSaEmail = httpTriggerSa.email;
    state.httpTriggerSaKeyJson = httpTriggerSaKey.privateKey;

    // Track service account email + container port for connect + allocate handlers
    state.serviceAccountEmail = serviceAccount.email;
    state.containerPort = containerPort;

    // Create Backend Service resources if load balancer integration enabled
    let backendServiceId: any;
    let negId: any;

    if (loadBalancerIntegration?.enabled) {
      // Create Serverless NEG pointing to Cloud Run
      const neg = new gcp.compute.RegionNetworkEndpointGroup($`neg`, {
        region: region,
        networkEndpointType: "SERVERLESS",
        cloudRun: {
          service: service.name,
        },
      }, gcpOpts);

      // Create Backend Service for external load balancer
      const backendService = new gcp.compute.BackendService(
        $`backend-service`,
        {
          protocol: "HTTP",
          loadBalancingScheme: "EXTERNAL_MANAGED",
          backends: [
            {
              group: neg.selfLink,
              balancingMode: "UTILIZATION",
              capacityScaler: 1.0,
            },
          ],
        },
        gcpOpts,
      );

      backendServiceId = backendService.selfLink;
      negId = neg.selfLink;

      state.backendServiceId = backendService.selfLink;
      state.negId = neg.selfLink;

      // Allow unauthenticated access through the load balancer
      // The INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER setting ensures only LB traffic reaches the service
      new gcp.cloudrunv2.ServiceIamMember($`lb-invoker`, {
        location: region,
        name: service.name,
        role: "roles/run.invoker",
        member: "allUsers",
      }, gcpOpts);
    }

    return {
      id: service.id,
      name: service.name,
      uri: service.uri,
      latestReadyRevision: service.latestReadyRevision,
      location: service.location,
      backendServiceId: backendServiceId,
      negId: negId,
    };
  },

  allocateWithPulumiCtx: async ({
    name,
    deploymentConfig,
    state,
    $,
    buildArtifact,
    envStore,
    gcp: gcpProvider,
  }) => {
    const region: string = deploymentConfig.region ?? "us-central1";
    const containerPort: number = deploymentConfig.containerPort ?? 8080;
    const cpu: string = deploymentConfig.cpu ?? "1";
    const memory: string = deploymentConfig.memory ?? "512Mi";
    const minInstances: number = deploymentConfig.minInstances ?? 0;
    const maxInstances: number = deploymentConfig.maxInstances ?? 100;
    const concurrency: number | undefined = deploymentConfig.concurrency;
    const cpuIdle: boolean = deploymentConfig.cpuIdle ?? true;
    const startupCpuBoost: boolean = deploymentConfig.startupCpuBoost ?? true;
    const ingress = deploymentConfig.ingress as
      | { rules?: Array<{ host: string; path: string }> }
      | undefined;

    const gcpOpts: pulumi.CustomResourceOptions = gcpProvider
      ? { provider: gcpProvider }
      : {};

    if (
      buildArtifact &&
      buildArtifact.artifact.type !== DeploymentArtifactType.oci_spec_image
    ) {
      throw new Error(
        `serverless-fn(gcloud): expects an OCI image artifact for app component "${name}", ` +
          `received "${buildArtifact.artifact.type}".`,
      );
    }

    const containerImage =
      buildArtifact?.artifact?.uri ??
      "us-docker.pkg.dev/cloudrun/container/hello";

    // Resolved env vars for THIS app component, supplied by the orchestrator
    // from the TSC's components.<name>.env after $[[...]] interpolation.
    const envForComponent = (envStore?.[name] ?? {}) as Record<string, string>;
    const envEntries = Object.entries(envForComponent).map(([k, v]) => ({
      name: k,
      value: v,
    }));

    // Cloud Run v2 rejects cpu < 1 with always-allocated CPU.
    const cpuFractional = parseFloat(cpu) < 1;
    const effectiveCpuIdle = cpuFractional || cpuIdle;
    const effectiveStartupCpuBoost = cpuFractional ? false : startupCpuBoost;

    const service = new gcp.cloudrunv2.Service(
      $`service-${name}`,
      {
        location: region,
        ingress: "INGRESS_TRAFFIC_ALL",
        template: {
          maxInstanceRequestConcurrency: concurrency as any,
          scaling: {
            minInstanceCount: minInstances,
            maxInstanceCount: maxInstances,
          },
          containers: [
            {
              image: containerImage,
              resources: {
                limits: { cpu, memory },
                cpuIdle: effectiveCpuIdle,
                startupCpuBoost: effectiveStartupCpuBoost,
              },
              ports: {
                name: "http1",
                containerPort,
              } as any,
              envs: envEntries.length > 0 ? envEntries : undefined,
            },
          ],
        },
      },
      gcpOpts,
    );

    // Allow unauthenticated access (public service)
    new gcp.cloudrunv2.ServiceIamMember(
      $`public-invoker-${name}`,
      {
        location: region,
        name: service.name,
        role: "roles/run.invoker",
        member: "allUsers",
      },
      gcpOpts,
    );

    const ingressHosts = (ingress?.rules ?? []).map((r) => r.host);

    if (!(state as any).allocations) {
      (state as any).allocations = {};
    }
    (state as any).allocations[name] = {
      serviceName: service.name,
      region,
      serviceUri: service.uri,
      ingressHosts,
    };
  },

  connect: ({ state, selfComponentName }: any) => [
    connectionHandler({
      interface: InternalServiceCI,
      handler: async (_ctx: any) => {
        const allocations = (state.allocations ?? {}) as Record<string, any>;
        const a = allocations[selfComponentName];
        if (!a) {
          throw new Error(
            `serverless-fn(gcloud): no allocation found for '${selfComponentName}' — was it allocated via allocateWithPulumiCtx?`,
          );
        }
        return {
          uri: a.serviceUri,
          metadata: {
            uri: a.serviceUri,
            serviceName: a.serviceName,
          },
        };
      },
    }),
    connectionHandler({
      interface: CloudRunServiceHTTPCI,
      handler: async (_ctx: any) => {
        return {
          uri: state.serviceUri,
          metadata: {
            method: "POST" as const,
            serviceName: state.serviceName,
            location: state.region,
            project: state.project,
            auth: {
              type: "service_account_key" as const,
              serviceAccountEmail: state.httpTriggerSaEmail,
              serviceAccountKeyJson: state.httpTriggerSaKeyJson,
            },
          },
        };
      },
    }),
    connectionHandler({
      interface: PublicCI,
      handler: async (_ctx: any) => {
        const allocations = (state.allocations ?? {}) as Record<string, any>;
        const a = allocations[selfComponentName];
        if (!a) {
          throw new Error(
            `serverless-fn(gcloud): no allocation found for '${selfComponentName}' — was it allocated via allocateWithPulumiCtx?`,
          );
        }
        const host = pulumi
          .output(a.serviceUri)
          .apply((u: string) => {
            if (!u) return "";
            try {
              return new URL(u).hostname;
            } catch {
              return "";
            }
          });
        return {
          uri: a.serviceUri,
          metadata: {
            appComponentType: "http-service",
            host,
            serviceName: pulumi.output(a.serviceName),
            region: a.region,
            protocol: "https" as const,
            port: 443,
          },
        };
      },
    }),
  ],

  upsertArtifacts: async ({ buildArtifacts, state, envStore, getCredentials }) => {
    const componentEntries = Object.entries(buildArtifacts);
    if (componentEntries.length === 0) {
      console.error("No artifacts to deploy");
      return;
    }

    const creds = (getCredentials() as Record<string, string>) || {};
    const projectId = creds.GCP_PROJECT_ID;
    const saKey = creds.GCP_SERVICE_ACCOUNT_KEY;
    if (!projectId || !saKey) {
      throw new Error(
        "serverless-fn(gcloud): GCP_PROJECT_ID and GCP_SERVICE_ACCOUNT_KEY must be present in cloud_credentials.gcloud",
      );
    }

    const accessToken = await mintGcpAccessToken(saKey);

    const allocations = (state.allocations ?? {}) as Record<
      string,
      { serviceName: string; region: string }
    >;

    for (const [componentName, artifactInfo] of componentEntries) {
      const allocation = allocations[componentName];
      if (!allocation) {
        console.error(
          `Skipping ${componentName}: no allocation metadata found in state — was this component allocated via allocateWithPulumiCtx?`,
        );
        continue;
      }

      if (
        artifactInfo.artifact.type !== DeploymentArtifactType.oci_spec_image
      ) {
        throw new Error(
          `serverless-fn(gcloud): expects an OCI image artifact for app component "${componentName}", ` +
            `received "${artifactInfo.artifact.type}".`,
        );
      }

      const { serviceName, region } = allocation;
      const imageUri = artifactInfo.artifact.uri;
      const envForComponent = envStore[componentName] ?? {};
      const envEntries = Object.entries(envForComponent).map(([k, v]) => ({
        name: k,
        value: v,
      }));

      console.error(
        `Deploying ${imageUri} → serverless-fn/${serviceName} in ${region} ` +
          `(env keys: ${Object.keys(envForComponent).join(", ") || "<none>"})`,
      );

      const url =
        `https://run.googleapis.com/v2/projects/${projectId}/locations/${region}/services/${serviceName}` +
        `?updateMask=template`;
      const patchRes = await fetch(url, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          template: {
            containers: [
              {
                image: imageUri,
                env: envEntries,
              },
            ],
          },
        }),
      });

      if (!patchRes.ok) {
        throw new Error(
          `serverless-fn(gcloud): failed to patch service '${serviceName}' (${patchRes.status}): ${await patchRes.text()}`,
        );
      }

      const op = (await patchRes.json()) as { name?: string; done?: boolean };
      if (op.name && !op.done) {
        await waitForCloudRunOperation(op.name, accessToken);
      }

      console.error(`Successfully deployed ${imageUri} to ${serviceName}`);
    }
  },
});

// ---- Cloudflare Provider Implementation ----

component.implement("cloudflare", {
  stateSchema: z.object({
    scriptName: z.string(),
    accountId: z.string(),
    workerUri: z.string(),
    assetMode: z.enum(ASSET_MODES).optional(),
    scriptSettings: z
      .object({
        compatibility_date: z.string(),
        compatibility_flags: z.array(z.string()),
        bindings: z.array(z.record(z.string(), z.any())),
        assets: z
          .object({
            html_handling: z.string(),
            not_found_handling: z.string(),
          })
          .optional(),
        secret_refs: z
          .array(z.object({ name: z.string(), secret_name: z.string() }))
          .optional(),
      })
      .optional(),
    allocations: z.record(z.string(), z.object({
      scriptName: z.string(),
      accountId: z.string(),
      workerUri: z.string(),
    })).default({}),
  }),
  initialState: { allocations: {} },

  pulumi: async ({
    $,
    inputs,
    state,
    buildArtifacts,
    getCredentials,
  }) => {
    const {
      accountId,
      routing,
      environmentVariables,
      compatibilityDate,
      compatibilityFlags,
      cfLimits,
      cfPlacement,
      cfObservability,
      logpush,
      cfBindings,
      assetMode,
      assetsConfig,
      secretEnvironmentVariables,
    } = inputs;
    const mode: AssetMode = assetMode ?? "script";
    const deploysContentAtRelease = mode !== "script";
    const isWorkerAssets = mode === "worker-assets";
    const credentials = getCredentials();
    const secretRefs = (secretEnvironmentVariables ?? []).map((secret) => ({
      name: secret.name,
      secret_name: secret.secretName,
    }));
    const declaredDate = compatibilityDate || DEFAULT_COMPATIBILITY_DATE;
    const effectiveDate =
      isWorkerAssets && declaredDate < WORKER_ASSETS_COMPATIBILITY_FLOOR
        ? WORKER_ASSETS_COMPATIBILITY_FLOOR
        : declaredDate;
    const declaredFlags = compatibilityFlags || [NODEJS_COMPAT_FLAG];
    const effectiveFlags =
      isWorkerAssets && !declaredFlags.includes(NODEJS_COMPAT_FLAG)
        ? [...declaredFlags, NODEJS_COMPAT_FLAG]
        : declaredFlags;

    if (!accountId) {
      throw new Error("accountId is required for Cloudflare provider");
    }

    const cfOpts: pulumi.CustomResourceOptions = {
      provider: cloudflareProviderFromCredentials($`cf-provider`, getCredentials),
    };

    const scriptName = $`worker`;
    state.scriptName = scriptName;
    state.accountId = accountId;

    const componentEntries = Object.entries(buildArtifacts);
    let scriptFile: string | undefined;
    let scriptFileSha256: string | undefined;
    let scriptContent: string | undefined;

    if (componentEntries.length > 0 && !deploysContentAtRelease) {
      const artifact = componentEntries[0][1].artifact;

      if (artifact.type !== DeploymentArtifactType.file) {
        throw new Error(
          `serverless-fn(cloudflare): expects a file artifact (bundled Worker script), received "${artifact.type}". ` +
            `The cloudflare realization deploys a script file, not a container image.`,
        );
      }

      scriptFile = artifactFilePath(artifact.uri);
      const fileBuffer = readFileSync(scriptFile);
      scriptFileSha256 = createHash("sha256").update(fileBuffer).digest("hex");
    }

    if (!scriptFile) {
      scriptContent = DEFAULT_WORKER_SCRIPT;

      if (!deploysContentAtRelease) {
        console.warn(
          `No build artifact found for Cloudflare Worker '${scriptName}'. Using placeholder script.`
        );
      }
    }

    const bindings: cloudflare.types.input.WorkersScriptBinding[] = [
      ...environmentVariables.map((env) => ({
        name: env.name,
        text: env.value,
        type: "plain_text" as const,
      })),
      ...(cfBindings?.r2 || []).map((binding) => ({
        name: binding.name,
        bucketName: binding.bucketName,
        type: "r2_bucket" as const,
      })),
      ...(cfBindings?.services || []).map((binding) => ({
        name: binding.name,
        service: binding.service,
        environment: binding.environment,
        type: "service" as const,
      })),
      ...(cfBindings?.kv || []).map((binding) => ({
        name: binding.name,
        namespaceId: binding.namespaceId,
        type: "kv_namespace" as const,
      })),
      ...(cfBindings?.d1 || []).map((binding) => ({
        name: binding.name,
        databaseId: binding.databaseId,
        type: "d1" as const,
      })),
      ...(cfBindings?.queues || []).map((binding) => ({
        name: binding.name,
        queueName: binding.queueName,
        type: "queue" as const,
      })),
      ...secretRefs.map((ref) => ({
        name: ref.name,
        text: pulumi.secret(requireSecretValue(credentials, ref.name, ref.secret_name)),
        type: SECRET_TEXT_BINDING as "secret_text",
      })),
    ];

    state.assetMode = mode;
    state.scriptSettings = {
      compatibility_date: effectiveDate,
      compatibility_flags: effectiveFlags,
      ...(deploysContentAtRelease
        ? {
            assets: {
              html_handling: assetsConfig?.htmlHandling ?? DEFAULT_HTML_HANDLING,
              not_found_handling:
                assetsConfig?.notFoundHandling ??
                (isWorkerAssets
                  ? WORKER_ASSETS_NOT_FOUND_HANDLING
                  : STATIC_SITE_NOT_FOUND_HANDLING),
            },
          }
        : {}),
      ...(secretRefs.length > 0 ? { secret_refs: secretRefs } : {}),
      bindings: [
        ...environmentVariables.map((env) => ({
          type: "plain_text",
          name: env.name,
          text: env.value,
        })),
        ...(cfBindings?.r2 || []).map((binding) => ({
          type: "r2_bucket",
          name: binding.name,
          bucket_name: binding.bucketName,
        })),
        ...(cfBindings?.services || []).map((binding) => ({
          type: "service",
          name: binding.name,
          service: binding.service,
          ...(binding.environment ? { environment: binding.environment } : {}),
        })),
        ...(cfBindings?.kv || []).map((binding) => ({
          type: "kv_namespace",
          name: binding.name,
          namespace_id: binding.namespaceId,
        })),
        ...(cfBindings?.d1 || []).map((binding) => ({
          type: "d1",
          name: binding.name,
          id: binding.databaseId,
        })),
        ...(cfBindings?.queues || []).map((binding) => ({
          type: "queue",
          name: binding.name,
          queue_name: binding.queueName,
        })),
      ],
    };

    const worker = new cloudflare.WorkersScript($`script`, {
      accountId: accountId,
      scriptName: scriptName,
      ...(scriptFile ? { contentFile: scriptFile, contentSha256: scriptFileSha256 } : { content: scriptContent }),
      mainModule: WORKER_MAIN_MODULE,
      compatibilityDate: effectiveDate,
      compatibilityFlags: effectiveFlags,
      bindings: bindings.length > 0 ? bindings : undefined,
      limits: cfLimits
        ? {
            cpuMs: cfLimits.cpuMs,
          }
        : undefined,
      placement: cfPlacement
        ? {
            mode: cfPlacement.mode,
          }
        : undefined,
      observability: cfObservability
        ? {
            enabled: cfObservability.enabled,
            headSamplingRate: cfObservability.headSamplingRate,
            logs: cfObservability.logs
              ? {
                  enabled: cfObservability.logs.enabled,
                  invocationLogs: cfObservability.logs.invocationLogs,
                }
              : undefined,
          }
        : undefined,
      logpush: logpush || false,
    }, cfOpts);

    // Always enable workers.dev subdomain for the worker
    // This ensures the worker is accessible even without custom routing
    const workerSubdomain = new cloudflare.WorkersScriptSubdomain($`subdomain`, {
      accountId: accountId,
      scriptName: scriptName,
      enabled: true,
      previewsEnabled: routing?.type === "subdomain" ? routing.previewsEnabled : false,
    }, { dependsOn: [worker], ...cfOpts });

    // Handle routing configuration
    let workerUri: pulumi.Output<string>;

    if (routing) {
      if (routing.type === "route") {
        // Create Workers Route for zone-based routing
        new cloudflare.WorkersRoute($`route`, {
          zoneId: routing.zoneId,
          pattern: routing.pattern,
          script: scriptName,
        }, { dependsOn: [worker], ...cfOpts });

        workerUri = pulumi.interpolate`https://${routing.pattern.replace(
          "/*",
          ""
        )}`;
      } else if (routing.type === "customDomain") {
        // Create Custom Domain for the worker
        new cloudflare.WorkersCustomDomain($`domain`, {
          accountId: accountId,
          zoneId: routing.zoneId,
          hostname: routing.hostname,
          service: scriptName,
        }, { dependsOn: [worker], ...cfOpts });

        workerUri = pulumi.interpolate`https://${routing.hostname}`;
      } else {
        // Subdomain routing (workers.dev)
        // The script is automatically available at <scriptName>.<subdomain>.workers.dev
        workerUri = pulumi.interpolate`https://${scriptName}.workers.dev`;
      }
    } else {
      // Default: use workers.dev subdomain
      workerUri = pulumi.interpolate`https://${scriptName}.workers.dev`;
    }

    // Store worker URI in state
    state.workerUri = workerUri;

    return {
      id: worker.id,
      name: worker.scriptName,
      uri: workerUri,
      latestReadyRevision: worker.id,
      location: "edge",
    };
  },

  allocateWithPulumiCtx: async ({ name, state }: any) => {
    if (!state.allocations) state.allocations = {};
    state.allocations[name] = {
      scriptName: state.scriptName,
      accountId: state.accountId,
      workerUri: state.workerUri,
    };
  },

  connect: (({ state, selfComponentName }: any) => [
    connectionHandler({
      interface: ServiceBindingCI,
      handler: async (_ctx: any) => {
        return {
          uri: pulumi.interpolate`service:${state.scriptName}`,
          metadata: {
            scriptName: state.scriptName,
          },
        };
      },
    }),
    connectionHandler({
      interface: HTTPPublicCI,
      handler: async (_ctx: any) => {
        return {
          uri: state.workerUri,
          metadata: {
            method: "GET" as const,
          },
        };
      },
    }),
    connectionHandler({
      interface: PublicCI,
      handler: async (_ctx: any) => {
        const allocations = (state.allocations ?? {}) as Record<string, any>;
        const allocation = allocations[selfComponentName];
        if (!allocation) {
          throw new Error(
            `serverless-fn(cloudflare): no allocation found for '${selfComponentName}' — was it allocated via allocateWithPulumiCtx?`,
          );
        }
        // A route-pattern worker's URI hosts a wildcard (e.g. *.example.com),
        // which cannot serve as a DNS origin target; the zone apex can, and a
        // proxied record is intercepted by the worker route before the target
        // is ever contacted.
        const host = pulumi.output(allocation.workerUri).apply((uri: string) => {
          if (!uri) return "";
          try {
            const hostname = new URL(uri).hostname;
            return hostname.startsWith("*.") ? hostname.slice(2) : hostname;
          } catch {
            return "";
          }
        });
        return {
          uri: allocation.workerUri,
          metadata: {
            appComponentType: "http-service",
            host,
            protocol: "https" as const,
            port: 443,
          },
        };
      },
    }),
  ]),

  upsertArtifacts: async ({ buildArtifacts, state, getCredentials }) => {
    const componentEntries = Object.entries(buildArtifacts);
    if (componentEntries.length === 0) {
      console.error("No artifacts to deploy");
      return;
    }

    const artifact = componentEntries[0][1].artifact;
    if (artifact.type !== DeploymentArtifactType.file) {
      throw new Error(
        `serverless-fn(cloudflare): expects a file artifact (bundled Worker script), received "${artifact.type}". ` +
          `The cloudflare realization deploys a script file, not a container image.`,
      );
    }

    const localFilePath = artifactFilePath(artifact.uri);
    console.error(
      `Deploying artifact: ${localFilePath} to worker: ${state.scriptName}`
    );

    if (!state.scriptSettings) {
      throw new Error(
        `serverless-fn(cloudflare): no script settings recorded for '${state.scriptName}' — ` +
          `re-provision this branch once so the worker's compatibility flags and bindings ` +
          `are carried into deploys; uploading without them would strip the live worker's settings.`,
      );
    }

    const credentials = getCredentials();
    const settings = state.scriptSettings as ScriptSettings;
    const args: DeployArgs = {
      accountId: state.accountId as string,
      scriptName: state.scriptName as string,
      apiToken: credentials.CLOUDFLARE_API_TOKEN as string,
      artifactPath: localFilePath,
      settings,
      bindings: deployBindings(settings, credentials),
    };
    const mode: AssetMode =
      (state.assetMode as AssetMode | undefined) ??
      (settings.assets ? "static-site" : "script");

    if (mode === "worker-assets") await deployWorkerWithAssets(args);
    else if (mode === "static-site") await deployStaticSite(args);
    else await deployScript(args);

    console.error(`Successfully deployed worker script: ${args.scriptName} (${mode})`);
  },
});

export default component;
