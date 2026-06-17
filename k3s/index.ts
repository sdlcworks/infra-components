import { z } from "zod";

import {
  CloudProvider,
  InfraComponent,
  connectionHandler,
  DeploymentArtifactType,
} from "@sdlcworks/components";
import { K3sInternalCI, PublicCI } from "../_internal/interfaces";

import * as gcp from "@pulumi/gcp";
import * as pulumi from "@pulumi/pulumi";
import * as command from "@pulumi/command";
import * as tls from "@pulumi/tls";
import * as k8s from "@pulumi/kubernetes";
// @ts-ignore — js-yaml ships no declaration file but works at runtime.
import * as yaml from "js-yaml";
import { createHash } from "crypto";
import * as https from "https";

// ---- Zod Enums for Config Options ----

const MachineType = z.enum([
  // E2 (cost-optimised, shared-core)
  "e2-micro",
  "e2-small",
  "e2-medium",
  "e2-standard-2",
  "e2-standard-4",
  "e2-standard-8",
  "e2-standard-16",
  "e2-standard-32",
  "e2-highcpu-2",
  "e2-highcpu-4",
  "e2-highcpu-8",
  "e2-highcpu-16",
  "e2-highcpu-32",
  "e2-highmem-2",
  "e2-highmem-4",
  "e2-highmem-8",
  "e2-highmem-16",
  // N4A (ARM-based, Axion)
  "n4a-standard-1",
  "n4a-standard-2",
  "n4a-standard-4",
  "n4a-standard-8",
  "n4a-highmem-1",
  "n4a-highmem-2",
  "n4a-highmem-4",
  "n4a-highmem-8",
  "n4a-highcpu-1",
  "n4a-highcpu-2",
  "n4a-highcpu-4",
  "n4a-highcpu-8",
  // N2 (balanced, 2nd gen Intel)
  "n2-standard-2",
  "n2-standard-4",
  "n2-standard-8",
  "n2-standard-16",
  "n2-standard-32",
  "n2-highcpu-2",
  "n2-highcpu-4",
  "n2-highcpu-8",
  "n2-highcpu-16",
  "n2-highcpu-32",
  "n2-highmem-2",
  "n2-highmem-4",
  "n2-highmem-8",
  "n2-highmem-16",
  // N2D (AMD EPYC)
  "n2d-standard-2",
  "n2d-standard-4",
  "n2d-standard-8",
  "n2d-standard-16",
  "n2d-highcpu-2",
  "n2d-highcpu-4",
  "n2d-highcpu-8",
  "n2d-highcpu-16",
  // C2 (compute-optimised)
  "c2-standard-4",
  "c2-standard-8",
  "c2-standard-16",
  "c2-standard-30",
  // T2D (scale-out, AMD)
  "t2d-standard-1",
  "t2d-standard-2",
  "t2d-standard-4",
  "t2d-standard-8",
]);

const DiskType = z.enum([
  "pd-standard",
  "pd-balanced",
  "pd-ssd",
  "pd-extreme",
  "hyperdisk-balanced",
  "hyperdisk-throughput",
]);

const K3sChannel = z.enum(["stable", "latest", "testing"]);

const K3sRole = z.enum(["server", "agent"]);

const ServiceType = z.enum(["ClusterIP", "NodePort", "LoadBalancer"]);

const DeploymentStrategy = z.enum(["RollingUpdate", "Recreate"]);

const ConcurrencyPolicy = z.enum(["Allow", "Forbid", "Replace"]);

const DaemonSetUpdateStrategy = z.enum(["RollingUpdate", "OnDelete"]);

// ---- Reusable Schema Definitions ----

const AdditionalDiskSchema = z.object({
  sizeGb: z.number().min(1).max(65536),
  type: DiskType.default("pd-balanced"),
  autoDelete: z.boolean().default(true),
});

// Cluster-wide default container resource quantities.
const ResourceQuantitySchema = z.object({
  cpu: z.string().describe('CPU quantity, e.g. "500m" or "2"'),
  memory: z.string().describe('Memory quantity, e.g. "512Mi" or "2Gi"'),
});

// Per-namespace ResourceQuota applied during allocateWithPulumiCtx.
const NamespaceQuotaSchema = z.object({
  maxCpu: z.string().describe('Hard CPU limit across all pods, e.g. "4"'),
  maxMemory: z.string().describe('Hard memory limit, e.g. "8Gi"'),
  maxPods: z.number().int().positive().describe("Hard pod count limit"),
});

// HTTP probe configuration (health checks / readiness checks).
const HttpProbeSchema = z.object({
  type: z.literal("http"),
  path: z.string().default("/"),
  port: z.number().default(8080),
  initialDelaySeconds: z.number().default(10),
  periodSeconds: z.number().default(10),
  timeoutSeconds: z.number().default(5),
  failureThreshold: z.number().default(3),
});

const TcpProbeSchema = z.object({
  type: z.literal("tcp"),
  port: z.number().int(),
  initialDelaySeconds: z.number().int().default(10),
  periodSeconds: z.number().int().default(10),
  timeoutSeconds: z.number().int().default(5),
  failureThreshold: z.number().int().default(3),
});

const ProbeSchema = z.discriminatedUnion("type", [
  HttpProbeSchema,
  TcpProbeSchema,
]);

// Volume mount — references a ConfigMap or Secret by name.
const VolumeMountSchema = z.object({
  name: z.string().describe("Volume name (must match a volume defined below)"),
  mountPath: z.string(),
  readOnly: z.boolean().default(false),
});

const ConfigMapVolumeSchema = z.object({
  type: z.literal("configMap"),
  name: z.string().describe("Volume name"),
  configMapName: z.string(),
});

const SecretVolumeSchema = z.object({
  type: z.literal("secret"),
  name: z.string().describe("Volume name"),
  secretName: z.string(),
});

const EmptyDirVolumeSchema = z.object({
  type: z.literal("emptyDir"),
  name: z.string().describe("Volume name"),
  medium: z.enum(["", "Memory"]).default(""),
});

const VolumeSchema = z.discriminatedUnion("type", [
  ConfigMapVolumeSchema,
  SecretVolumeSchema,
  EmptyDirVolumeSchema,
]);

// Kubernetes toleration for node affinity / taints.
const TolerationSchema = z.object({
  key: z.string().optional(),
  operator: z.enum(["Exists", "Equal"]).default("Equal"),
  value: z.string().optional(),
  effect: z.enum(["NoSchedule", "PreferNoSchedule", "NoExecute"]).optional(),
  tolerationSeconds: z.number().optional(),
});

// Ingress rule definition for Deployment workloads.
const IngressRuleSchema = z.object({
  host: z.string().describe("Hostname, e.g. api.example.com"),
  path: z.string().default("/"),
  pathType: z
    .enum(["Prefix", "Exact", "ImplementationSpecific"])
    .default("Prefix"),
  // Override the service port for this specific rule; defaults to servicePort.
  servicePort: z.number().optional(),
});

const IngressConfigSchema = z.object({
  rules: z.array(IngressRuleSchema).min(1),
  // Annotations forwarded verbatim to the Ingress resource (e.g. cert-manager, nginx class).
  annotations: z.record(z.string(), z.string()).default({}),
  // TLS: maps hosts to secret names that hold the TLS certificate.
  tls: z
    .array(
      z.object({
        hosts: z.array(z.string()),
        secretName: z.string(),
      }),
    )
    .optional(),
});

// ---- Per-node Configuration Schema ----
//
// Each entry in the `nodes` map corresponds to one GCE VM in the cluster.
// Node-specific settings (zone, machineType, disk, scheduling, network IP
// assignment) live here; cluster-level settings live in the top-level config.

const NodeConfigSchema = z.object({
  // Role determines how this node joins: "server" nodes run the k3s control
  // plane; "agent" nodes run only the kubelet/container runtime.
  role: K3sRole,

  // GCE zone for this node.  Nodes in different zones provide HA spread.
  zone: z.string(),

  // GCE machine type.
  machineType: MachineType.default("e2-standard-2").meta({ "x-replacement-trigger": true }),

  // Boot disk settings.
  bootDiskSizeGb: z.number().min(10).max(65536).default(50),
  bootDiskType: DiskType.default("pd-balanced"),
  imageFamily: z.string().default("ubuntu-2404-lts-amd64"),
  imageProject: z.string().default("ubuntu-os-cloud"),

  // Scheduling: preemptible instances are cheaper but can be reclaimed at any time.
  preemptible: z.boolean().default(false),

  // Shielded VM options.
  enableSecureBoot: z.boolean().default(false),
  enableVtpm: z.boolean().default(false),
  enableIntegrityMonitoring: z.boolean().default(false),

  // Per-node GCE metadata and labels.
  instanceLabels: z.record(z.string(), z.string()).default({}),
  instanceMetadata: z.record(z.string(), z.string()).default({}),

  // Additional data disks attached to this specific node.
  additionalDisks: z.array(AdditionalDiskSchema).default([]),

  // Node-specific network tags (merged with cluster-level networkTags).
  networkTags: z.array(z.string()).default([]),

  // IP assignment for this node.
  assignExternalIp: z
    .boolean()
    .default(true)
    .describe("Assign an ephemeral public IP when no static IP is provided"),
  externalIpAddress: z
    .string()
    .optional()
    .describe("Pre-allocated static external IP address to attach"),

  // Required by k3s flannel CNI for pod-to-pod routing.
  enableIpForwarding: z.boolean().default(true),
});

// ---- Machine Group Schema ----
//
// Machine groups define pools of GCE VMs with a specific machine type.
// Exactly one group must have role: "server" (control plane).
// If multiple groups exist, the server group becomes a dedicated control plane
// (tainted NoSchedule). If only one group, the server node also runs workloads.

const MachineGroupAutoscalingSchema = z.object({
  minNodes: z.number().int().min(1),
  maxNodes: z.number().int().min(1),
  targetCpuUtilization: z.number().min(0.1).max(1.0).default(0.7),
  cooldownPeriodSec: z.number().int().default(300),
});

const MachineGroupSchema = z.object({
  role: z.enum(["server"]).optional().describe('Exactly one group must have role "server"'),
  machineType: MachineType.default("e2-standard-2").meta({ "x-replacement-trigger": true }),
  count: z.number().int().min(1).optional().describe("Fixed node count (static mode)"),
  autoscaling: MachineGroupAutoscalingSchema.optional().describe("VM autoscaling (MIG mode)"),
  zone: z.string(),
  bootDiskSizeGb: z.number().min(10).max(65536).default(50),
  bootDiskType: DiskType.default("pd-balanced"),
  imageFamily: z.string().default("ubuntu-2404-lts-amd64"),
  imageProject: z.string().default("ubuntu-os-cloud"),
  preemptible: z.boolean().default(false),
  assignExternalIp: z.boolean().default(true),
  enableSecureBoot: z.boolean().default(false),
  enableVtpm: z.boolean().default(false),
  enableIntegrityMonitoring: z.boolean().default(false),
});

// ---- Deployment Config Schemas (per-workload-type, discriminated union) ----
//
// These schemas define what an app component author provides in their
// `infra_target.deployment_config` when targeting this k3s infra component.
// The discriminator field is `workloadType`.

const CommonWorkloadFields = {
  // Kubernetes namespace name.  Defaults to "components".
  namespace: z.string().default("components"),

  // Main container port.
  containerPort: z.number().int().default(8080),

  // Per-component resource overrides — fall back to cluster-level defaults when absent.
  resourceLimits: ResourceQuantitySchema.optional(),
  resourceRequests: ResourceQuantitySchema.optional(),

  // Per-component namespace quota — fall back to cluster-level default when absent.
  namespaceQuota: NamespaceQuotaSchema.optional(),

  // Container command + args overrides.
  command: z.array(z.string()).optional(),
  args: z.array(z.string()).optional(),

  // Volumes and mounts.
  volumes: z.array(VolumeSchema).default([]),
  volumeMounts: z.array(VolumeMountSchema).default([]),

  // Node placement.
  machineGroup: z.string().optional().describe("Machine group this workload should run on"),
  nodeSelector: z.record(z.string(), z.string()).optional(),
  tolerations: z.array(TolerationSchema).default([]),

  // Attach a pre-existing ServiceAccount.
  serviceAccountName: z.string().optional(),
};

const AutoscalingSchema = z.object({
  enabled: z.boolean().default(false),
  minReplicas: z.number().int().min(1).default(1),
  maxReplicas: z.number().int().min(1).default(10),
  targetCPUUtilizationPercentage: z.number().int().min(1).max(100).default(70),
  targetMemoryUtilizationPercentage: z.number().int().min(1).max(100).optional(),
});

const DeploymentConfigSchema = z.object({
  workloadType: z.literal("deployment"),
  ...CommonWorkloadFields,

  replicas: z.number().int().min(0).default(1),
  strategy: DeploymentStrategy.default("RollingUpdate"),
  maxSurge: z.string().default("25%"),
  maxUnavailable: z.string().default("25%"),

  serviceType: ServiceType.default("ClusterIP"),
  servicePort: z.number().int().default(80),

  // Liveness and readiness probes (HTTP or TCP).
  livenessProbe: ProbeSchema.optional(),
  readinessProbe: ProbeSchema.optional(),

  // Optional Ingress resource — only created when this is present.
  ingress: IngressConfigSchema.optional(),

  // Horizontal Pod Autoscaler — scales pods based on CPU/memory utilisation.
  autoscaling: AutoscalingSchema.optional(),

  // Seconds to wait for graceful shutdown before force-killing the pod.
  terminationGracePeriodSeconds: z.number().int().min(0).default(30),
});

const StatefulSetConfigSchema = z.object({
  workloadType: z.literal("stateful-set"),
  ...CommonWorkloadFields,

  replicas: z.number().int().min(1).default(1),

  // Headless service name.  Defaults to the app component name.
  serviceName: z.string().optional(),

  // Liveness and readiness probes (HTTP or TCP).
  livenessProbe: ProbeSchema.optional(),
  readinessProbe: ProbeSchema.optional(),

  // PVC template settings applied to every pod replica.
  storageSize: z.string().default("10Gi"),
  storageClass: z.string().optional(),
  accessModes: z
    .array(z.enum(["ReadWriteOnce", "ReadOnlyMany", "ReadWriteMany"]))
    .default(["ReadWriteOnce"]),

  // Mount path for the PVC inside the container.
  storageMountPath: z.string().default("/data"),
});

