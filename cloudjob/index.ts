import { z } from "zod";

import {
  CloudProvider,
  InfraComponent,
  connectionHandler,
  DeploymentArtifactType,
} from "@sdlcworks/components";

import * as gcp from "@pulumi/gcp";
import * as pulumi from "@pulumi/pulumi";

import { ServiceAccountCI, CloudRunJobHTTPCI } from "../_internal/interfaces";

import {
  mintGcpAccessToken,
  waitForCloudRunOperation,
} from "../_internal/gcp-helpers";

// ---- Zod Enums for Config Options ----

const VpcEgressType = z.enum(["ALL_TRAFFIC", "PRIVATE_RANGES_ONLY"]);

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

// ---- Component Definition ----

const component = new InfraComponent({
  metadata: {
    stateful: false,
    proxiable: false,
  },
  connectionTypes: {
    trigger: {
      description: "allows execution of the Cloud Run Job",
      interface: CloudRunJobHTTPCI,
    },
  } as const,
  connectionInterfaces: [ServiceAccountCI, CloudRunJobHTTPCI],
  acceptedArtifactTypes: [DeploymentArtifactType.oci_spec_image],
  configSchema: z.object({
    // Core
    region: z.string().default("us-central1"),

    // Job Execution Configuration
    taskCount: z.number().min(1).default(1),
    parallelism: z.number().min(1).optional(),
    maxRetries: z.number().min(0).default(3),
    taskTimeout: z.string().default("600s"),

    // VPC Configuration (optional)
    vpcAccess: VpcAccessSchema.optional(),

    // Container Configuration
    environmentVariables: z.array(EnvVarSchema).default([]),
    secretEnvironmentVariables: z.array(SecretEnvVarSchema).default([]),

    // Resource Configuration
    resources: ResourceLimitsSchema.default({
      cpu: "1000m",
      memory: "512Mi",
    }),
  }),
  appComponentTypes: {
    "default": z.object({}),
  },
  outputSchema: z.object({
    id: z.string(),
    name: z.string(),
    location: z.string(),
    executeCommand: z.string(),
  }),
});

// ---- GCloud Provider Implementation ----

