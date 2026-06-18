import { z } from "zod";
import { createHash } from "crypto";
import { readFileSync } from "fs";

import {
  CloudProvider,
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
} from "../_internal/interfaces";

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
  acceptedArtifactTypes: [DeploymentArtifactType.oci_spec_image],
  connectionTypes: {
    internal: {
      description: "allows internal VPC communication to this service",
      interface: InternalServiceCI,
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

component.implement(CloudProvider.gcloud, {
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

  // No-op: all Cloud Run resources are created per-app-component via
  // allocateWithPulumiCtx below. A singleton service is unnecessary when
  // every app component gets its own dedicated service.
  pulumi: async () => {
    return {};
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

component.implement(CloudProvider.cloudflare, {
  stateSchema: z.object({
    scriptName: z.string(),
    accountId: z.string(),
    workerUri: z.string(),
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
    cloudflare: cfProvider,
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
    } = inputs;

    // Default opts for all Cloudflare resources — uses the explicit provider
    const cfOpts: pulumi.CustomResourceOptions = cfProvider
      ? { provider: cfProvider }
      : {};

    if (!accountId) {
      throw new Error("accountId is required for Cloudflare provider");
    }

    // Generate script name
    const scriptName = $`worker`;
    state.scriptName = scriptName;
    state.accountId = accountId;

    // Get script content from buildArtifacts (file type, pre-downloaded to local path by Go CLI)
    const componentEntries = Object.entries(buildArtifacts);
    let scriptFile: string | undefined;
    let scriptFileSha256: string | undefined;
    let scriptContent: string | undefined;
    let isPlaceholderScript = false;

    // TODO: will declare artifact types later
    if (componentEntries.length > 0) {
      const artifact = componentEntries[0][1].artifact;

      if (artifact.type === "file") {
        scriptFile = artifact.uri;
        // Compute SHA-256 of the script file (required by Cloudflare provider when using contentFile)
        const fileBuffer = readFileSync(scriptFile);
        scriptFileSha256 = createHash("sha256").update(fileBuffer).digest("hex");
      }
      // Ignore artifacts of other types (e.g., oci_spec_image) — treat as no artifact passed
    }

    // If no build artifact provided, use placeholder script
    if (!scriptFile) {
      scriptContent = DEFAULT_WORKER_SCRIPT;
      isPlaceholderScript = true;

      console.warn(
        `No build artifact found for Cloudflare Worker '${scriptName}'. Using placeholder script.`
      );
    }

    // Build all bindings
    const bindings: cloudflare.types.input.WorkersScriptBinding[] = [
      // Plain text environment variables
      ...environmentVariables.map((env) => ({
        name: env.name,
        text: env.value,
        type: "plain_text" as const,
      })),
      // R2 bucket bindings
      ...(cfBindings?.r2 || []).map((binding) => ({
        name: binding.name,
        bucketName: binding.bucketName,
        type: "r2_bucket" as const,
      })),
      // Worker service bindings
      ...(cfBindings?.services || []).map((binding) => ({
        name: binding.name,
        service: binding.service,
        environment: binding.environment,
        type: "service" as const,
      })),
      // KV namespace bindings
      ...(cfBindings?.kv || []).map((binding) => ({
        name: binding.name,
        namespaceId: binding.namespaceId,
        type: "kv_namespace" as const,
      })),
      // D1 database bindings
      ...(cfBindings?.d1 || []).map((binding) => ({
        name: binding.name,
        databaseId: binding.databaseId,
        type: "d1" as const,
      })),
      // Queue bindings
      ...(cfBindings?.queues || []).map((binding) => ({
        name: binding.name,
        queueName: binding.queueName,
        type: "queue" as const,
      })),
    ];

    // Create Workers Script
    const worker = new cloudflare.WorkersScript($`script`, {
      accountId: accountId,
      scriptName: scriptName,
      ...(scriptFile ? { contentFile: scriptFile, contentSha256: scriptFileSha256 } : { content: scriptContent }),
      mainModule: "index.js",
      compatibilityDate: compatibilityDate || "2024-01-01",
      compatibilityFlags: compatibilityFlags || ["nodejs_compat"],
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
        }, cfOpts);

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
        }, cfOpts);

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
  ]),

  upsertArtifacts: async ({ buildArtifacts, state, getCredentials }) => {
    const { readFileSync } = await import("fs");

    const componentEntries = Object.entries(buildArtifacts);
    if (componentEntries.length === 0) {
      console.error("No artifacts to deploy");
      return;
    }

    // The artifact URI is a local file path (pre-downloaded by Go CLI from S3)
    const localFilePath = componentEntries[0][1].artifact.uri;
    console.error(
      `Deploying artifact: ${localFilePath} to worker: ${state.scriptName}`
    );

    // Read the bundled JS content from the local file
    const scriptContent = readFileSync(localFilePath, "utf-8");

    const credentials = getCredentials();
    const apiToken = credentials.CLOUDFLARE_API_TOKEN;
    const { accountId, scriptName } = state;

    // Upload the script to Cloudflare Workers via the API (out-of-state update).
    // This keeps bundled JS code out of Pulumi state.
    // Uses multipart form upload: metadata part + ES module script part.
    const metadata = JSON.stringify({
      main_module: "index.js",
    });

    const formData = new FormData();
    formData.append(
      "metadata",
      new Blob([metadata], { type: "application/json" })
    );
    formData.append(
      "index.js",
      new Blob([scriptContent], { type: "application/javascript+module" }),
      "index.js"
    );

    const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${scriptName}`;
    const response = await fetch(url, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${apiToken}`,
      },
      body: formData,
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `Cloudflare Workers API error (${response.status}): ${body}`
      );
    }

    console.error(`Successfully deployed worker script: ${scriptName}`);
  },
});

export default component;