const CronJobConfigSchema = z.object({
  workloadType: z.literal("cron-job"),
  ...CommonWorkloadFields,

  // Standard cron expression, e.g. "0 * * * *".
  schedule: z.string().describe('Cron schedule expression, e.g. "0 * * * *"'),
  concurrencyPolicy: ConcurrencyPolicy.default("Forbid"),
  successfulJobsHistoryLimit: z.number().int().min(0).default(3),
  failedJobsHistoryLimit: z.number().int().min(0).default(1),

  // Pod-level settings.
  backoffLimit: z.number().int().min(0).default(6),
  activeDeadlineSeconds: z.number().int().optional(),

  // Restart policy for the job pods.
  restartPolicy: z.enum(["OnFailure", "Never"]).default("OnFailure"),
});

const JobConfigSchema = z.object({
  workloadType: z.literal("job"),
  ...CommonWorkloadFields,

  backoffLimit: z.number().int().min(0).default(6),
  parallelism: z.number().int().min(1).default(1),
  completions: z.number().int().min(1).default(1),
  activeDeadlineSeconds: z.number().int().optional(),
  restartPolicy: z.enum(["OnFailure", "Never"]).default("OnFailure"),
});

const DaemonSetConfigSchema = z.object({
  workloadType: z.literal("daemon-set"),
  ...CommonWorkloadFields,

  updateStrategy: DaemonSetUpdateStrategy.default("RollingUpdate"),
  // Only applies when updateStrategy is RollingUpdate.
  maxUnavailable: z.union([z.string(), z.number()]).default(1),
});

// The full discriminated union validated inside allocateWithPulumiCtx.
const WorkloadConfigSchema = z.discriminatedUnion("workloadType", [
  DeploymentConfigSchema,
  StatefulSetConfigSchema,
  CronJobConfigSchema,
  JobConfigSchema,
  DaemonSetConfigSchema,
]);

type DeploymentConfig = z.infer<typeof DeploymentConfigSchema>;
type StatefulSetConfig = z.infer<typeof StatefulSetConfigSchema>;
type CronJobConfig = z.infer<typeof CronJobConfigSchema>;
type JobConfig = z.infer<typeof JobConfigSchema>;
type DaemonSetConfig = z.infer<typeof DaemonSetConfigSchema>;

// ---- App Component Type Schemas ----
//
// tcp-service and http-service reuse the full WorkloadConfigSchema.
// postgres is a specialised StatefulSet-based schema for database workloads.

const TcpServiceDeployConfigSchema = WorkloadConfigSchema;
const HttpServiceDeployConfigSchema = WorkloadConfigSchema;

// Named postgres cluster config — defined in infra config, referenced by app components.
const PostgresClusterConfigSchema = z.object({
  instances: z.number().int().min(1).default(1),
  dbName: z.string(),
  dbUser: z.string().default("postgres"),
  dbPassword: z.string(),
  storageSize: z.string().default("10Gi"),
  storageClass: z.string().default("local-path"),
  parameters: z.record(z.string(), z.string()).optional(),
});

// App component deployment_config for postgres type — references a named cluster.
const PostgresDeployConfigSchema = z.object({
  postgresCluster: z.string().describe("Name of cluster from postgresClusterConfig"),
  namespace: z.string().default("components"),
});

// ---- Component Definition ----

const component = new InfraComponent({
  metadata: {
    // The k3s component itself is not stateful in the framework sense; stateful
    // workloads (StatefulSets with PVCs) are managed by allocateWithPulumiCtx.
    stateful: false,
    proxiable: false,
  },
  acceptedArtifactTypes: [DeploymentArtifactType.oci_spec_image],
  connectionTypes: {
    public: {
      description:
        "exposes the app component via public HTTP on the cluster init server IP",
      interface: PublicCI,
    },
    internal: {
      description:
        "allows internal cluster communication between app components via k8s Service DNS",
      interface: K3sInternalCI,
    },
    tcp: {
      description:
        "allows internal TCP communication (plain, TLS, or mTLS) between app components via k8s Service DNS",
      interface: K3sInternalCI,
    },
    postgres: {
      description:
        "allows internal postgres database access between app components via k8s Service DNS",
      interface: K3sInternalCI,
    },
  } as const,
  connectionInterfaces: [],
  configSchema: z.object({
    // ---- Node Map ----
    //
    // At least one node must be defined with role "server".  The first server
    // node in iteration order becomes the init server: it bootstraps the cluster
    // and its kubeconfig is retrieved by @pulumi/command.  Additional server
    // nodes join with --server (HA embedded etcd); agent nodes join with the
    // default k3s agent mode.
    //
    // When more than one server node is defined, the init server automatically
    // gets --cluster-init so all server nodes use embedded etcd.
    nodes: z
      .record(z.string(), NodeConfigSchema)
      .optional()
      .describe(
        'DEPRECATED: Use machineGroups instead. Map of node name to node config.',
      ),

    machineGroups: z
      .record(z.string(), MachineGroupSchema)
      .optional()
      .describe(
        'Map of group name to machine group config. Exactly one group must have role "server".',
      ),

    // ---- Shared Network Configuration ----
    //
    // All nodes are placed in the same VPC network and subnet.  Individual nodes
    // can augment this with their own networkTags in NodeConfigSchema.

    networkId: z
      .string()
      .optional()
      .describe(
        "VPC network self-link or ID. When omitted, nodes are placed on GCP's default network.",
      ),
    subnetId: z
      .string()
      .optional()
      .describe(
        "Subnet self-link or ID. When omitted, GCP auto-selects the default subnet for the node's region.",
      ),

    // Cluster-wide network tags applied to every node (matched by firewall rules).
    networkTags: z
      .array(z.string())
      .default([])
      .describe(
        "Network tags applied to all nodes for associating external firewall rules",
      ),

    // ---- K3s Core Configuration ----

    k3sVersion: z
      .string()
      .optional()
      .describe(
        'Pin a specific k3s release, e.g. "v1.30.2+k3s1". Takes precedence over k3sChannel.',
      ),
    k3sChannel: K3sChannel.default("stable"),

    // Extra flags forwarded verbatim to the k3s install script as INSTALL_K3S_EXEC.
    k3sInstallFlags: z
      .array(z.string())
      .default([])
      .describe(
        'Extra flags passed to k3s at install, e.g. ["--disable=traefik"]',
      ),

    // Additional TLS SANs appended to the k3s API server certificate.
    // The init server's external IP is always added automatically.
    tlsSan: z
      .array(z.string())
      .default([])
      .describe("Additional TLS SANs added to the k3s API server certificate"),

    // Pre-shared cluster token (K3S_TOKEN).  When omitted, the component
    // auto-generates a cryptographically-random token via pulumi.RandomPassword
    // and distributes it to all nodes.
    clusterToken: z
      .string()
      .optional()
      .describe(
        "K3S_TOKEN — shared secret that all nodes use to join the cluster. " +
          "Auto-generated when omitted.",
      ),

    // ---- K3s Network / Cluster Settings ----

    clusterCidr: z
      .string()
      .default("10.42.0.0/16")
      .describe("CIDR for pod IPs (flannel overlay network)"),
    serviceCidr: z
      .string()
      .default("10.43.0.0/16")
      .describe("CIDR for ClusterIP services"),
    clusterDns: z
      .string()
      .default("10.43.0.10")
      .describe("In-cluster DNS server address (must be within serviceCidr)"),

    // ---- K3s Addon / Component Toggles ----

    disableTraefik: z
      .boolean()
      .default(false)
      .describe("Disable the built-in Traefik ingress controller"),
    disableServiceLb: z
      .boolean()
      .default(false)
      .describe(
        "Disable the built-in ServiceLB (klipper) load-balancer. " +
          "Automatically forced true when enableCloudController is set.",
      ),
    disableLocalStorage: z
      .boolean()
      .default(false)
      .describe("Disable the built-in local-path storage provisioner"),
    disableMetricsServer: z
      .boolean()
      .default(false)
      .describe("Disable the built-in metrics-server"),
    disableCoredns: z
      .boolean()
      .default(false)
      .describe("Disable the built-in CoreDNS"),

    // ---- Monitoring (Grafana — hosted or self-hosted) ----

    monitoring: z
      .object({
        enabled: z.boolean().default(false),
        mode: z
          .enum(["hosted", "self-hosted"])
          .default("self-hosted")
          .describe("'hosted' uses Grafana Cloud (lightweight agent only), 'self-hosted' deploys kube-prometheus-stack"),
        // Hosted mode (Grafana Cloud)
        grafanaCloud: z
          .object({
            apiKey: z.string(),
            prometheusEndpoint: z.string(),
            lokiEndpoint: z.string(),
            instanceId: z.string().describe("Prometheus user/instance ID"),
            lokiUserId: z.string().describe("Loki user/instance ID (different from Prometheus)"),
          })
          .optional(),
        // Self-hosted mode
        grafanaNodePort: z
          .number()
          .int()
          .default(30080)
          .describe("NodePort to expose Grafana UI (30000-32767)"),
        grafanaAdminPassword: z
          .string()
          .default("admin")
          .describe("Grafana admin password"),
        retentionDays: z
          .number()
          .int()
          .default(7)
          .describe("How many days Prometheus keeps metrics data"),
      })
      .default({}),

    // ---- Postgres Clusters (CloudNativePG) ----
    //
    // Named postgres cluster configs. When entries exist, the CloudNativePG
    // operator is auto-installed and clusters are created.
    // App components reference clusters by name in deployment_config.

    postgresClusterConfig: z
      .record(z.string(), PostgresClusterConfigSchema)
      .default({}),

    // ---- Cloud Controller Manager ----

    enableCloudController: z
      .boolean()
      .default(false)
      .describe(
        "Deploy the GCP Cloud Controller Manager (CCM) so that Kubernetes " +
          "`type: LoadBalancer` services provision real GCP Network Load Balancers " +
          "instead of the klipper (ServiceLB) node-binding fallback. " +
          "When enabled, the component automatically: disables klipper, disables " +
          "k3s's built-in cloud controller, creates a dedicated GCE service account " +
          "with compute.loadBalancerAdmin / compute.networkViewer / " +
          "compute.instanceAdmin.v1 IAM roles, attaches it to every server node, " +
          "and writes the CCM manifests to the k3s auto-deploy directory on the init " +
          "server so the CCM pod starts as soon as the cluster is ready.",
      ),
    cloudControllerImageTag: z
      .string()
      .optional()
      .describe(
        "Container image tag for `registry.k8s.io/cloud-provider-gcp/cloud-controller-manager`. " +
          "Defaults to v30.0.0.",
      ),

    // ---- Default Workload Settings (cluster-wide) ----
    // Applied to all app components allocated onto this cluster unless the app
    // component's own deploymentConfig overrides them.

    defaultResourceLimits: ResourceQuantitySchema.optional().describe(
      "Default container resource limits applied when an app component does not specify its own",
    ),
    defaultResourceRequests: ResourceQuantitySchema.optional().describe(
      "Default container resource requests applied when an app component does not specify its own",
    ),
    defaultNamespaceQuota: NamespaceQuotaSchema.optional().describe(
      "Default namespace-level resource quota applied to every allocated app component namespace",
    ),
  }),
  appComponentTypes: {
    "tcp-service": TcpServiceDeployConfigSchema,
    "http-service": HttpServiceDeployConfigSchema,
    postgres: PostgresDeployConfigSchema,
  },
  outputSchema: z.object({
    // k8s API server endpoint — https://<init-server-ip>:6443
    apiServerUrl: z.string(),
    // Per-node outputs keyed by node name.
    nodes: z.record(
      z.string(),
      z.object({
        instanceId: z.string(),
        instanceSelfLink: z.string(),
        instanceName: z.string(),
        zone: z.string(),
        internalIp: z.string(),
        externalIp: z.string().optional(),
      }),
    ),
  }),
});

// ---- GCloud Provider Implementation ----

