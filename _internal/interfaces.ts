import { z } from "zod";
import { defineConnectionInterface } from "@sdlcworks/components";

// Connection interfaces (CIs).
//
// v2 shape: input schema is always empty (`z.object({})`). The runtime
// `declareConnectionInterfaces` channel that used to carry consumer-side data
// to the producer's connect handler was removed in v2. All useful data now
// flows the OTHER direction — producer → consumer — via the result schema,
// which is what the producer's connect handler returns as `metadata`.
//
// Consumers reference these fields from their TSC env block, e.g.:
//   "$[[backend.connection.storage-bucket.metadata.bucketName]]"

// ---- Postgres ----

export const PostgresCI = defineConnectionInterface(
  "postgres",
  z.object({}),
  z.object({
    uri: z.string(),
  }),
);

// ---- Service Account ----

/**
 * Service-account identity exposed by an infra component (e.g., a bucket
 * exposing the service-account it has authorized).
 *
 * Result fields are optional because some providers (e.g., Cloudflare R2)
 * don't have a service-account model — handlers return what they have.
 */
export const ServiceAccountCI = defineConnectionInterface(
  "service-account",
  z.object({}),
  z.object({
    email: z.string().optional(),
    role: z.string().optional(),
  }),
);

// ---- Internal Service ----

/**
 * VPC-internal service-to-service URI for an HTTP service.
 * Used when a consumer talks to a producer over the internal network.
 */
export const InternalServiceCI = defineConnectionInterface(
  "internal-service",
  z.object({}),
  z.object({
    uri: z.string(),
    serviceName: z.string().optional(),
    port: z.number().optional(),
    serviceAccountEmail: z.string().optional(),
  }),
);

// ---- Backend Service (Load Balancer) ----

/**
 * Backend that an HTTP load-balancer can route to via a Serverless NEG.
 * Producers expose their backend-service identity for the LB to bind.
 */
export const BackendServiceCI = defineConnectionInterface(
  "backend-service",
  z.object({}),
  z.object({
    backendServiceId: z.string(),
    negId: z.string(),
    region: z.string(),
  }),
);

// ---- Service Binding (Cloudflare Workers) ----

/**
 * Cloudflare service-to-service binding. Consumer Worker references the
 * target Worker's script name to set up a service binding.
 */
export const ServiceBindingCI = defineConnectionInterface(
  "service-binding",
  z.object({}),
  z.object({
    scriptName: z.string(),
    environment: z.string().optional(),
  }),
);

// ---- R2 Bucket ----

/**
 * Cloudflare R2 bucket access. Producer mints an account-scoped R2 token in
 * its instance-level pulumi() and emits S3-compatible credentials here so
 * consumers can read/write the bucket directly.
 */
export const R2BucketCI = defineConnectionInterface(
  "r2-bucket",
  z.object({}),
  z.object({
    bucketName: z.string(),
    accountId: z.string(),
    accessKeyId: z.string().optional(),
    secretAccessKey: z.string().optional(),
    publicUrl: z.string().optional(),
  }),
);

// ---- HTTP Public (generic) ----

/**
 * Public HTTP endpoint without provider-specific auth. Used by URL registers
 * and Cloudflare Workers that expose simple public HTTP.
 */
export const HTTPPublicCI = defineConnectionInterface(
  "http-public",
  z.object({}),
  z.object({
    method: z.enum(["GET", "POST", "PUT", "DELETE"]).optional(),
  }),
);

// ---- D1 Database (Cloudflare) ----

/**
 * Cloudflare D1 database access. Used by the cloudflare-d1 infra component
 * to expose database identity for worker bindings.
 */
export const D1DatabaseCI = defineConnectionInterface(
  "d1-database",
  z.object({}),
  z.object({
    databaseId: z.string(),
    databaseName: z.string().optional(),
  }),
);

// ---- Cloud Run Job (HTTP-triggerable) ----

/**
 * GCP Cloud Run Job triggerable over HTTPS. Producer creates a per-job
 * service-account key during allocation and returns the trigger URL plus
 * the credentials needed for the consumer to invoke the job.
 */
export const CloudRunJobHTTPCI = defineConnectionInterface(
  "cloud-run-job-http",
  z.object({}),
  z.object({
    method: z.literal("POST"),
    jobName: z.string(),
    location: z.string(),
    project: z.string(),
    auth: z.object({
      type: z.literal("service_account_key"),
      serviceAccountEmail: z.string(),
      serviceAccountKeyJson: z.string(),
    }),
  }),
);

// ---- Cloud Run Service (HTTP) ----

/**
 * GCP Cloud Run Service accessible via authenticated HTTPS. Producer
 * creates a per-service service-account key during allocation and returns
 * the service URL plus the credentials needed for the consumer to invoke it.
 */
export const CloudRunServiceHTTPCI = defineConnectionInterface(
  "cloud-run-service-http",
  z.object({}),
  z.object({
    method: z.enum(["GET", "POST", "PUT", "DELETE"]),
    serviceName: z.string(),
    location: z.string(),
    project: z.string(),
    auth: z.object({
      type: z.literal("service_account_key"),
      serviceAccountEmail: z.string(),
      serviceAccountKeyJson: z.string(),
    }),
  }),
);

// ---- Public (multi-protocol) ----

/**
 * Richer public connection interface used by components that expose
 * hosted app components publicly across protocols (http/tcp) and to carry
 * postgres connection metadata. Used by k3s + serverless-fn (Cloud Run).
 */
export const PublicCI = defineConnectionInterface(
  "public",
  z.object({}),
  z.object({
    appComponentType: z.string(),
    host: z.string(),
    port: z.number().optional(),
    // tcp-service
    mode: z.enum(["plain", "tls", "mtls"]).optional(),
    // http-service
    protocol: z.enum(["http", "https"]).optional(),
    serviceName: z.string().optional(),
    region: z.string().optional(),
    auth: z.object({
      headers: z.record(z.string(), z.string()),
    }).optional(),
    // postgres
    dbName: z.string().optional(),
    dbUser: z.string().optional(),
    dbPassword: z.string().optional(),
  })
);

// ---- k3s Internal ----

/**
 * In-cluster HTTP communication between app components hosted on the same
 * k3s infra. The producer's connect handler resolves the k8s Service
 * ClusterDNS URI from its allocations.
 */
export const K3sInternalCI = defineConnectionInterface(
  "k3s-internal",
  z.object({}),
  z.object({
    appComponentType: z.string(),
    host: z.string(),
    port: z.number().optional(),
    // tcp-service
    mode: z.enum(["plain", "tls", "mtls"]).optional(),
    // http-service
    protocol: z.enum(["http", "https"]).optional(),
    auth: z.object({
      headers: z.record(z.string(), z.string()),
    }).optional(),
    // postgres
    dbName: z.string().optional(),
    dbUser: z.string().optional(),
    dbPassword: z.string().optional(),
  })
);
