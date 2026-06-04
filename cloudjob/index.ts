import { z } from "zod";

import {
  CloudProvider,
  InfraComponent,
  connectionHandler,
} from "@sdlcworks/components";

import * as gcp from "@pulumi/gcp";
import * as pulumi from "@pulumi/pulumi";

import { ServiceAccountCI, CloudRunJobHTTPCI } from "../_internal/interfaces";

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
      interface: ServiceAccountCI,
    },
  } as const,
  connectionInterfaces: [CloudRunJobHTTPCI],
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
  appComponentTypes: {},
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
  }),
  initialState: {},

  pulumi: async ({ $, inputs, state, buildArtifacts, getCredentials }) => {
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
    });

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
    });

    // Get GCP project from credentials
    const project = getCredentials().project;

    // Create dedicated service account for HTTP triggering
    const httpTriggerSa = new gcp.serviceaccount.Account($`http-trigger-sa`, {
      accountId: $`http-sa`,
      displayName: "Service account for HTTP triggering of Cloud Run job",
    });

    // Grant the HTTP trigger SA permission to invoke the job
    new gcp.cloudrunv2.JobIamMember($`http-trigger-iam`, {
      location: region,
      name: job.name,
      role: "roles/run.invoker",
      member: pulumi.interpolate`serviceAccount:${httpTriggerSa.email}`,
    });

    // Create a key for the HTTP trigger SA
    const httpTriggerSaKey = new gcp.serviceaccount.Key($`http-trigger-sa-key`, {
      serviceAccountId: httpTriggerSa.name,
    });

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

  connect: [
    connectionHandler({
      interface: ServiceAccountCI,
      handler: async (ctx) => {
        new gcp.cloudrunv2.JobIamMember(`iam-${ctx.connectionType}`, {
          location: ctx.state.location,
          name: ctx.state.jobName,
          role: "roles/run.invoker",
          member: pulumi.interpolate`serviceAccount:${ctx.connectionData.email}`,
        });

        return {
          uri: pulumi.interpolate`cloudjob://${ctx.state.location}/${ctx.state.jobName}`,
          metadata: {
            role: "roles/run.invoker",
          },
        };
      },
    }),
    connectionHandler({
      interface: CloudRunJobHTTPCI,
      handler: async (ctx) => {
        // Full Cloud Run Jobs API endpoint
        // POST https://run.googleapis.com/v2/projects/{PROJECT}/locations/{LOCATION}/jobs/{JOB}:run
        const apiUrl = pulumi.interpolate`https://run.googleapis.com/v2/projects/${ctx.state.project}/locations/${ctx.state.location}/jobs/${ctx.state.jobName}:run`;

        return {
          uri: apiUrl,
          metadata: {
            method: "POST" as const,
            jobName: ctx.state.jobName,
            location: ctx.state.location,
            project: ctx.state.project,
            auth: {
              type: "service_account_key" as const,
              serviceAccountEmail: ctx.state.httpTriggerSaEmail,
              serviceAccountKeyJson: ctx.state.httpTriggerSaKeyJson,
            },
          },
        };
      },
    }),
  ],
});

export default component;