component.implement(CloudProvider.gcloud, {
  stateSchema: z.object({
    // Full kubeconfig YAML string retrieved from the init server after boot.
    // Used by allocateWithPulumiCtx and upsertArtifacts to talk to the k8s API.
    kubeconfig: z.string(),
    // https://<init-server-ip>:6443 — also encoded in the kubeconfig but kept
    // separately so later lifecycle hooks can reference it cheaply.
    apiServerUrl: z.string(),
    // Per-node SSH private keys (each node gets its own key).
    sshKeys: z.record(z.string(), z.string()),
    // Per-node IP info.
    nodeIps: z.record(
      z.string(),
      z.object({
        internalIp: z.string(),
        externalIp: z.string().optional(),
      }),
    ),
    // Cluster-wide defaults forwarded from infra config so allocateWithPulumiCtx
    // can apply them without access to the original inputs.
    defaultResourceLimits: ResourceQuantitySchema.optional(),
    defaultResourceRequests: ResourceQuantitySchema.optional(),
    defaultNamespaceQuota: NamespaceQuotaSchema.optional(),
    // Written by allocateWithPulumiCtx for each app component so that
    // upsertArtifacts and the connect handler know the workload type, namespace,
    // and service port to use when constructing cluster-internal URIs.
    allocations: z
      .record(
        z.string(),
        z.object({
          appComponentType: z.string(),
          workloadType: z.enum([
            "deployment",
            "stateful-set",
            "cron-job",
            "job",
            "daemon-set",
          ]),
          namespace: z.string(),
          // The port exposed by the k8s Service for this component.
          // For deployments this is servicePort; for stateful-sets it is
          // containerPort (headless service); absent for job/cron-job/daemon-set.
          servicePort: z.number().optional(),
          // Postgres-specific fields (only present when appComponentType === "postgres")
          dbName: z.string().optional(),
          dbUser: z.string().optional(),
          dbPassword: z.string().optional(),
          postgresClusterName: z.string().optional(),
        }),
      )
      .default({}),
  }),
  initialState: {
    sshKeys: {},
    nodeIps: {},
  },

  pulumi: async ({
    $,
    inputs,
    state,
    getCredentials,
    gcp: gcpProvider,
  }) => {
    // Default opts for all GCP resources — uses the explicit provider from gen.ts
    const gcpOpts: pulumi.CustomResourceOptions = gcpProvider ? { provider: gcpProvider } : {};

    const {
      nodes,
      machineGroups,
      networkId,
      subnetId,
      networkTags: clusterNetworkTags,
      k3sVersion,
      k3sChannel,
      k3sInstallFlags,
      tlsSan,
      clusterToken: userClusterToken,
      clusterCidr,
      serviceCidr,
      clusterDns,
      disableTraefik,
      disableServiceLb,
      disableLocalStorage,
      disableMetricsServer,
      disableCoredns,
      enableCloudController,
      cloudControllerImageTag,
      defaultResourceLimits,
      defaultResourceRequests,
      defaultNamespaceQuota,
    } = inputs;

    // ---- Partition nodes ----
    //
    // Supports two modes:
    //   1. machineGroups (new): pools of machines, one group has role "server"
    //   2. nodes (legacy): flat map of individually named nodes
    //
    // When machineGroups is set, nodes from each group are provisioned with
    // labels for scheduling. If multiple groups exist, the server group becomes
    // a dedicated control plane (tainted NoSchedule).

    // Helper: convert MachineGroupSchema entry to NodeConfigSchema-compatible object
    function machineGroupToNodeConfig(
      groupConfig: z.infer<typeof MachineGroupSchema>,
    ): z.infer<typeof NodeConfigSchema> {
      return {
        role: "agent" as const, // role is determined by provisioning logic, not config
        zone: groupConfig.zone,
        machineType: groupConfig.machineType,
        bootDiskSizeGb: groupConfig.bootDiskSizeGb,
        bootDiskType: groupConfig.bootDiskType,
        imageFamily: groupConfig.imageFamily,
        imageProject: groupConfig.imageProject,
        preemptible: groupConfig.preemptible,
        assignExternalIp: groupConfig.assignExternalIp,
        enableSecureBoot: groupConfig.enableSecureBoot,
        enableVtpm: groupConfig.enableVtpm,
        enableIntegrityMonitoring: groupConfig.enableIntegrityMonitoring,
        additionalDisks: [],
        networkTags: [],
        instanceLabels: {},
        instanceMetadata: {},
        enableIpForwarding: true,
      };
    }

    let initServerName: string;
    let initServerConfig: z.infer<typeof NodeConfigSchema>;
    let additionalServerEntries: [string, z.infer<typeof NodeConfigSchema>][];
    let agentEntries: [string, z.infer<typeof NodeConfigSchema>][];
    let isHa: boolean;
    // nodeLabels: map of node name → k3s node labels to apply
    const nodeLabelsMap: Record<string, string[]> = {};
    // nodeTaints: map of node name → k3s node taints to apply
    const nodeTaintsMap: Record<string, string[]> = {};
    // Autoscaled groups (provisioned via MIG after init server is up)
    let autoscaledGroups: [string, z.infer<typeof MachineGroupSchema>, z.infer<typeof MachineGroupAutoscalingSchema>][] = [];

    if (machineGroups && Object.keys(machineGroups).length > 0) {
      // ---- Machine Groups mode ----
      const groupEntries = Object.entries(machineGroups as Record<string, z.infer<typeof MachineGroupSchema>>);
      const serverGroups = groupEntries.filter(([, g]) => g.role === "server");

      if (serverGroups.length === 0) {
        throw new Error('machineGroups: exactly one group must have role "server"');
      }
      if (serverGroups.length > 1) {
        throw new Error('machineGroups: only one group can have role "server"');
      }

      const [serverGroupName, serverGroupConfig] = serverGroups[0];
      const isMultiGroup = groupEntries.length > 1;

      // Init server: first node of the server group
      initServerName = `${serverGroupName}-1`;
      initServerConfig = machineGroupToNodeConfig(serverGroupConfig);
      // Override role to server for the config (used by provisionNode's cloud-init)
      initServerConfig.role = "server" as any;

      // Validate server group uses count (not autoscaling)
      if (serverGroupConfig.autoscaling) {
        throw new Error('machineGroups: server group cannot use autoscaling');
      }
      if (!serverGroupConfig.count) {
        throw new Error('machineGroups: server group must have "count"');
      }

      // Validate agent groups have either count or autoscaling
      for (const [gn, gc] of groupEntries) {
        if (gn === serverGroupName) continue;
        if (!gc.count && !gc.autoscaling) {
          throw new Error(`machineGroups: group "${gn}" must have either "count" or "autoscaling"`);
        }
        if (gc.count && gc.autoscaling) {
          throw new Error(`machineGroups: group "${gn}" cannot have both "count" and "autoscaling"`);
        }
      }

      nodeLabelsMap[initServerName] = [`sdlc.works/machine-group=${serverGroupName}`];
      if (isMultiGroup) {
        nodeTaintsMap[initServerName] = ["node-role.kubernetes.io/control-plane=:NoSchedule"];
      }

      // Remaining nodes of server group (agents, static only)
      additionalServerEntries = [];
      agentEntries = [];

      for (let i = 1; i < serverGroupConfig.count; i++) {
        const nodeName = `${serverGroupName}-${i + 1}`;
        agentEntries.push([nodeName, machineGroupToNodeConfig(serverGroupConfig)]);
        nodeLabelsMap[nodeName] = [`sdlc.works/machine-group=${serverGroupName}`];
      }

      // Other groups: static agents (autoscaled groups handled after init server is up)

      for (const [groupName, groupConfig] of groupEntries) {
        if (groupName === serverGroupName) continue;

        if (groupConfig.autoscaling) {
          // Autoscaled: defer to MIG provisioning after init server
          autoscaledGroups.push([groupName, groupConfig, groupConfig.autoscaling]);
        } else {
          // Static: individual instances
          for (let i = 0; i < groupConfig.count!; i++) {
            const nodeName = `${groupName}-${i + 1}`;
            agentEntries.push([nodeName, machineGroupToNodeConfig(groupConfig)]);
            nodeLabelsMap[nodeName] = [`sdlc.works/machine-group=${groupName}`];
          }
        }
      }

      isHa = false; // Machine groups don't support multi-server HA yet
    } else if (nodes && Object.keys(nodes).length > 0) {
      // ---- Legacy nodes mode ----
      const nodeEntries = Object.entries(
        nodes as Record<string, z.infer<typeof NodeConfigSchema>>,
      );
      const serverEntries = nodeEntries.filter(([, n]) => n.role === "server");
      agentEntries = nodeEntries.filter(([, n]) => n.role === "agent");

      if (serverEntries.length === 0) {
        throw new Error(
          'k3s: the "nodes" map must contain at least one node with role "server"',
        );
      }

      [initServerName, initServerConfig] = serverEntries[0];
      additionalServerEntries = serverEntries.slice(1);
      isHa = additionalServerEntries.length > 0;
    } else {
      throw new Error('k3s: either "nodes" or "machineGroups" must be provided');
    }

    // ---- 1. Auto-generate cluster token if not provided ----
    //
    // All nodes share K3S_TOKEN so they can join the same cluster.  We derive a
    // stable pseudo-random token from a Pulumi-managed TLS private key.  The
    // key's raw bytes are hashed to produce a hex string that is deterministic
    // across `pulumi up` runs (Pulumi tracks the key resource in state).
    const tokenKey = new tls.PrivateKey($`cluster-token-key`, {
      algorithm: "ED25519",
    });

    // Prefer user-supplied token; fall back to the derived one.
    const clusterToken = pulumi
      .all([pulumi.output(userClusterToken), tokenKey.privateKeyOpenssh])
      .apply(([userToken, keyMaterial]) => {
        if (userToken) return userToken;
        return createHash("sha256").update(keyMaterial).digest("hex");
      });

    // ---- 2. CCM service account (optional) ----
    //
    // When the GCP Cloud Controller Manager is enabled, create a GCE service
    // account with the IAM permissions it needs, then attach it to every server
    // node.  Agent nodes don't need it — they don't run the CCM.
    const ccmServiceAccount = enableCloudController
      ? new gcp.serviceaccount.Account($`ccm-sa`, {
          accountId: $`ccm-sa`,
          displayName: "GCP Cloud Controller Manager service account",
        }, gcpOpts)
      : null;

    if (ccmServiceAccount) {
      const projectId = getCredentials().GCP_PROJECT_ID;
      const saEmail = pulumi.interpolate`serviceAccount:${ccmServiceAccount.email}`;

      new gcp.projects.IAMMember($`ccm-iam-lb`, {
        project: projectId,
        role: "roles/compute.loadBalancerAdmin",
        member: saEmail,
      }, gcpOpts);

      new gcp.projects.IAMMember($`ccm-iam-network`, {
        project: projectId,
        role: "roles/compute.networkViewer",
        member: saEmail,
      }, gcpOpts);

      new gcp.projects.IAMMember($`ccm-iam-instance`, {
        project: projectId,
        role: "roles/compute.instanceAdmin.v1",
        member: saEmail,
      }, gcpOpts);
    }

    // ---- 3. Cluster-level k3s flags ----

    const clusterNetworkFlags = pulumi
      .all([clusterCidr, serviceCidr, clusterDns])
      .apply(([podCidr, svcCidr, dns]) => [
        `--cluster-cidr=${podCidr}`,
        `--service-cidr=${svcCidr}`,
        `--cluster-dns=${dns}`,
      ]);

    // When the cloud controller is enabled, klipper must be disabled.
    const effectiveDisableServiceLb = enableCloudController
      ? true
      : disableServiceLb;

    const disableFlags = pulumi
      .all([
        disableTraefik,
        effectiveDisableServiceLb,
        disableLocalStorage,
        disableMetricsServer,
        disableCoredns,
      ])
      .apply(([traefik, serviceLb, localStorage, metricsServer, coredns]) => {
        const addons: string[] = [];
        if (traefik) addons.push("traefik");
        if (serviceLb) addons.push("servicelb");
        if (localStorage) addons.push("local-storage");
        if (metricsServer) addons.push("metrics-server");
        if (coredns) addons.push("coredns");
        return addons.length > 0 ? [`--disable=${addons.join(",")}`] : [];
      });

    // ---- Helper: provision a single GCE node ----

    function provisionNode(
      nodeName: string,
      nodeConfig: z.infer<typeof NodeConfigSchema>,
      nodeRole: "init-server" | "server" | "agent",
      initServerIp: pulumi.Output<string> | undefined,
      nodeLabels?: string[],
      nodeTaints?: string[],
    ) {
      // Generate an ephemeral SSH key for this node.
      const sshKey = new tls.PrivateKey($`ssh-key-${nodeName}`, {
        algorithm: "ED25519",
      });

      // Resolve boot disk image. The selfLink changes when Google publishes a
      // newer image in the family, but we suppress the diff via ignoreChanges
      // on the Instance resource (see below) to prevent VM replacement.
      const bootImage = gcp.compute.getImageOutput({
        family: nodeConfig.imageFamily,
        project: nodeConfig.imageProject,
      }, gcpOpts);

      // Build additional data disks for this node.
      const attachedDataDisks: gcp.types.input.compute.InstanceAttachedDisk[] =
        [];
      for (let i = 0; i < nodeConfig.additionalDisks.length; i++) {
        const disk = nodeConfig.additionalDisks[i];
        const dataDisk = new gcp.compute.Disk($`data-disk-${nodeName}-${i}`, {
          zone: nodeConfig.zone,
          size: disk.sizeGb,
          type: disk.type,
          description: "Data disk managed by sdlc.works",
        }, gcpOpts);
        attachedDataDisks.push({
          source: dataDisk.selfLink,
          mode: "READ_WRITE",
        });
      }

      // Merge cluster-level and node-level network tags.
      const mergedTags = pulumi
        .all([
          pulumi.output(clusterNetworkTags),
          pulumi.output(nodeConfig.networkTags),
        ])
        .apply(([clusterTags, nodeTags]) =>
          Array.from(new Set([...clusterTags, ...nodeTags])),
        );

      // Resolve access config (external IP).
      const accessConfigs: gcp.types.input.compute.InstanceNetworkInterfaceAccessConfig[] =
        nodeConfig.externalIpAddress
          ? [{ natIp: nodeConfig.externalIpAddress, networkTier: "PREMIUM" }]
          : nodeConfig.assignExternalIp
            ? [{ networkTier: "PREMIUM" }]
            : [];

      // Build cloud-init.
      //
      // The init server bootstraps with --cluster-init (HA) or plain --server
      // (single-server).  Additional servers join with --server <url>.
      // Agents join without any role flag (default k3s behaviour).
      const resolvedJoinIp =
        initServerIp ?? pulumi.output(undefined as string | undefined);

      // Combine all cluster-level flags into a single Output<string[]> so
      // cloud-init receives exactly one resolved array of flags.
      const allServerFlags = pulumi
        .all([
          clusterNetworkFlags,
          disableFlags,
          pulumi.output(k3sInstallFlags),
        ])
        .apply(([netFlags, disFlags, userFlags]) => [
          ...(netFlags as string[]),
          ...(disFlags as string[]),
          ...(userFlags as string[]),
        ]);

      // Split into two groups of <=8 to stay within pulumi.all() tuple overloads.
      const cloudInitGroupA = pulumi.all([
        pulumi.output(k3sVersion),
        pulumi.output(k3sChannel),
        pulumi.output(tlsSan),
        clusterToken,
        sshKey.publicKeyOpenssh,
        allServerFlags,
      ] as [
        pulumi.Output<string | undefined>,
        pulumi.Output<string>,
        pulumi.Output<string[]>,
        pulumi.Output<string>,
        pulumi.Output<string>,
        pulumi.Output<string[]>,
      ]);

      const cloudInitGroupB = pulumi.all([
        pulumi.output(enableCloudController),
        mergedTags,
        pulumi.output(cloudControllerImageTag),
        resolvedJoinIp,
      ] as [
        pulumi.Output<boolean>,
        pulumi.Output<string[]>,
        pulumi.Output<string | undefined>,
        pulumi.Output<string | undefined>,
      ]);

      const cloudInitScript = pulumi
        .all([cloudInitGroupA, cloudInitGroupB])
        .apply(
          ([
            [version, channel, sans, token, sshPubKey, serverFlags],
            [ccmEnabled, tags, ccmImageTag, joinIp],
          ]) => {
            // Server nodes include cluster-networking, disable, and user flags.
            // Agents only get the user-supplied install flags.
            const baseFlags =
              nodeRole !== "agent"
                ? serverFlags
                : (k3sInstallFlags as string[]);

            const joinUrl = joinIp ? `https://${joinIp}:6443` : undefined;

            return buildK3sCloudInit({
              version,
              channel,
              nodeRole,
              isHa,
              installFlags: baseFlags,
              sans: nodeRole !== "agent" ? sans : [],
              token,
              joinUrl,
              sshPublicKey: sshPubKey,
              cloudController:
                ccmEnabled && nodeRole !== "agent"
                  ? { nodeTags: tags, imageTag: ccmImageTag ?? "v30.0.0" }
                  : undefined,
              nodeLabels,
              nodeTaints,
            });
          },
        );

      // Create the GCE instance.
      const instance = new gcp.compute.Instance($`instance-${nodeName}`, {
        zone: nodeConfig.zone,
        machineType: nodeConfig.machineType,
        description: `k3s ${nodeRole} node managed by sdlc.works`,
        labels: nodeConfig.instanceLabels,
        tags: mergedTags,
        canIpForward: nodeConfig.enableIpForwarding,

        bootDisk: {
          autoDelete: true,
          initializeParams: {
            image: bootImage.selfLink,
            size: nodeConfig.bootDiskSizeGb,
            type: pulumi.interpolate`zones/${nodeConfig.zone}/diskTypes/${nodeConfig.bootDiskType}`,
          },
        },

        attachedDisks: attachedDataDisks,

        networkInterfaces: [
          {
            ...(networkId
              ? { network: networkId }
              : !subnetId
                ? { network: "default" }
                : {}),
            ...(subnetId ? { subnetwork: subnetId } : {}),
            accessConfigs,
          },
        ],

        scheduling: {
          preemptible: nodeConfig.preemptible,
          automaticRestart: nodeConfig.preemptible ? false : true,
          onHostMaintenance: nodeConfig.preemptible ? "TERMINATE" : "MIGRATE",
        },

        shieldedInstanceConfig: {
          enableSecureBoot: nodeConfig.enableSecureBoot,
          enableVtpm: nodeConfig.enableVtpm,
          enableIntegrityMonitoring: nodeConfig.enableIntegrityMonitoring,
        },

        serviceAccount:
          ccmServiceAccount && nodeRole !== "agent"
            ? {
                email: ccmServiceAccount.email,
                scopes: ["https://www.googleapis.com/auth/cloud-platform"],
              }
            : undefined,

        metadata: {
          ...nodeConfig.instanceMetadata,
          "user-data": cloudInitScript,
        },
      },
      {
        ...gcpOpts,
        // Prevent spurious VM replacements: the boot disk image selfLink changes
        // whenever Google publishes a new image in the family. Without this,
        // every `pulumi up` would detect [diff: ~bootDisk] and trigger a
        // ForceNew VM replacement, destroying the entire k3s cluster.
        // Broadened to the entire "bootDisk" block because the GCP provider
        // normalizes nested field paths and narrower paths may not suppress
        // the ForceNew correctly.
        ignoreChanges: ["bootDisk"],
      });

      const internalIp = instance.networkInterfaces[0].networkIp;
      const externalIp = instance.networkInterfaces[0].apply(
        (nic) => nic.accessConfigs?.[0]?.natIp,
      );

      return { instance, sshKey, internalIp, externalIp };
    }

    // ---- 4. Provision the init server ----
    //
    // The init server is provisioned first so its IP can be used as the join
    // URL for all subsequent nodes.

    const {
      instance: initInstance,
      sshKey: initSshKey,
      internalIp: initInternalIp,
      externalIp: initExternalIp,
    } = provisionNode(
      initServerName,
      initServerConfig,
      "init-server",
      undefined,
      nodeLabelsMap[initServerName],
      nodeTaintsMap[initServerName],
    );

    // Prefer external IP for SSH / kubeconfig; fall back to internal IP.
    const initSshHost = initInstance.networkInterfaces[0].apply((nic) => {
      const external = nic.accessConfigs?.[0]?.natIp;
      return external ?? nic.networkIp;
    });

    const apiServerUrl = initSshHost.apply((h) => `https://${h}:6443`);

    // ---- 5. Retrieve kubeconfig from the init server ----
    //
    // Wait for k3s to finish bootstrapping (up to 10 minutes), then SSH in and
    // read the kubeconfig.  The file hard-codes 127.0.0.1 — we rewrite it to
    // the init server's reachable IP so external tools can use it directly.
    const kubeconfigCmd = new command.remote.Command(
      $`get-kubeconfig`,
      {
        connection: {
          host: initSshHost,
          user: "ubuntu",
          privateKey: initSshKey.privateKeyOpenssh,
        },
        create: pulumi.interpolate`
          set -e
          for i in $(seq 1 120); do
            [ -f /etc/rancher/k3s/k3s.yaml ] && break
            sleep 5
          done
          sudo cat /etc/rancher/k3s/k3s.yaml \
            | sed 's|server: https://127.0.0.1:6443|server: https://${initSshHost}:6443|'
        `,
      },
      { dependsOn: [initInstance] },
    );

    // ---- 6. Provision remaining server nodes (HA) ----
    //
    // Each additional server joins using --server <init-server-url>.
    // They depend on the init server instance being created (but don't need the
    // kubeconfig — that's only needed for k8s resource allocation).

    const additionalServerResults = additionalServerEntries.map(
      ([nodeName, nodeConfig]) =>
        provisionNode(nodeName, nodeConfig, "server", initSshHost, nodeLabelsMap[nodeName], nodeTaintsMap[nodeName]),
    );

    // ---- 7. Provision agent nodes ----
    //
    // Agents join the cluster via --server <init-server-url>.  They also depend
    // on the init server but can be provisioned in parallel with additional servers.

    const agentResults = agentEntries.map(([nodeName, nodeConfig]) =>
      provisionNode(nodeName, nodeConfig, "agent", initSshHost, nodeLabelsMap[nodeName], nodeTaintsMap[nodeName]),
    );

    // ---- 7a. Provision autoscaled machine groups (MIGs) ----
    //
    // Autoscaled groups use InstanceTemplate + InstanceGroupManager + Autoscaler
    // instead of individual instances. New VMs auto-join k3s via cloud-init.

    const autoscaledGroupResults: { groupName: string; igm: gcp.compute.InstanceGroupManager }[] = [];

    if (autoscaledGroups.length > 0) {
      for (const [groupName, groupConfig, autoscalingConfig] of autoscaledGroups) {
        // Generate one SSH key per managed group
        const groupSshKey = new tls.PrivateKey($`ssh-key-mig-${groupName}`, {
          algorithm: "ED25519",
        });

        // Resolve boot disk image for this group
        const groupBootImage = gcp.compute.getImageOutput({
          family: groupConfig.imageFamily,
          project: groupConfig.imageProject,
        }, gcpOpts);

        const groupNodeLabels = [`sdlc.works/machine-group=${groupName}`];

        // Build cloud-init for agent nodes in this group
        const groupCloudInit = pulumi
          .all([
            pulumi.output(k3sVersion),
            pulumi.output(k3sChannel),
            clusterToken,
            groupSshKey.publicKeyOpenssh,
            initSshHost,
          ])
          .apply(([version, channel, token, sshPubKey, joinIp]) => {
            return buildK3sCloudInit({
              version,
              channel,
              nodeRole: "agent",
              isHa: false,
              installFlags: k3sInstallFlags as string[],
              sans: [],
              token,
              joinUrl: `https://${joinIp}:6443`,
              sshPublicKey: sshPubKey,
              nodeLabels: groupNodeLabels,
            });
          });

        // Merge cluster-level and group-level network tags
        const groupTags = pulumi
          .output(clusterNetworkTags)
          .apply((tags) => Array.from(new Set(tags)));

        // Access config for external IP
        const templateAccessConfigs = groupConfig.assignExternalIp
          ? [{ networkTier: "PREMIUM" as const }]
          : [];

        // Create InstanceTemplate
        const instanceTemplate = new gcp.compute.InstanceTemplate(
          $`template-${groupName}`,
          {
            machineType: groupConfig.machineType,
            disks: [
              {
                boot: true,
                autoDelete: true,
                sourceImage: groupBootImage.selfLink,
                diskSizeGb: groupConfig.bootDiskSizeGb,
                diskType: groupConfig.bootDiskType,
              },
            ],
            networkInterfaces: [
              {
                network: networkId || "default",
                ...(subnetId ? { subnetwork: subnetId } : {}),
                accessConfigs: templateAccessConfigs,
              },
            ],
            metadata: { "user-data": groupCloudInit },
            scheduling: {
              preemptible: groupConfig.preemptible,
              automaticRestart: !groupConfig.preemptible,
              onHostMaintenance: groupConfig.preemptible ? "TERMINATE" : "MIGRATE",
            },
            shieldedInstanceConfig: {
              enableSecureBoot: groupConfig.enableSecureBoot,
              enableVtpm: groupConfig.enableVtpm,
              enableIntegrityMonitoring: groupConfig.enableIntegrityMonitoring,
            },
            labels: { "sdlc-machine-group": groupName },
            tags: groupTags,
            canIpForward: true,
            description: `k3s agent node (machine group: ${groupName}) managed by sdlc.works`,
          },
          gcpOpts,
        );

        // Create InstanceGroupManager
        const igm = new gcp.compute.InstanceGroupManager(
          $`igm-${groupName}`,
          {
            zone: groupConfig.zone,
            baseInstanceName: $`${groupName}`,
            versions: [{
              instanceTemplate: instanceTemplate.selfLinkUnique,
              name: "primary",
            }],
            targetSize: autoscalingConfig.minNodes,
          },
          { ...gcpOpts, dependsOn: [instanceTemplate] },
        );

        // Create Autoscaler
        new gcp.compute.Autoscaler($`autoscaler-${groupName}`, {
          zone: groupConfig.zone,
          target: igm.selfLink,
          autoscalingPolicy: {
            minReplicas: autoscalingConfig.minNodes,
            maxReplicas: autoscalingConfig.maxNodes,
            cooldownPeriod: autoscalingConfig.cooldownPeriodSec,
            cpuUtilization: {
              target: autoscalingConfig.targetCpuUtilization,
            },
          },
          gcpOpts,
        });

        autoscaledGroupResults.push({ groupName, igm });
      }
    }

    // ---- 7.5. Create firewall rules ----
    //
    // Always create a firewall rule for the k8s API server (6443) so that
    // Pulumi can reach the cluster to manage k8s resources.
    // When Traefik is enabled, also allow HTTP/HTTPS (80/443).
    //
    // When networkId is provided, firewall rules use targetTags for scoping.
    // When using the default network, rules apply to all instances in the project.

    const firewallNetwork = networkId || "default";

    const apiPorts = ["6443"];
    const ingressPorts = !disableTraefik ? ["80", "443", ...apiPorts] : apiPorts;

    new gcp.compute.Firewall($`allow-k3s-ingress`, {
      network: firewallNetwork,
      direction: "INGRESS",
      allows: [{ protocol: "tcp", ports: ingressPorts }],
      sourceRanges: ["0.0.0.0/0"],
      description:
        "Allow external traffic to k3s nodes (API server + Traefik ingress) (managed by sdlc.works)",
    }, gcpOpts);

    // ---- 8. Populate state ----

    state.kubeconfig = kubeconfigCmd.stdout;
    state.apiServerUrl = apiServerUrl;

    // Store per-node SSH keys and IPs.
    if (!state.sshKeys || typeof state.sshKeys !== "object") {
      (state as any).sshKeys = {};
    }
    if (!state.nodeIps || typeof state.nodeIps !== "object") {
      (state as any).nodeIps = {};
    }

    (state.sshKeys as Record<string, any>)[initServerName] =
      initSshKey.privateKeyOpenssh;
    (state.nodeIps as Record<string, any>)[initServerName] = {
      internalIp: initInternalIp,
      externalIp: initExternalIp,
    };

    additionalServerEntries.forEach(([nodeName], idx) => {
      const { sshKey, internalIp, externalIp } = additionalServerResults[idx];
      (state.sshKeys as Record<string, any>)[nodeName] =
        sshKey.privateKeyOpenssh;
      (state.nodeIps as Record<string, any>)[nodeName] = {
        internalIp,
        externalIp,
      };
    });

    agentEntries.forEach(([nodeName], idx) => {
      const { sshKey, internalIp, externalIp } = agentResults[idx];
      (state.sshKeys as Record<string, any>)[nodeName] =
        sshKey.privateKeyOpenssh;
      (state.nodeIps as Record<string, any>)[nodeName] = {
        internalIp,
        externalIp,
      };
    });

    state.defaultResourceLimits =
      defaultResourceLimits as typeof state.defaultResourceLimits;
    state.defaultResourceRequests =
      defaultResourceRequests as typeof state.defaultResourceRequests;
    state.defaultNamespaceQuota =
      defaultNamespaceQuota as typeof state.defaultNamespaceQuota;
    (state as any).useCnpgOperator = Object.keys(inputs.postgresClusterConfig).length > 0;

    // ---- 8b. Create the default "components" Namespace ----
    //
    // The shared namespace is created once here so that allocateWithPulumiCtx
    // (called per app component) does not need to create it per-component.
    const defaultK8sProvider = new k8s.Provider($`k8s-default`, {
      kubeconfig: state.kubeconfig as pulumi.Output<string>,
      enableServerSideApply: false,
    });
    const defaultNamespace = new k8s.core.v1.Namespace(
      $`ns-components`,
      { metadata: { name: "components" } },
      { provider: defaultK8sProvider },
    );
    state.defaultK8sProvider = defaultK8sProvider;
    state.defaultNamespace = defaultNamespace;

    // ---- 8c. Deploy monitoring (Grafana — hosted or self-hosted) ----

    if (inputs.monitoring.enabled) {
      if (inputs.monitoring.mode === "hosted" && inputs.monitoring.grafanaCloud) {
        // Hosted: Deploy Grafana Alloy agent → ships metrics/logs to Grafana Cloud.
        // No Prometheus, Grafana, or storage on the cluster — just a lightweight DaemonSet.
        const gc = inputs.monitoring.grafanaCloud;

        const alloyConfig = `
logging {
  level  = "info"
  format = "logfmt"
}

// ---- Kubernetes discovery ----

discovery.kubernetes "pods" {
  role = "pod"
}

discovery.kubernetes "nodes" {
  role = "node"
}

discovery.kubernetes "cadvisor" {
  role = "node"
}

// ---- Metrics: kubelet ----

discovery.relabel "kubelet" {
  targets = discovery.kubernetes.nodes.targets

  rule {
    target_label = "__address__"
    replacement  = "kubernetes.default.svc:443"
  }
  rule {
    source_labels = ["__meta_kubernetes_node_name"]
    regex         = "(.+)"
    target_label  = "__metrics_path__"
    replacement   = "/api/v1/nodes/$1/proxy/metrics"
  }
}

prometheus.scrape "kubelet" {
  targets         = discovery.relabel.kubelet.output
  scheme          = "https"
  scrape_interval = "60s"
  bearer_token_file = "/var/run/secrets/kubernetes.io/serviceaccount/token"
  tls_config {
    ca_file              = "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt"
    insecure_skip_verify = true
  }
  forward_to = [prometheus.remote_write.grafana_cloud.receiver]
}

// ---- Metrics: cAdvisor (container metrics) ----

discovery.relabel "cadvisor" {
  targets = discovery.kubernetes.cadvisor.targets

  rule {
    target_label = "__address__"
    replacement  = "kubernetes.default.svc:443"
  }
  rule {
    source_labels = ["__meta_kubernetes_node_name"]
    regex         = "(.+)"
    target_label  = "__metrics_path__"
    replacement   = "/api/v1/nodes/$1/proxy/metrics/cadvisor"
  }
}

prometheus.scrape "cadvisor" {
  targets         = discovery.relabel.cadvisor.output
  scheme          = "https"
  scrape_interval = "60s"
  bearer_token_file = "/var/run/secrets/kubernetes.io/serviceaccount/token"
  tls_config {
    ca_file              = "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt"
    insecure_skip_verify = true
  }
  forward_to = [prometheus.remote_write.grafana_cloud.receiver]
}

// ---- Metrics: pod annotations (prometheus.io/scrape) ----

discovery.relabel "pod_metrics" {
  targets = discovery.kubernetes.pods.targets

  rule {
    source_labels = ["__meta_kubernetes_pod_annotation_prometheus_io_scrape"]
    regex         = "true"
    action        = "keep"
  }
  rule {
    source_labels = ["__meta_kubernetes_pod_annotation_prometheus_io_path"]
    target_label  = "__metrics_path__"
  }
  rule {
    source_labels = ["__address__", "__meta_kubernetes_pod_annotation_prometheus_io_port"]
    regex         = "(.+?)(?::\\\\d+)?;(\\\\d+)"
    target_label  = "__address__"
    replacement   = "$1:$2"
  }
  rule {
    source_labels = ["__meta_kubernetes_namespace"]
    target_label  = "namespace"
  }
  rule {
    source_labels = ["__meta_kubernetes_pod_name"]
    target_label  = "pod"
  }
}

prometheus.scrape "pods" {
  targets         = discovery.relabel.pod_metrics.output
  scrape_interval = "60s"
  forward_to      = [prometheus.remote_write.grafana_cloud.receiver]
}

// ---- Remote write: Grafana Cloud Prometheus ----

prometheus.remote_write "grafana_cloud" {
  endpoint {
    url = env("GRAFANA_CLOUD_PROM_ENDPOINT")
    basic_auth {
      username = env("GRAFANA_CLOUD_INSTANCE_ID")
      password = env("GRAFANA_CLOUD_API_KEY")
    }
  }
}

// ---- Logs: collect from pods via Kubernetes API ----

discovery.relabel "pod_logs" {
  targets = discovery.kubernetes.pods.targets

  rule {
    source_labels = ["__meta_kubernetes_namespace"]
    target_label  = "namespace"
  }
  rule {
    source_labels = ["__meta_kubernetes_pod_name"]
    target_label  = "pod"
  }
  rule {
    source_labels = ["__meta_kubernetes_pod_container_name"]
    target_label  = "container"
  }
  rule {
    source_labels = ["__meta_kubernetes_pod_node_name"]
    target_label  = "node"
  }
}

loki.source.kubernetes "pods" {
  targets    = discovery.relabel.pod_logs.output
  forward_to = [loki.write.grafana_cloud.receiver]
}

// ---- Logs: ship to Grafana Cloud Loki ----

loki.write "grafana_cloud" {
  endpoint {
    url = env("GRAFANA_CLOUD_LOKI_ENDPOINT")
    basic_auth {
      username = env("GRAFANA_CLOUD_LOKI_USER_ID")
      password = env("GRAFANA_CLOUD_API_KEY")
    }
  }
}
`;

        new k8s.helm.v3.Release(
          $`grafana-alloy`,
          {
            chart: "alloy",
            name: "alloy",
            namespace: "monitoring",
            createNamespace: true,
            repositoryOpts: {
              repo: "https://grafana.github.io/helm-charts",
            },
            values: {
              alloy: {
                configMap: {
                  content: alloyConfig,
                },
                extraEnv: [
                  { name: "GRAFANA_CLOUD_API_KEY", value: gc.apiKey },
                  { name: "GRAFANA_CLOUD_INSTANCE_ID", value: gc.instanceId },
                  { name: "GRAFANA_CLOUD_LOKI_USER_ID", value: gc.lokiUserId },
                  { name: "GRAFANA_CLOUD_PROM_ENDPOINT", value: gc.prometheusEndpoint },
                  { name: "GRAFANA_CLOUD_LOKI_ENDPOINT", value: gc.lokiEndpoint },
                ],
              },
              // Alloy needs cluster-level RBAC to scrape kubelet/cadvisor and read pod logs
              serviceAccount: {
                create: true,
              },
              rbac: {
                create: true,
              },
            },
          },
          { provider: defaultK8sProvider },
        );
      } else {
        // Self-hosted: Deploy kube-prometheus-stack (Grafana + Prometheus + node-exporter).
        // Full monitoring stack runs on the cluster (~500MB RAM).
        new k8s.helm.v3.Release(
          $`monitoring`,
          {
            chart: "kube-prometheus-stack",
            name: "monitoring",
            namespace: "monitoring",
            createNamespace: true,
            timeout: 600,
            repositoryOpts: {
              repo: "https://prometheus-community.github.io/helm-charts",
            },
            values: {
              grafana: {
                adminPassword: inputs.monitoring.grafanaAdminPassword,
                service: {
                  type: "NodePort",
                  nodePort: inputs.monitoring.grafanaNodePort,
                },
              },
              prometheus: {
                prometheusSpec: {
                  retention: `${inputs.monitoring.retentionDays}d`,
                  resources: {
                    requests: { cpu: "100m", memory: "256Mi" },
                    limits: { cpu: "500m", memory: "512Mi" },
                  },
                },
              },
              alertmanager: { enabled: false },
            },
          },
          { provider: defaultK8sProvider },
        );
      }
    }

    // ---- 8d. Deploy CloudNativePG operator + clusters ----
    //
    // Auto-install when postgresClusterConfig has entries.

    const hasPostgresClusters = Object.keys(inputs.postgresClusterConfig).length > 0;
    let cnpgOperatorRelease: k8s.helm.v3.Release | undefined;

    if (hasPostgresClusters) {
      cnpgOperatorRelease = new k8s.helm.v3.Release(
        $`cnpg-operator`,
        {
          chart: "cloudnative-pg",
          namespace: "cnpg-system",
          createNamespace: true,
          repositoryOpts: {
            repo: "https://cloudnative-pg.github.io/charts",
          },
          values: {},
        },
        { provider: defaultK8sProvider },
      );

      // Create named postgres clusters from config
      for (const [clusterName, pgConfig] of Object.entries(inputs.postgresClusterConfig)) {
        const pgNamespace = "components";
        const pgOpts = {
          provider: defaultK8sProvider,
          dependsOn: [cnpgOperatorRelease, defaultNamespace],
        };

        // Credentials secret
        new k8s.core.v1.Secret(
          $`cnpg-creds-${clusterName}`,
          {
            metadata: { name: `${clusterName}-credentials`, namespace: pgNamespace },
            type: "kubernetes.io/basic-auth",
            stringData: {
              username: pgConfig.dbUser,
              password: pgConfig.dbPassword,
            },
          },
          pgOpts,
        );

        // CloudNativePG Cluster CRD
        new k8s.apiextensions.CustomResource(
          $`cnpg-${clusterName}`,
          {
            apiVersion: "postgresql.cnpg.io/v1",
            kind: "Cluster",
            metadata: { name: clusterName, namespace: pgNamespace },
            spec: {
              instances: pgConfig.instances,
              primaryUpdateStrategy: "unsupervised",
              storage: {
                size: pgConfig.storageSize,
                storageClass: pgConfig.storageClass,
              },
              bootstrap: {
                initdb: {
                  database: pgConfig.dbName,
                  owner: pgConfig.dbUser,
                  secret: { name: `${clusterName}-credentials` },
                },
              },
              postgresql: {
                parameters: pgConfig.parameters ?? {
                  shared_buffers: "128MB",
                  max_connections: "100",
                },
              },
            },
          },
          pgOpts,
        );
      }
    }

    // Store for allocateWithPulumiCtx — kept for backward compat
    (state as any).cnpgOperatorRelease = cnpgOperatorRelease;
    (state as any).postgresClusterConfig = inputs.postgresClusterConfig;

    // ---- 9. Build output node map ----
    //
    // The outputSchema declares `nodes` as a ZodRecord, which maps to
    // `Output<Record<string, ...>>` in the framework's InferOutputType.
    // We collect all per-node Pulumi Outputs and resolve them into a single
    // Output<Record> using pulumi.all().

    type NodeOutputEntry = {
      instanceId: pulumi.Output<string>;
      instanceSelfLink: pulumi.Output<string>;
      instanceName: pulumi.Output<string>;
      zone: pulumi.Output<string>;
      internalIp: pulumi.Output<string>;
      externalIp: pulumi.Output<string | undefined>;
    };

    const allNodeResults: Array<[string, NodeOutputEntry]> = [
      [
        initServerName,
        {
          instanceId: initInstance.instanceId,
          instanceSelfLink: initInstance.selfLink,
          instanceName: initInstance.name,
          zone: initInstance.zone,
          internalIp: initInternalIp,
          externalIp: initExternalIp,
        },
      ],
      ...additionalServerEntries.map(([nodeName], idx) => {
        const r = additionalServerResults[idx];
        return [
          nodeName,
          {
            instanceId: r.instance.instanceId,
            instanceSelfLink: r.instance.selfLink,
            instanceName: r.instance.name,
            zone: r.instance.zone,
            internalIp: r.internalIp,
            externalIp: r.externalIp,
          },
        ] as [string, NodeOutputEntry];
      }),
      ...agentEntries.map(([nodeName], idx) => {
        const r = agentResults[idx];
        return [
          nodeName,
          {
            instanceId: r.instance.instanceId,
            instanceSelfLink: r.instance.selfLink,
            instanceName: r.instance.name,
            zone: r.instance.zone,
            internalIp: r.internalIp,
            externalIp: r.externalIp,
          },
        ] as [string, NodeOutputEntry];
      }),
    ];

    // Resolve all per-node Output values into a single Output<Record<...>>.
    const nodeOutputEntries = allNodeResults.map(([nodeName, entry]) =>
      pulumi
        .all([
          entry.instanceId,
          entry.instanceSelfLink,
          entry.instanceName,
          entry.zone,
          entry.internalIp,
          entry.externalIp,
        ])
        .apply(
          ([
            instanceId,
            instanceSelfLink,
            instanceName,
            zone,
            internalIp,
            externalIp,
          ]) => ({
            nodeName,
            instanceId,
            instanceSelfLink,
            instanceName,
            zone,
            internalIp,
            externalIp,
          }),
        ),
    );

    const nodesOutput = pulumi.all(nodeOutputEntries).apply((entries) =>
      Object.fromEntries(
        entries.map((e) => [
          e.nodeName,
          {
            instanceId: e.instanceId,
            instanceSelfLink: e.instanceSelfLink,
            instanceName: e.instanceName,
            zone: e.zone,
            internalIp: e.internalIp,
            externalIp: e.externalIp,
          },
        ]),
      ),
    );

    return {
      apiServerUrl,
      nodes: nodesOutput,
    };
  },

  // ---- allocateWithPulumiCtx ----
  //
  // Called once (within Pulumi context) per app component targeted at this
  // infra entry.  Creates a Namespace and the appropriate Kubernetes workload
  // for the app component based on its deploymentConfig.workloadType.
  //
  // This uses the cluster-level kubeconfig stored in state, so it works
  // identically regardless of how many nodes are in the cluster.

  allocateWithPulumiCtx: async ({
    name,
    appComponentType,
    deploymentConfig,
    state,
    $,
    envStore,
    buildArtifact,
    getCredentials,
  }) => {
    const provider = new k8s.Provider($`k8s-provider-${name}`, {
      kubeconfig: state.kubeconfig as string,
    });

    const opts = { provider };

    if (!state.allocations || typeof state.allocations !== "object") {
      (state as any).allocations = {};
    }

    // ---- Image pull secret setup ----
    const registryHost = (buildArtifact?.artifact as any)?.uri?.split("/")[0] as
      | string
      | undefined;
    const imagePullSecretName = `ar-pull-${name}`;
    const imagePullSecrets = registryHost
      ? [{ name: imagePullSecretName }]
      : undefined;

    // Ensure all resources are created AFTER the components namespace exists.
    // Without this, Pulumi creates them in parallel and they fail with
    // "namespaces components not found" until the namespace is ready.
    const defaultNs = state.defaultNamespace as k8s.core.v1.Namespace | undefined;
    const baseOpts = defaultNs
      ? { provider, dependsOn: [defaultNs] }
      : opts;

    const createImagePullSecret = (namespaceName: string): k8s.core.v1.Secret | undefined => {
      if (!registryHost) return undefined;
      const creds = getCredentials();
      return new k8s.core.v1.Secret(
        $`ar-pull-${name}`,
        {
          metadata: { name: imagePullSecretName, namespace: namespaceName },
          type: "kubernetes.io/dockerconfigjson",
          stringData: {
            ".dockerconfigjson": JSON.stringify({
              auths: {
                [registryHost]: {
                  username: "_json_key",
                  password: creds.GCP_SERVICE_ACCOUNT_KEY,
                },
              },
            }),
          },
        },
        baseOpts,
      );
    };

    // ---- Postgres app component type ----
    if (appComponentType === "postgres") {
      // Postgres clusters are now created in the infra provisioning phase (8d)
      // from postgresClusterConfig. This allocation just records the mapping
      // so the connection handler can resolve the URI.
      const pgDeployConfig = PostgresDeployConfigSchema.parse(deploymentConfig);
      const clusterName = pgDeployConfig.postgresCluster;
      const namespaceName = pgDeployConfig.namespace;

      // Look up cluster config
      const pgClusterConfigs = (state as any).postgresClusterConfig as Record<string, z.infer<typeof PostgresClusterConfigSchema>> | undefined;
      const clusterConfig = pgClusterConfigs?.[clusterName];
      if (!clusterConfig) {
        throw new Error(
          `Postgres cluster "${clusterName}" referenced by component "${name}" not found in postgresClusterConfig`,
        );
      }

      type AllocEntry = {
        appComponentType: string;
        workloadType: string;
        namespace: any;
        servicePort?: number;
        dbName?: string;
        dbUser?: string;
        dbPassword?: string;
        postgresClusterName?: string;
      };
      (state.allocations as Record<string, AllocEntry>)[name] = {
        appComponentType,
        workloadType: "stateful-set",
        namespace: namespaceName,
        servicePort: 5432,
        dbName: clusterConfig.dbName,
        dbUser: clusterConfig.dbUser,
        dbPassword: clusterConfig.dbPassword,
        postgresClusterName: clusterName,
      };

      return;
    }

    // ---- tcp-service / http-service app component types ----
    const workloadConfig = WorkloadConfigSchema.parse(deploymentConfig);

    const namespaceName = workloadConfig.namespace;

    // Only create namespace if it's not the default "components" (created in pulumi)
    if (namespaceName !== "components") {
      new k8s.core.v1.Namespace(
        $`ns-${name}`,
        { metadata: { name: namespaceName } },
        opts,
      );
    }

    const effectiveQuota =
      workloadConfig.namespaceQuota ??
      (state.defaultNamespaceQuota as
        | { maxCpu: string; maxMemory: string; maxPods: number }
        | undefined);

    if (effectiveQuota) {
      new k8s.core.v1.ResourceQuota(
        $`quota-${name}`,
        {
          metadata: {
            name: "default-quota",
            namespace: namespaceName,
          },
          spec: {
            hard: {
              "requests.cpu": effectiveQuota.maxCpu,
              "requests.memory": effectiveQuota.maxMemory,
              "limits.cpu": effectiveQuota.maxCpu,
              "limits.memory": effectiveQuota.maxMemory,
              pods: String(effectiveQuota.maxPods),
            },
          },
        },
        opts,
      );
    }

    const effectiveLimits =
      workloadConfig.resourceLimits ??
      (state.defaultResourceLimits as
        | { cpu: string; memory: string }
        | undefined);
    const effectiveRequests =
      workloadConfig.resourceRequests ??
      (state.defaultResourceRequests as
        | { cpu: string; memory: string }
        | undefined);

    const componentEnvVars = Object.entries(
      (envStore[name] ?? {}) as Record<string, string>,
    ).map(([key, value]) => ({ name: key, value }));

    const containerImage = buildArtifact?.artifact.uri ?? PLACEHOLDER_IMAGE;

    const pullSecret = createImagePullSecret(namespaceName);

    // Workload opts: depend on namespace + pull secret so pods don't start
    // before credentials exist (prevents transient 403 on image pull).
    const workloadDeps: pulumi.Resource[] = [];
    if (defaultNs) workloadDeps.push(defaultNs);
    if (pullSecret) workloadDeps.push(pullSecret);
    const workloadOpts = { provider, dependsOn: workloadDeps };

    switch (workloadConfig.workloadType) {
      case "deployment":
        buildDeployment({
          name,
          namespaceName,
          config: workloadConfig,
          containerImage,
          envVars: componentEnvVars,
          effectiveLimits,
          effectiveRequests,
          imagePullSecrets,
          $,
          opts: workloadOpts,
        });
        break;

      case "stateful-set":
        buildStatefulSet({
          name,
          namespaceName,
          config: workloadConfig,
          containerImage,
          envVars: componentEnvVars,
          effectiveLimits,
          effectiveRequests,
          imagePullSecrets,
          $,
          opts: workloadOpts,
        });
        break;

      case "cron-job":
        buildCronJob({
          name,
          namespaceName,
          config: workloadConfig,
          containerImage,
          envVars: componentEnvVars,
          effectiveLimits,
          effectiveRequests,
          imagePullSecrets,
          $,
          opts: workloadOpts,
        });
        break;

      case "job":
        buildJob({
          name,
          namespaceName,
          config: workloadConfig,
          containerImage,
          envVars: componentEnvVars,
          effectiveLimits,
          effectiveRequests,
          imagePullSecrets,
          $,
          opts: workloadOpts,
        });
        break;

      case "daemon-set":
        buildDaemonSet({
          name,
          namespaceName,
          config: workloadConfig,
          containerImage,
          envVars: componentEnvVars,
          effectiveLimits,
          effectiveRequests,
          imagePullSecrets,
          $,
          opts: workloadOpts,
        });
        break;
    }

    // ---- Ingress (decoupled from workload builders) ----
    //
    // Created independently so that its lifecycle does not depend on any
    // workload Pulumi resource.  The backend service name uses the plain
    // component name string — the k8s Service is always named after the
    // component, so this is correct and avoids an implicit Pulumi dependency
    // on the Deployment resource that previously caused silent creation
    // failures.
    if (workloadConfig.workloadType === "deployment") {
      const deployConfig = workloadConfig as DeploymentConfig;
      if (deployConfig.ingress) {
        new k8s.networking.v1.Ingress(
          $`ingress-${name}`,
          {
            metadata: {
              name,
              namespace: namespaceName,
              annotations: deployConfig.ingress.annotations,
            },
            spec: {
              tls: deployConfig.ingress.tls?.map((t) => ({
                hosts: t.hosts,
                secretName: t.secretName,
              })),
              rules: deployConfig.ingress.rules.map((rule) => ({
                host: rule.host,
                http: {
                  paths: [
                    {
                      path: rule.path,
                      pathType: rule.pathType,
                      backend: {
                        service: {
                          name,
                          port: {
                            number: rule.servicePort ?? deployConfig.servicePort,
                          },
                        },
                      },
                    },
                  ],
                },
              })),
            },
          },
          workloadOpts,
        );
      }
    }

    // Derive the port exposed by the k8s Service so the connect handler can
    // build cluster-internal URIs without re-parsing the deployment config.
    const allocServicePort: number | undefined =
      workloadConfig.workloadType === "deployment"
        ? (workloadConfig as { servicePort: number }).servicePort
        : workloadConfig.workloadType === "stateful-set"
          ? (workloadConfig as { containerPort: number }).containerPort
          : undefined;

    type AllocEntry = {
      appComponentType: string;
      workloadType: string;
      namespace: any;
      servicePort?: number;
    };
    (state.allocations as Record<string, AllocEntry>)[name] = {
      appComponentType,
      workloadType: workloadConfig.workloadType,
      namespace: namespaceName,
      servicePort: allocServicePort,
    };
  },

  // ---- upsertArtifacts ----

  upsertArtifacts: async ({ buildArtifacts, state, envStore }) => {
    const componentEntries = Object.entries(buildArtifacts);
    if (componentEntries.length === 0) {
      console.error("No artifacts to deploy");
      return;
    }

    const kubeconfig = yaml.load(state.kubeconfig as string) as KubeconfigShape;
    const clusterEntry = kubeconfig.clusters[0]?.cluster;
    const userEntry = kubeconfig.users[0]?.user;

    if (!clusterEntry || !userEntry) {
      throw new Error(
        "Malformed kubeconfig in state: missing clusters or users",
      );
    }

    const k8sServer = clusterEntry.server;
    const tlsOpts: K8sTlsOpts = {
      ca: Buffer.from(clusterEntry["certificate-authority-data"], "base64"),
      cert: Buffer.from(userEntry["client-certificate-data"], "base64"),
      key: Buffer.from(userEntry["client-key-data"], "base64"),
    };

    const allocations = (state.allocations ?? {}) as Record<
      string,
      { workloadType: string; namespace: string; appComponentType?: string }
    >;

    // App component types that are managed by operators and cannot be patched directly.
    const operatorManagedTypes = new Set(["postgres"]);

    for (const [componentName, artifactInfo] of componentEntries) {
      const allocation = allocations[componentName];
      if (!allocation) {
        console.error(
          `Skipping ${componentName}: no allocation metadata found in state — was this component allocated via allocateWithPulumiCtx?`,
        );
        continue;
      }

      const { workloadType, namespace, appComponentType } = allocation;
      const imageUri = artifactInfo.artifact.uri;

      if (appComponentType && operatorManagedTypes.has(appComponentType)) {
        console.error(
          `Skipping ${componentName}: ${appComponentType} components are operator-managed and cannot be hot-deployed.`,
        );
        continue;
      }

      if (workloadType === "job") {
        console.error(
          `Skipping ${componentName}: Job workloads are one-shot and cannot be hot-deployed. Run pulumi up to recreate with a new image.`,
        );
        continue;
      }

      console.error(
        `Deploying ${imageUri} → ${workloadType}/${componentName} in namespace "${namespace}"`,
      );

      const envVars = Object.entries(envStore[componentName] ?? {}).map(
        ([k, v]) => ({ name: k, value: v }),
      );

      const apiPath = k8sApiPath(workloadType, namespace, componentName);
      const patchBody = k8sPatchBody(
        workloadType,
        componentName,
        imageUri,
        envVars,
      );

      const patchRes = await k8sFetch(k8sServer, `${apiPath}?fieldManager=sdlc-deploy`, tlsOpts, {
        method: "PATCH",
        headers: { "Content-Type": "application/strategic-merge-patch+json" },
        body: JSON.stringify(patchBody),
      });

      if (!patchRes.ok) {
        const errText = await patchRes.text();
        throw new Error(
          `Failed to patch ${workloadType} "${componentName}": ${patchRes.status} ${errText}`,
        );
      }

      if (workloadType !== "cron-job") {
        await waitForRollout(k8sServer, apiPath, tlsOpts, componentName);
      }

      console.error(`✓ Successfully deployed ${imageUri} to ${componentName}`);
    }
  },

  connect: (({ state, selfComponentName }: any) => [
    // ---- K3sInternalCI handler ----
    //
    // Used when both the requester and the dependency are hosted on this same
    // k3s cluster.  Returns the k8s ClusterDNS URI so that pods communicate
    // via the cluster-internal Service without leaving the node network.
    //
    // The orchestrator calls connect() with selfComponentName = the dependency
    // app component being connected TO.  We look that component's allocation up
    // in state.allocations (written by allocateWithPulumiCtx) to retrieve the
    // namespace and service port.
    connectionHandler({
      interface: K3sInternalCI,
      handler: async (_ctx: any) => {
        type Alloc = {
          appComponentType: string;
          namespace: string;
          servicePort?: number;
          dbName?: string;
          dbUser?: string;
          dbPassword?: string;
          postgresClusterName?: string;
        };
        const allocations = (state.allocations ?? {}) as Record<string, Alloc>;
        const alloc = allocations[selfComponentName];
        if (!alloc) {
          throw new Error(
            `k3s: no allocation found for component '${selfComponentName}'. ` +
              `Ensure allocateWithPulumiCtx has run for this component before connections are resolved.`,
          );
        }
        const serviceName =
          alloc.appComponentType === "postgres" && alloc.postgresClusterName
            ? `${alloc.postgresClusterName}-rw`
            : selfComponentName;
        const clusterHost = `${serviceName}.${alloc.namespace}.svc.cluster.local`;
        const portSuffix =
          alloc.servicePort != null ? `:${alloc.servicePort}` : "";

        switch (alloc.appComponentType) {
          case "tcp-service":
            return {
              uri: pulumi.output(`${clusterHost}${portSuffix}`),
              metadata: {
                appComponentType: "tcp-service",
                host: clusterHost,
                port: alloc.servicePort,
                mode: "plain" as const,
              },
            };
          case "http-service":
            return {
              uri: pulumi.output(`${clusterHost}${portSuffix}`),
              metadata: {
                appComponentType: "http-service",
                host: clusterHost,
                port: alloc.servicePort,
                protocol: "http" as const,
              },
            };
          case "postgres":
            return {
              uri: pulumi.output(
                `postgresql://${alloc.dbUser}:${alloc.dbPassword}@${clusterHost}:${alloc.servicePort ?? 5432}/${alloc.dbName}?sslmode=disable`,
              ),
              metadata: {
                appComponentType: "postgres",
                host: clusterHost,
                port: alloc.servicePort ?? 5432,
                dbName: alloc.dbName,
                dbUser: alloc.dbUser,
                dbPassword: alloc.dbPassword,
              },
            };
          default:
            throw new Error(
              `k3s: unknown appComponentType '${alloc.appComponentType}' for component '${selfComponentName}'`,
            );
        }
      },
    }),
    // ---- PublicCI handler ----
    //
    // Used by URL registers (connectionType = "@anonymous") and cross-infra
    // connections where the connecting component is NOT on this k3s cluster.
    // Returns the init-server external IP as the base URI.  Traefik (which
    // k3s ships with) handles hostname/path routing to the correct workload via
    // Ingress resources created during allocateWithPulumiCtx.
    connectionHandler({
      interface: PublicCI,
      handler: async (_ctx: any) => {
        const nodeIps = state.nodeIps as Record<
          string,
          { internalIp: string; externalIp?: string }
        >;
        const initServerEntry = Object.values(nodeIps)[0];
        const ip = initServerEntry?.externalIp;
        if (!ip) {
          throw new Error(
            "k3s: externalIp is not set on the init server node; ensure the node config assigns an external IP",
          );
        }

        type Alloc = {
          appComponentType: string;
          namespace: string;
          servicePort?: number;
          dbName?: string;
          dbUser?: string;
          dbPassword?: string;
          postgresClusterName?: string;
        };
        const allocations = (state.allocations ?? {}) as Record<string, Alloc>;
        const alloc = allocations[selfComponentName];
        if (!alloc) {
          throw new Error(
            `k3s: no allocation found for component '${selfComponentName}'. ` +
              `Ensure allocateWithPulumiCtx has run for this component before connections are resolved.`,
          );
        }

        const portSuffix =
          alloc.servicePort != null ? `:${alloc.servicePort}` : "";

        switch (alloc.appComponentType) {
          case "tcp-service":
            return {
              uri: pulumi.interpolate`${ip}${portSuffix}`,
              metadata: {
                appComponentType: "tcp-service",
                host: ip,
                port: alloc.servicePort,
                mode: "plain" as const,
              },
            };
          case "http-service":
            return {
              uri: pulumi.interpolate`http://${ip}${portSuffix}`,
              metadata: {
                appComponentType: "http-service",
                host: ip,
                port: alloc.servicePort,
                protocol: "http" as const,
              },
            };
          case "postgres":
            return {
              uri: pulumi.interpolate`postgresql://${alloc.dbUser}:${alloc.dbPassword}@${ip}:${alloc.servicePort ?? 5432}/${alloc.dbName}?sslmode=disable`,
              metadata: {
                appComponentType: "postgres",
                host: ip,
                port: alloc.servicePort ?? 5432,
                dbName: alloc.dbName,
                dbUser: alloc.dbUser,
                dbPassword: alloc.dbPassword,
              },
            };
          default:
            throw new Error(
              `k3s: unknown appComponentType '${alloc.appComponentType}' for component '${selfComponentName}'`,
            );
        }
      },
    }),
  ]) as any,
});

