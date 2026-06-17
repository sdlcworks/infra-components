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
    // HTTP trigger SA credentials
    httpTriggerSaEmail: z.string(),
    httpTriggerSaKeyJson: z.string(),
  }),
  initialState: {},

  pulumi: async ({
    $,
    inputs,
    state,
    buildArtifacts,
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

    // Get GCP project from credentials
    const project = getCredentials().project;

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

  connect: (({ state, gcp: gcpProvider }: any) => {
    const gcpOpts: pulumi.CustomResourceOptions = gcpProvider
      ? { provider: gcpProvider }
      : {};

    return [
      connectionHandler({
        interface: InternalServiceCI,
        handler: async ({ $, connectionData }: any) => {
          // Grant the connecting service's service account permission to invoke this service
          if (connectionData.serviceAccountEmail) {
            new gcp.cloudrunv2.ServiceIamMember(
              $`iam-invoker`,
              {
                location: state.region,
                name: state.serviceName,
                role: "roles/run.invoker",
                member: pulumi.interpolate`serviceAccount:${connectionData.serviceAccountEmail}`,
              },
              gcpOpts,
            );
          }

          return {
            uri: state.serviceUri,
            metadata: {
              serviceName: state.serviceName,
              port: connectionData.port,
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
    ];
  }),
});

// ---- Cloudflare Provider Implementation ----

component.implement(CloudProvider.cloudflare, {
  stateSchema: z.object({
    scriptName: z.string(),
    accountId: z.string(),
    workerUri: z.string(),
  }),
  initialState: {},

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

  connect: (({ state }: any) => [
    connectionHandler({
      interface: ServiceBindingCI,
      handler: async (_ctx: any) => {
        // When another worker connects to this one via service binding,
        // the orchestrator will configure the binding on the connecting worker
        // We return the TARGET worker's script name (this component's state)
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
        // Cloudflare Workers are public by default, no auth needed
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
