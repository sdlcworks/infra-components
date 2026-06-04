import { z } from "zod";
import { defineConnectionInterface } from "@sdlcworks/components";

// ---- Connection Interfaces ----

/**
 * ServiceAccount connection interface
 * Allows components to reference and use GCP service accounts
 * 
 * Result metadata includes the IAM role that was granted
 */
export const ServiceAccountCI = defineConnectionInterface(
  "service-account",
  z.object({
    email: z.string(),
  }),
  z.object({
    role: z.string(),
  })
);

/**
 * Internal Service connection interface
 * Enables direct VPC-to-VPC service communication between components
 * 
 * Result metadata includes service name and port
 */
export const InternalServiceCI = defineConnectionInterface(
  "internal-service",
  z.object({
    internalUri: z.string(),
    serviceName: z.string(),
    port: z.number(),
    serviceAccountEmail: z.string().optional(),
  }),
  z.object({
    serviceName: z.string(),
    port: z.number(),
  })
);

/**
 * Backend Service connection interface
 * Used when a component needs to be exposed through a load balancer
 * 
 * No result metadata - just the URI is sufficient
 */
export const BackendServiceCI = defineConnectionInterface(
  "backend-service",
  z.object({
    backendServiceId: z.string(),
    negId: z.string(),
    region: z.string(),
  })
);

/**
 * Service Binding connection interface
 * Enables Cloudflare Workers to call other Workers via service bindings
 * 
 * Result metadata includes the target script name
 */
export const ServiceBindingCI = defineConnectionInterface(
  "service-binding",
  z.object({
    scriptName: z.string(),
    environment: z.string().optional(),
  }),
  z.object({
    scriptName: z.string(),
  })
);

/**
 * R2 Bucket connection interface
 * Enables Cloudflare Workers to bind to R2 buckets
 * 
 * Result metadata includes the bucket name
 */
export const R2BucketCI = defineConnectionInterface(
  "r2-bucket",
  z.object({
    bucketName: z.string().optional(),
    accountId: z.string(),
  }),
  z.object({
    bucketName: z.string(),
  })
);

/**
 * D1 Database connection interface
 * Enables Cloudflare Workers to bind to D1 databases
 *
 * Result metadata includes the database ID for binding configuration
 */
export const D1DatabaseCI = defineConnectionInterface(
  "d1-database",
  z.object({
    databaseId: z.string(),
    databaseName: z.string(),
  }),
  z.object({
    databaseId: z.string(),
  })
);

/**
 * HTTP Public connection interface (Generic)
 * For components that expose simple public HTTP endpoints without special auth.
 * 
 * Used by: Cloudflare Workers (public by default)
 * 
 * Result metadata includes the HTTP method to use
 */
export const HTTPPublicCI = defineConnectionInterface(
  "http-public",
  z.object({}),
  z.object({
    method: z.enum(["GET", "POST", "PUT", "DELETE"]),
  })
);

/**
 * Cloud Run Job HTTP connection interface
 * For GCP Cloud Run Jobs accessible via public HTTPS API.
 * 
 * Creates a dedicated service account + key for HTTP triggering.
 * URI is the full Cloud Run Jobs API endpoint.
 * 
 * Result metadata includes job details and authentication credentials
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
  })
);

/**
 * Cloud Run Service HTTP connection interface
 * For GCP Cloud Run Services accessible via public HTTPS.
 * 
 * Creates a dedicated service account + key for authenticated HTTP access.
 * URI is the service's public URL.
 * 
 * Result metadata includes service details and authentication credentials
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
  })
);

/**
 * Public HTTP Connection Interface
 * For components that expose simple public HTTP endpoints.
 * Used by k3s and other infra components for external access.
 *
 * Result metadata includes the protocol to use when connecting.
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
    auth: z.object({
      headers: z.record(z.string(), z.string()),
    }).optional(),
    // postgres
    dbName: z.string().optional(),
    dbUser: z.string().optional(),
    dbPassword: z.string().optional(),
  })
);

/**
 * k3s Internal Connection Interface
 * Enables in-cluster communication between app components hosted on the same k3s infra.
 * The connect handler resolves the k8s Service ClusterDNS URI
 * (<name>.<namespace>.svc.cluster.local:<port>) from state.allocations.
 * No input data needed — the handler looks up the allocation by selfComponentName.
 *
 * Result metadata includes the protocol and port for connecting.
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