export default component;

// ---- Cloud-init Helper ----

type NodeRole = "init-server" | "server" | "agent";

interface K3sCloudInitOpts {
  version: string | undefined;
  channel: string;
  nodeRole: NodeRole;
  /** Whether the cluster has multiple server nodes (HA with embedded etcd). */
  isHa: boolean;
  // Combined list: network flags + disable flags + user install flags.
  installFlags: string[];
  sans: string[];
  token: string | undefined;
  /** URL of the init server for nodes that are joining an existing cluster. */
  joinUrl: string | undefined;
  sshPublicKey: string;
  /** When present, the GCP Cloud Controller Manager is deployed onto the node. */
  cloudController?: {
    /** GCE network tags on this node — forwarded as `node-tags` in gce.conf. */
    nodeTags: string[];
    /** Image tag for registry.k8s.io/cloud-provider-gcp/cloud-controller-manager. */
    imageTag: string;
  };
  /** K8s node labels applied via --node-label flags. */
  nodeLabels?: string[];
  /** K8s node taints applied via --node-taint flags. */
  nodeTaints?: string[];
}

/**
 * Builds a cloud-init (#cloud-config) script that:
 *
 *   1. Adds the provisioned SSH public key to the ubuntu user's authorized_keys.
 *   2. Writes k3s install-time environment variables to /etc/default/k3s-install.
 *   3. Runs the official k3s install script via curl | sh.
 *
 * Node role determines the k3s install mode:
 *   - "init-server": installs k3s server with --cluster-init (embedded etcd, HA)
 *                    or without it (single-server).
 *   - "server":      installs k3s server joining an existing cluster via K3S_URL.
 *   - "agent":       installs k3s agent joining via K3S_URL.
 */