component.implement(CloudProvider.gcloud, {
  stateSchema: z.object({
    jobName: z.string(),
    location: z.string(),
    project: z.string(),
    // HTTP trigger SA credentials
    httpTriggerSaEmail: z.string(),
    httpTriggerSaKeyJson: z.string(),
    // Per-app-component allocations
    allocations: z.record(z.string(), z.object({
      jobName: z.string(),
      location: z.string(),
      project: z.string(),
      httpTriggerSaEmail: z.string(),
      httpTriggerSaKeyJson: z.string(),
    })).default({}),
  }),
  initialState: { allocations: {} },

  pulumi: async ({ $, inputs, state, buildArtifacts, getCredentials, gcp: gcpProvider }) => {
    const {
      region,
      taskCount,
      parallelism,
      maxRetries,
      taskTimeout,
      vpcAccess,
      environmentVariables,
      secretEnvironmentVariables,
      resources,
    } = inputs;

    const gcpOpts: pulumi.CustomResourceOptions = gcpProvider
      ? { provider: gcpProvider }
      : {};

    // Get container image from buildArtifacts (first component being deployed)
    const componentEntries = Object.entries(buildArtifacts);
    const containerImage =
      componentEntries.length > 0
        ? componentEntries[0][1].artifact.uri
        : "us-docker.pkg.dev/cloudrun/container/hello";

    // Generate job name
    const jobName = $`job`;

    // Create service account
    const serviceAccount = new gcp.serviceaccount.Account($`service-account`, {
      accountId: $`sa`,
      displayName: "Service account for Cloud Run job",
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

    const job = new gcp.cloudrunv2.Job(jobName, {
      name: jobName,
      location: region,
      template: {
        taskCount: taskCount,
        parallelism: parallelism || Math.min(taskCount, 100),
        template: {
          maxRetries: maxRetries,
          timeout: taskTimeout,
          serviceAccount: serviceAccount.email,
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
              },
              envs: envVars.length > 0 ? envVars : undefined,
            },
          ],
        },
      },
      description: "Cloud Run Job managed by sdlc.works",
    }, gcpOpts);

    // Get GCP project from credentials
    const project = (getCredentials() as Record<string, string>).GCP_PROJECT_ID;

    // Create dedicated service account for HTTP triggering
    const httpTriggerSa = new gcp.serviceaccount.Account($`http-trigger-sa`, {
      accountId: $`http-sa`,
      displayName: "Service account for HTTP triggering of Cloud Run job",
    }, gcpOpts);

    // Grant the HTTP trigger SA permission to invoke the job
    new gcp.cloudrunv2.JobIamMember($`http-trigger-iam`, {
      location: region,
      name: job.name,
      role: "roles/run.invoker",
      member: pulumi.interpolate`serviceAccount:${httpTriggerSa.email}`,
    }, gcpOpts);

    // Grant the HTTP trigger SA permission to run with overrides (env vars, args)
    new gcp.cloudrunv2.JobIamMember($`http-trigger-iam-developer`, {
      location: region,
      name: job.name,
      role: "roles/run.developer",
      member: pulumi.interpolate`serviceAccount:${httpTriggerSa.email}`,
    }, gcpOpts);

    // Create a key for the HTTP trigger SA
    const httpTriggerSaKey = new gcp.serviceaccount.Key($`http-trigger-sa-key`, {
      serviceAccountId: httpTriggerSa.name,
    }, gcpOpts);

    // Store Pulumi Output references in state for connection handlers
    // These carry dependency information, so resources that use them will automatically depend on the job
    state.jobName = job.name;       // Output<string> - implicit dependency
    state.location = job.location;  // Output<string> - implicit dependency
    state.project = project;
    state.httpTriggerSaEmail = httpTriggerSa.email;
    state.httpTriggerSaKeyJson = httpTriggerSaKey.privateKey;

    return {
      id: job.id,
      name: job.name,
      location: job.location,
      executeCommand: pulumi.interpolate`gcloud run jobs execute ${job.name} --region=${region}`,
    };
  },

  allocateWithPulumiCtx: async ({ name, state }: any) => {
    if (!state.allocations) state.allocations = {};
    state.allocations[name] = {
      jobName: state.jobName,
      location: state.location,
      project: state.project,
      httpTriggerSaEmail: state.httpTriggerSaEmail,
      httpTriggerSaKeyJson: state.httpTriggerSaKeyJson,
    };
  },

  connect: ({ state, selfComponentName }: any) => [
    connectionHandler({
      interface: CloudRunJobHTTPCI,
      handler: async (_ctx: any) => {
        const apiUrl = pulumi.interpolate`https://run.googleapis.com/v2/projects/${state.project}/locations/${state.location}/jobs/${state.jobName}:run`;

        return {
          uri: apiUrl,
          metadata: {
            method: "POST" as const,
            jobName: state.jobName,
            location: state.location,
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
      interface: ServiceAccountCI,
      handler: async (_ctx: any) => {
        // Per-consumer IAM binding cannot be auto-created in v2 (the
        // consumer's identity is no longer plumbed through ctx.connectionData
        // — that channel was removed). Consumers must use an SA with
        // appropriate project-level Cloud Run job invoker access.
        return {
          uri: pulumi.interpolate`cloudjob://${state.location}/${state.jobName}`,
          metadata: {
            role: "roles/run.invoker",
            email: undefined,
          },
        };
      },
    }),
  ],

  upsertArtifacts: async ({ buildArtifacts, state, getCredentials, envStore }) => {
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
        "cloudjob(gcloud): GCP_PROJECT_ID and GCP_SERVICE_ACCOUNT_KEY must be present in cloud_credentials.gcloud",
      );
    }

    const accessToken = await mintGcpAccessToken(saKey);

    // Cloud Run Jobs v2 API
    const jobName = state.jobName;
    const location = state.location;
    const jobUrl = `https://run.googleapis.com/v2/projects/${projectId}/locations/${location}/jobs/${jobName}`;

    // GET the current job configuration
    const getResponse = await fetch(jobUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!getResponse.ok) {
      const errorText = await getResponse.text();
      throw new Error(
        `cloudjob(gcloud): failed to get job '${jobName}' (${getResponse.status}): ${errorText}`,
      );
    }

    const jobConfig = (await getResponse.json()) as any;

    // Update the container image in the template
    // Cloud Run Jobs have double-nested template: template.template.containers[]
    if (!jobConfig.template?.template?.containers?.[0]) {
      throw new Error(
        `cloudjob(gcloud): job '${jobName}' has unexpected structure: missing template.template.containers[0]`,
      );
    }

    const containerImage = componentEntries[0][1].artifact.uri;
    jobConfig.template.template.containers[0].image = containerImage;

    // Merge environment variables from envStore
    const envVarsFromStore: Record<string, string> = {};
    for (const componentEnv of Object.values(envStore)) {
      for (const [key, value] of Object.entries(componentEnv)) {
        envVarsFromStore[key] = value;
      }
    }

    if (Object.keys(envVarsFromStore).length > 0) {
      const existingEnvs: Array<{ name: string; value?: string; valueSource?: any }> =
        jobConfig.template.template.containers[0].env || [];

      for (const [name, value] of Object.entries(envVarsFromStore)) {
        const existing = existingEnvs.find((e: any) => e.name === name);
        if (existing) {
          existing.value = value;
          delete existing.valueSource;
        } else {
          existingEnvs.push({ name, value });
        }
      }

      jobConfig.template.template.containers[0].env = existingEnvs;
      console.error(
        `  Set ${Object.keys(envVarsFromStore).length} environment variable(s)`,
      );
    }

    console.error(
      `Deploying ${containerImage} → cloudjob/${jobName} in ${location}`,
    );

    // PATCH the job with the updated image and env vars
    const patchResponse = await fetch(jobUrl, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(jobConfig),
    });

    if (!patchResponse.ok) {
      const errorText = await patchResponse.text();
      throw new Error(
        `cloudjob(gcloud): failed to update job '${jobName}' (${patchResponse.status}): ${errorText}`,
      );
    }

    // PATCH returns a Long-Running Operation — poll until completion
    const operation = (await patchResponse.json()) as { name?: string; done?: boolean };
    if (operation.name && !operation.done) {
      console.error(
        `  Waiting for job template to be updated (operation: ${operation.name})...`,
      );
      await waitForCloudRunOperation(operation.name, accessToken);
    }

    console.error(`Successfully deployed ${containerImage} to ${jobName}`);
  },
});

export default component;