function buildK3sCloudInit({
  version,
  channel,
  nodeRole,
  isHa,
  installFlags,
  sans,
  token,
  joinUrl,
  sshPublicKey,
  cloudController,
  nodeLabels,
  nodeTaints,
}: K3sCloudInitOpts): string {
  const envLines: string[] = [];

  if (version) {
    envLines.push(`INSTALL_K3S_VERSION="${version}"`);
  } else {
    envLines.push(`INSTALL_K3S_CHANNEL="${channel}"`);
  }

  if (token) {
    envLines.push(`K3S_TOKEN="${token}"`);
  }

  // Non-init nodes need to know which server to join.
  if (joinUrl && (nodeRole === "server" || nodeRole === "agent")) {
    envLines.push(`K3S_URL="${joinUrl}"`);
  }

  // When the GCP CCM is enabled on a server node, tell k3s not to run its own
  // cloud controller and to advertise external cloud-provider mode to kubelet.
  const ccmInstallFlags: string[] =
    cloudController && nodeRole !== "agent"
      ? ["--disable-cloud-controller", "--kubelet-arg=cloud-provider=external"]
      : [];

  // --cluster-init is required on the init server when there are additional
  // server nodes (HA mode).  It signals that this node should bootstrap a new
  // embedded etcd cluster rather than joining an existing one.
  //
  // When nodeRole is "server" (non-init), the node joins via K3S_URL + --server.
  const roleFlags: string[] =
    nodeRole === "init-server"
      ? isHa
        ? ["--cluster-init"]
        : []
      : nodeRole === "server"
        ? ["--server"]
        : [];

  const labelFlags = (nodeLabels ?? []).map((l) => `--node-label=${l}`);
  const taintFlags = (nodeTaints ?? []).map((t) => `--node-taint=${t}`);

  const allInstallFlags = [
    ...sans.map((san) => `--tls-san=${san}`),
    ...ccmInstallFlags,
    ...roleFlags,
    ...labelFlags,
    ...taintFlags,
    ...installFlags,
  ];

  if (allInstallFlags.length > 0) {
    envLines.push(`INSTALL_K3S_EXEC="${allInstallFlags.join(" ")}"`);
  }

  const envBlock = envLines.map((l) => `      ${l}`).join("\n");

  // CCM write_files entries are only added to server nodes.
  const ccmWriteFiles =
    cloudController && nodeRole !== "agent"
      ? buildCcmWriteFiles(cloudController.nodeTags, cloudController.imageTag)
      : "";

  // The k3s install script accepts "server" or "agent" as the positional argument.
  const k3sInstallMode = nodeRole === "agent" ? "agent" : "server";

  return `#cloud-config
users:
  - name: ubuntu
    sudo: ALL=(ALL) NOPASSWD:ALL
    ssh_authorized_keys:
      - ${sshPublicKey.trim()}
write_files:
  - path: /etc/default/k3s-install
    permissions: "0600"
    owner: root:root
    content: |
${envBlock}
${ccmWriteFiles}runcmd:
  - |
    set -e
    set -a
    . /etc/default/k3s-install
    set +a${nodeRole !== "agent" ? `
    EXTERNAL_IP=$(curl -s -H "Metadata-Flavor: Google" http://metadata.google.internal/computeMetadata/v1/instance/network-interfaces/0/access-configs/0/external-ip 2>/dev/null || true)
    if [ -n "$EXTERNAL_IP" ]; then
      INSTALL_K3S_EXEC="$INSTALL_K3S_EXEC --tls-san=$EXTERNAL_IP"
    fi` : ""}
    curl -fsSL https://get.k3s.io | sh -s - ${k3sInstallMode}
`;
}

/**
 * Builds the write_files YAML block for the two CCM-related files that must be
 * present before k3s starts:
 *
 *   - /etc/gce/gce.conf          — GCP CCM configuration
 *   - …/manifests/gcp-ccm.yaml   — CCM k8s manifests (auto-applied by k3s)
 */
function buildCcmWriteFiles(nodeTags: string[], imageTag: string): string {
  const gceConf = `[global]\nnode-tags = ${nodeTags.join(",")}\n`;

  const ccmManifest = buildGcpCcmManifest(imageTag)
    .split("\n")
    .map((l) => `      ${l}`)
    .join("\n");

  const gceConfIndented = gceConf
    .split("\n")
    .map((l) => `      ${l}`)
    .join("\n");

  return `  - path: /etc/gce/gce.conf
    permissions: "0600"
    owner: root:root
    content: |
${gceConfIndented}
  - path: /var/lib/rancher/k3s/server/manifests/gcp-ccm.yaml
    permissions: "0644"
    owner: root:root
    content: |
${ccmManifest}
`;
}

// ---- GCP CCM Manifest Builder ----

const CCM_IMAGE_REPO =
  "registry.k8s.io/cloud-provider-gcp/cloud-controller-manager";

/**
 * Returns a multi-document YAML string (joined with "---") containing all the
 * Kubernetes resources required to run the GCP Cloud Controller Manager.
 *
 * The manifest is written to the k3s auto-deploy directory by cloud-init so it
 * is applied automatically when the API server becomes ready.
 *
 * Resources created:
 *   - ServiceAccount           cloud-controller-manager / kube-system
 *   - ClusterRole              system:cloud-controller-manager
 *   - ClusterRoleBinding       system:cloud-controller-manager
 *   - Deployment               cloud-controller-manager / kube-system
 */
function buildGcpCcmManifest(imageTag: string): string {
  const serviceAccount = {
    apiVersion: "v1",
    kind: "ServiceAccount",
    metadata: {
      name: "cloud-controller-manager",
      namespace: "kube-system",
    },
  };

  const clusterRole = {
    apiVersion: "rbac.authorization.k8s.io/v1",
    kind: "ClusterRole",
    metadata: {
      name: "system:cloud-controller-manager",
      annotations: { "rbac.authorization.kubernetes.io/autoupdate": "true" },
    },
    rules: [
      {
        apiGroups: [""],
        resources: ["events"],
        verbs: ["create", "patch", "update"],
      },
      {
        apiGroups: [""],
        resources: ["nodes"],
        verbs: ["*"],
      },
      {
        apiGroups: [""],
        resources: ["nodes/status"],
        verbs: ["patch"],
      },
      {
        apiGroups: [""],
        resources: ["services"],
        verbs: ["list", "patch", "update", "watch"],
      },
      {
        apiGroups: [""],
        resources: ["services/status"],
        verbs: ["patch"],
      },
      {
        apiGroups: [""],
        resources: ["serviceaccounts"],
        verbs: ["create", "get", "list", "watch", "update"],
      },
      {
        apiGroups: [""],
        resources: ["persistentvolumes"],
        verbs: ["get", "list", "update", "watch"],
      },
      {
        apiGroups: [""],
        resources: ["endpoints"],
        verbs: ["create", "get", "list", "watch", "update"],
      },
      {
        apiGroups: [""],
        resources: ["secrets"],
        verbs: ["get", "list", "watch"],
      },
      {
        apiGroups: ["coordination.k8s.io"],
        resources: ["leases"],
        verbs: ["create", "get", "list", "watch", "update"],
      },
    ],
  };

  const clusterRoleBinding = {
    apiVersion: "rbac.authorization.k8s.io/v1",
    kind: "ClusterRoleBinding",
    metadata: { name: "system:cloud-controller-manager" },
    roleRef: {
      apiGroup: "rbac.authorization.k8s.io",
      kind: "ClusterRole",
      name: "system:cloud-controller-manager",
    },
    subjects: [
      {
        kind: "ServiceAccount",
        name: "cloud-controller-manager",
        namespace: "kube-system",
      },
    ],
  };

  const deployment = {
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: {
      name: "cloud-controller-manager",
      namespace: "kube-system",
      labels: { app: "cloud-controller-manager" },
    },
    spec: {
      replicas: 1,
      selector: { matchLabels: { app: "cloud-controller-manager" } },
      template: {
        metadata: { labels: { app: "cloud-controller-manager" } },
        spec: {
          hostNetwork: true,
          serviceAccountName: "cloud-controller-manager",
          priorityClassName: "system-cluster-critical",
          tolerations: [
            {
              key: "node.cloudprovider.kubernetes.io/uninitialized",
              value: "true",
              effect: "NoSchedule",
            },
            {
              key: "node-role.kubernetes.io/control-plane",
              effect: "NoSchedule",
            },
          ],
          volumes: [
            {
              name: "gce-config",
              hostPath: { path: "/etc/gce" },
            },
          ],
          containers: [
            {
              name: "cloud-controller-manager",
              image: `${CCM_IMAGE_REPO}:${imageTag}`,
              imagePullPolicy: "IfNotPresent",
              command: [
                "/cloud-controller-manager",
                "--cloud-provider=gce",
                "--cloud-config=/etc/gce/gce.conf",
                "--leader-elect=true",
                "--use-service-account-credentials=true",
                "--controllers=*,-nodeipam",
                "--allocate-node-cidrs=false",
              ],
              volumeMounts: [
                {
                  name: "gce-config",
                  mountPath: "/etc/gce",
                  readOnly: true,
                },
              ],
            },
          ],
        },
      },
    },
  };

  return [serviceAccount, clusterRole, clusterRoleBinding, deployment]
    .map((doc) => yaml.dump(doc, { noRefs: true, lineWidth: -1 }))
    .join("---\n");
}

// ---- K8s API Helpers (used by upsertArtifacts) ----

interface KubeconfigShape {
  clusters: Array<{
    cluster: {
      server: string;
      "certificate-authority-data": string;
    };
  }>;
  users: Array<{
    user: {
      "client-certificate-data": string;
      "client-key-data": string;
    };
  }>;
}

interface K8sTlsOpts {
  ca: Buffer;
  cert: Buffer;
  key: Buffer;
}

async function k8sFetch(
  server: string,
  path: string,
  tlsOpts: K8sTlsOpts,
  init: RequestInit = {},
): Promise<Response> {
  const url = new URL(`${server}${path}`);
  const method = init.method ?? "GET";
  const headers = init.headers as Record<string, string> | undefined;
  const body = init.body as string | Buffer | undefined;

  return new Promise<Response>((resolve, reject) => {
    const req = https.request(
      {
        hostname: url.hostname,
        port: url.port || 6443,
        path: url.pathname + url.search,
        method,
        headers,
        ca: tlsOpts.ca,
        cert: tlsOpts.cert,
        key: tlsOpts.key,
        rejectUnauthorized: true,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const responseBody = Buffer.concat(chunks).toString();
          resolve(
            new Response(responseBody, {
              status: res.statusCode ?? 500,
              statusText: res.statusMessage ?? "",
              headers: res.headers as Record<string, string>,
            }),
          );
        });
      },
    );

    req.on("error", reject);

    if (body) {
      req.write(body);
    }
    req.end();
  });
}

function k8sApiPath(
  workloadType: string,
  namespace: string,
  name: string,
): string {
  switch (workloadType) {
    case "deployment":
      return `/apis/apps/v1/namespaces/${namespace}/deployments/${name}`;
    case "stateful-set":
      return `/apis/apps/v1/namespaces/${namespace}/statefulsets/${name}`;
    case "daemon-set":
      return `/apis/apps/v1/namespaces/${namespace}/daemonsets/${name}`;
    case "cron-job":
      return `/apis/batch/v1/namespaces/${namespace}/cronjobs/${name}`;
    default:
      throw new Error(
        `No API path defined for workload type "${workloadType}"`,
      );
  }
}

function k8sPatchBody(
  workloadType: string,
  containerName: string,
  image: string,
  envVars: Array<{ name: string; value: string }>,
): Record<string, unknown> {
  const containerPatch: Record<string, unknown> = {
    name: containerName,
    image,
    imagePullPolicy: "Always",
  };
  if (envVars.length > 0) {
    containerPatch["env"] = envVars;
  }

  const podSpecPatch = { containers: [containerPatch] };

  // Always add a restart annotation to force a rollout even when the image tag
  // is unchanged (e.g. :production_latest). Without this, k8s sees no spec diff
  // and the old pod keeps running with the stale image.
  const templateMetadata = {
    annotations: {
      "sdlc.works/restart-at": new Date().toISOString(),
    },
  };

  if (workloadType === "cron-job") {
    return {
      spec: {
        jobTemplate: {
          spec: { template: { metadata: templateMetadata, spec: podSpecPatch } },
        },
      },
    };
  }

  return {
    spec: {
      template: { metadata: templateMetadata, spec: podSpecPatch },
    },
  };
}

async function waitForRollout(
  server: string,
  apiPath: string,
  tls: K8sTlsOpts,
  componentName: string,
): Promise<void> {
  const intervalMs = 3_000;
  const maxAttempts = 100; // 5 minutes

  console.error(`  Waiting for rollout of ${componentName}...`);

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));

    const res = await k8sFetch(server, apiPath, tls);
    if (!res.ok) {
      console.error(`  Warning: failed to poll rollout status (${res.status})`);
      break;
    }

    const resource = (await res.json()) as {
      metadata: { generation?: number };
      status: {
        observedGeneration?: number;
        conditions?: Array<{ type: string; status: string }>;
      };
    };

    const generation = resource.metadata.generation ?? 1;
    const observed = resource.status.observedGeneration ?? 0;
    const availableCond = resource.status.conditions?.find(
      (c) => c.type === "Available",
    );

    if (generation === observed && availableCond?.status === "True") {
      return;
    }
  }

  console.error(
    `  ⚠️  Rollout of ${componentName} did not complete within timeout — it may still succeed in the background`,
  );
}

// ---- Workload Builder Helpers ----

interface ResourceQuantity {
  cpu: string;
  memory: string;
}

interface WorkloadBuilderBase {
  name: string;
  namespaceName: string;
  containerImage: string;
  envVars: { name: string; value: string }[];
  effectiveLimits: ResourceQuantity | undefined;
  effectiveRequests: ResourceQuantity | undefined;
  imagePullSecrets?: { name: string }[];
  $: {
    (name: string, ...values: any[]): string;
    (strings: TemplateStringsArray, ...values: any[]): string;
  };
  opts: pulumi.CustomResourceOptions;
}

function buildResources(
  limits: ResourceQuantity | undefined,
  requests: ResourceQuantity | undefined,
): k8s.types.input.core.v1.ResourceRequirements | undefined {
  if (!limits && !requests) return undefined;
  return {
    limits: limits ? { cpu: limits.cpu, memory: limits.memory } : undefined,
    requests: requests
      ? { cpu: requests.cpu, memory: requests.memory }
      : undefined,
  };
}

function buildVolumes(
  volumes: z.infer<typeof VolumeSchema>[],
): k8s.types.input.core.v1.Volume[] {
  return volumes.map((v) => {
    if (v.type === "configMap") {
      return { name: v.name, configMap: { name: v.configMapName } };
    }
    if (v.type === "secret") {
      return { name: v.name, secret: { secretName: v.secretName } };
    }
    return { name: v.name, emptyDir: { medium: v.medium || undefined } };
  });
}

function buildTolerations(
  tolerations: z.infer<typeof TolerationSchema>[],
): k8s.types.input.core.v1.Toleration[] {
  return tolerations.map((t) => ({
    key: t.key,
    operator: t.operator,
    value: t.value,
    effect: t.effect,
    tolerationSeconds: t.tolerationSeconds,
  }));
}

function buildHttpProbe(
  probe: z.infer<typeof HttpProbeSchema>,
): k8s.types.input.core.v1.Probe {
  return {
    httpGet: { path: probe.path, port: probe.port },
    initialDelaySeconds: probe.initialDelaySeconds,
    periodSeconds: probe.periodSeconds,
    timeoutSeconds: probe.timeoutSeconds,
    failureThreshold: probe.failureThreshold,
  };
}

function buildTcpProbe(
  probe: z.infer<typeof TcpProbeSchema>,
): k8s.types.input.core.v1.Probe {
  return {
    tcpSocket: { port: probe.port },
    initialDelaySeconds: probe.initialDelaySeconds,
    periodSeconds: probe.periodSeconds,
    timeoutSeconds: probe.timeoutSeconds,
    failureThreshold: probe.failureThreshold,
  };
}

function buildProbe(
  probe: z.infer<typeof ProbeSchema>,
): k8s.types.input.core.v1.Probe {
  return probe.type === "tcp" ? buildTcpProbe(probe) : buildHttpProbe(probe);
}

const PLACEHOLDER_IMAGE = "busybox:1.36" as const;

// ---- buildDeployment ----

interface DeploymentBuilderOpts extends WorkloadBuilderBase {
  config: DeploymentConfig;
}

/** Merge machineGroup into nodeSelector if set. */
function resolveNodeSelector(config: { nodeSelector?: Record<string, string>; machineGroup?: string }) {
  const selector = { ...(config.nodeSelector || {}) };
  if (config.machineGroup) {
    selector["sdlc.works/machine-group"] = config.machineGroup;
  }
  return Object.keys(selector).length > 0 ? selector : undefined;
}

function buildDeployment({
  name,
  namespaceName,
  config,
  containerImage,
  envVars,
  effectiveLimits,
  effectiveRequests,
  imagePullSecrets,
  $,
  opts,
}: DeploymentBuilderOpts): void {
  const appLabels = { app: name };

  new k8s.apps.v1.Deployment(
    $`deploy-${name}`,
    {
      metadata: { name, namespace: namespaceName },
      spec: {
        replicas: config.autoscaling?.enabled ? undefined : config.replicas,
        selector: { matchLabels: appLabels },
        strategy:
          config.strategy === "Recreate"
            ? { type: "Recreate" }
            : {
                type: "RollingUpdate",
                rollingUpdate: {
                  maxSurge: config.maxSurge,
                  maxUnavailable: config.maxUnavailable,
                },
              },
        template: {
          metadata: { labels: appLabels },
          spec: {
            terminationGracePeriodSeconds: config.terminationGracePeriodSeconds,
            serviceAccountName: config.serviceAccountName,
            nodeSelector: resolveNodeSelector(config),
            tolerations: buildTolerations(config.tolerations),
            volumes: buildVolumes(config.volumes),
            imagePullSecrets,
            // Spread replicas across nodes to survive single-node failures.
            affinity: (config.replicas > 1 || config.autoscaling?.enabled) ? {
              podAntiAffinity: {
                preferredDuringSchedulingIgnoredDuringExecution: [{
                  weight: 100,
                  podAffinityTerm: {
                    topologyKey: "kubernetes.io/hostname",
                    labelSelector: { matchLabels: appLabels },
                  },
                }],
              },
            } : undefined,
            containers: [
              {
                name,
                image: containerImage,
                ports: [{ containerPort: config.containerPort }],
                env: envVars,
                command: config.command,
                args: config.args,
                resources: buildResources(effectiveLimits, effectiveRequests),
                volumeMounts: config.volumeMounts,
                livenessProbe: config.livenessProbe
                  ? buildProbe(config.livenessProbe)
                  : undefined,
                readinessProbe: config.readinessProbe
                  ? buildProbe(config.readinessProbe)
                  : undefined,
              },
            ],
          },
        },
      },
    },
    opts,
  );

  // HPA — auto-scale pods based on CPU/memory utilisation.
  if (config.autoscaling?.enabled) {
    const metrics: any[] = [
      {
        type: "Resource",
        resource: {
          name: "cpu",
          target: {
            type: "Utilization",
            averageUtilization: config.autoscaling.targetCPUUtilizationPercentage,
          },
        },
      },
    ];
    if (config.autoscaling.targetMemoryUtilizationPercentage) {
      metrics.push({
        type: "Resource",
        resource: {
          name: "memory",
          target: {
            type: "Utilization",
            averageUtilization: config.autoscaling.targetMemoryUtilizationPercentage,
          },
        },
      });
    }

    new k8s.autoscaling.v2.HorizontalPodAutoscaler(
      $`hpa-${name}`,
      {
        metadata: { name, namespace: namespaceName },
        spec: {
          scaleTargetRef: { apiVersion: "apps/v1", kind: "Deployment", name },
          minReplicas: config.autoscaling.minReplicas,
          maxReplicas: config.autoscaling.maxReplicas,
          metrics,
        },
      },
      opts,
    );
  }

  // PDB — prevent all replicas from being evicted simultaneously during node maintenance.
  if (config.replicas > 1 || config.autoscaling?.enabled) {
    new k8s.policy.v1.PodDisruptionBudget(
      $`pdb-${name}`,
      {
        metadata: { name, namespace: namespaceName },
        spec: {
          minAvailable: 1,
          selector: { matchLabels: appLabels },
        },
      },
      opts,
    );
  }

  new k8s.core.v1.Service(
    $`svc-${name}`,
    {
      metadata: { name, namespace: namespaceName },
      spec: {
        selector: appLabels,
        type: config.serviceType,
        ports: [
          {
            port: config.servicePort,
            targetPort: config.containerPort,
          },
        ],
      },
    },
    opts,
  );
}

// ---- buildStatefulSet ----

interface StatefulSetBuilderOpts extends WorkloadBuilderBase {
  config: StatefulSetConfig;
}

function buildStatefulSet({
  name,
  namespaceName,
  config,
  containerImage,
  envVars,
  effectiveLimits,
  effectiveRequests,
  imagePullSecrets,
  $,
  opts,
}: StatefulSetBuilderOpts): void {
  const appLabels = { app: name };
  const svcName = config.serviceName ?? name;

  const headlessSvc = new k8s.core.v1.Service(
    $`svc-${name}`,
    {
      metadata: { name: svcName, namespace: namespaceName },
      spec: {
        clusterIP: "None",
        selector: appLabels,
        ports: [
          { port: config.containerPort, targetPort: config.containerPort },
        ],
      },
    },
    opts,
  );

  new k8s.apps.v1.StatefulSet(
    $`sts-${name}`,
    {
      metadata: { name, namespace: namespaceName },
      spec: {
        replicas: config.autoscaling?.enabled ? undefined : config.replicas,
        serviceName: headlessSvc.metadata.name,
        selector: { matchLabels: appLabels },
        template: {
          metadata: { labels: appLabels },
          spec: {
            serviceAccountName: config.serviceAccountName,
            nodeSelector: resolveNodeSelector(config),
            tolerations: buildTolerations(config.tolerations),
            terminationGracePeriodSeconds: 30,
            volumes: buildVolumes(config.volumes),
            imagePullSecrets,
            containers: [
              {
                name,
                image: containerImage,
                ports: [{ containerPort: config.containerPort }],
                env: envVars,
                command: config.command,
                args: config.args,
                resources: buildResources(effectiveLimits, effectiveRequests),
                volumeMounts: [
                  { name: "data", mountPath: config.storageMountPath },
                  ...config.volumeMounts,
                ],
                livenessProbe: config.livenessProbe
                  ? buildProbe(config.livenessProbe)
                  : undefined,
                readinessProbe: config.readinessProbe
                  ? buildProbe(config.readinessProbe)
                  : undefined,
              },
            ],
          },
        },
        volumeClaimTemplates: [
          {
            metadata: { name: "data" },
            spec: {
              accessModes: config.accessModes,
              storageClassName: config.storageClass,
              resources: { requests: { storage: config.storageSize } },
            },
          },
        ],
      },
    },
    opts,
  );
}

// ---- buildCronJob ----

interface CronJobBuilderOpts extends WorkloadBuilderBase {
  config: CronJobConfig;
}

function buildCronJob({
  name,
  namespaceName,
  config,
  containerImage,
  envVars,
  effectiveLimits,
  effectiveRequests,
  imagePullSecrets,
  $,
  opts,
}: CronJobBuilderOpts): void {
  new k8s.batch.v1.CronJob(
    $`cj-${name}`,
    {
      metadata: { name, namespace: namespaceName },
      spec: {
        schedule: config.schedule,
        concurrencyPolicy: config.concurrencyPolicy,
        successfulJobsHistoryLimit: config.successfulJobsHistoryLimit,
        failedJobsHistoryLimit: config.failedJobsHistoryLimit,
        jobTemplate: {
          spec: {
            backoffLimit: config.backoffLimit,
            activeDeadlineSeconds: config.activeDeadlineSeconds,
            template: {
              spec: {
                serviceAccountName: config.serviceAccountName,
                nodeSelector: resolveNodeSelector(config),
                tolerations: buildTolerations(config.tolerations),
                restartPolicy: config.restartPolicy,
                volumes: buildVolumes(config.volumes),
                imagePullSecrets,
                containers: [
                  {
                    name,
                    image: containerImage,
                    env: envVars,
                    command: config.command,
                    args: config.args,
                    resources: buildResources(
                      effectiveLimits,
                      effectiveRequests,
                    ),
                    volumeMounts: config.volumeMounts,
                  },
                ],
              },
            },
          },
        },
      },
    },
    opts,
  );
}

// ---- buildJob ----

interface JobBuilderOpts extends WorkloadBuilderBase {
  config: JobConfig;
}

function buildJob({
  name,
  namespaceName,
  config,
  containerImage,
  envVars,
  effectiveLimits,
  effectiveRequests,
  imagePullSecrets,
  $,
  opts,
}: JobBuilderOpts): void {
  new k8s.batch.v1.Job(
    $`job-${name}`,
    {
      metadata: { name, namespace: namespaceName },
      spec: {
        backoffLimit: config.backoffLimit,
        parallelism: config.parallelism,
        completions: config.completions,
        activeDeadlineSeconds: config.activeDeadlineSeconds,
        template: {
          spec: {
            serviceAccountName: config.serviceAccountName,
            nodeSelector: resolveNodeSelector(config),
            tolerations: buildTolerations(config.tolerations),
            restartPolicy: config.restartPolicy,
            volumes: buildVolumes(config.volumes),
            imagePullSecrets,
            containers: [
              {
                name,
                image: containerImage,
                env: envVars,
                command: config.command,
                args: config.args,
                resources: buildResources(effectiveLimits, effectiveRequests),
                volumeMounts: config.volumeMounts,
              },
            ],
          },
        },
      },
    },
    opts,
  );
}

// ---- buildDaemonSet ----

interface DaemonSetBuilderOpts extends WorkloadBuilderBase {
  config: DaemonSetConfig;
}

function buildDaemonSet({
  name,
  namespaceName,
  config,
  containerImage,
  envVars,
  effectiveLimits,
  effectiveRequests,
  imagePullSecrets,
  $,
  opts,
}: DaemonSetBuilderOpts): void {
  const appLabels = { app: name };

  new k8s.apps.v1.DaemonSet(
    $`ds-${name}`,
    {
      metadata: { name, namespace: namespaceName },
      spec: {
        selector: { matchLabels: appLabels },
        updateStrategy:
          config.updateStrategy === "OnDelete"
            ? { type: "OnDelete" }
            : {
                type: "RollingUpdate",
                rollingUpdate: { maxUnavailable: config.maxUnavailable },
              },
        template: {
          metadata: { labels: appLabels },
          spec: {
            serviceAccountName: config.serviceAccountName,
            nodeSelector: resolveNodeSelector(config),
            tolerations: buildTolerations(config.tolerations),
            volumes: buildVolumes(config.volumes),
            imagePullSecrets,
            containers: [
              {
                name,
                image: containerImage,
                ports: [{ containerPort: config.containerPort }],
                env: envVars,
                command: config.command,
                args: config.args,
                resources: buildResources(effectiveLimits, effectiveRequests),
                volumeMounts: config.volumeMounts,
              },
            ],
          },
        },
      },
    },
    opts,
  );
}
