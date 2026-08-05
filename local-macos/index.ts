import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import {
  connectionHandler,
  DeploymentArtifactType,
  InfraComponent,
} from "@sdlcworks/components";
import { z } from "zod";
import {
  LocalInternalServiceCI,
  LocalPostgresCI,
  LocalPublicHttpCI,
} from "../_internal/interfaces";
import {
  ensureSubstrate,
  LOCAL_WORLD_LABEL,
  SUBSTRATE_HTTP_PORT,
  toClusterImageRef,
  toNamespaceName,
} from "../_internal/local-substrate";

const DEFAULT_REPLICAS = 1;
const DEFAULT_POSTGRES_IMAGE = "postgres:16";
const DEFAULT_POSTGRES_STORAGE_GI = 1;
const POSTGRES_PORT = 5432;
// Machine-local dev substrate: the only trust boundary is possession of the
// machine, so a fixed well-known password is the honest posture — there is no
// secret material this world could meaningfully protect it with.
const LOCAL_POSTGRES_USERNAME = "postgres";
const LOCAL_POSTGRES_PASSWORD = "postgres";

const ServiceDeployConfigSchema = z.object({
  port: z.number().int().positive(),
  replicas: z.number().int().positive().default(DEFAULT_REPLICAS),
  env: z.record(z.string(), z.string()).default({}),
  publicHost: z.string().optional(),
});

const PostgresDeployConfigSchema = z.object({
  database: z.string().min(1),
  storageGi: z.number().int().positive().default(DEFAULT_POSTGRES_STORAGE_GI),
});

const component = new InfraComponent({
  metadata: {
    stateful: false,
    proxiable: false,
  },
  acceptedArtifactTypes: [DeploymentArtifactType.oci_spec_image],
  connectionTypes: {
    public: {
      description:
        "exposes the app component over HTTP at a machine-scoped address",
      interface: LocalPublicHttpCI,
    },
    internal: {
      description:
        "allows internal communication between app components via cluster service DNS",
      interface: LocalInternalServiceCI,
    },
    postgres: {
      description:
        "allows postgres database access between app components via cluster service DNS",
      interface: LocalPostgresCI,
    },
  } as const,
  connectionInterfaces: [],
  configSchema: z.object({
    k3sVersion: z.string().optional(),
    machineGroups: z
      .record(z.string(), z.any())
      .optional()
      .describe(
        "Accepted for schema parity with remote realizations of this entity; inert on a machine-local substrate",
      ),
    networkTags: z
      .array(z.string())
      .default([])
      .describe(
        "Accepted for schema parity with remote realizations of this entity; inert on a machine-local substrate",
      ),
  }),
  appComponentTypes: {
    "http-service": ServiceDeployConfigSchema,
    "tcp-service": ServiceDeployConfigSchema,
    postgres: PostgresDeployConfigSchema,
  },
  outputSchema: z.object({
    apiServerUrl: z.string(),
    namespace: z.string(),
  }),
});

const StateSchema = z.object({
  kubeconfig: z.string(),
  apiServerUrl: z.string(),
  registryPushAddress: z.string(),
  registryClusterAddress: z.string(),
  namespace: z.string(),
  allocations: z
    .record(
      z.string(),
      z.object({
        appComponentType: z.string(),
        namespace: z.string(),
        port: z.number(),
        replicas: z.number(),
        env: z.record(z.string(), z.string()),
        publicHost: z.string().optional(),
      }),
    )
    .default({}),
});

function providerFrom(kubeconfig: pulumi.Input<string>, name: string) {
  return new k8s.Provider(name, { kubeconfig });
}

component.implement(LOCAL_WORLD_LABEL, {
  stateSchema: StateSchema,

  pulumi: async ({ $, state }) => {
    const substrate = await ensureSubstrate();
    state.kubeconfig = substrate.kubeconfig;
    state.apiServerUrl = substrate.apiServerUrl;
    state.registryPushAddress = substrate.registryPushAddress;
    state.registryClusterAddress = substrate.registryClusterAddress;

    const namespaceName = toNamespaceName($`ns`);
    state.namespace = namespaceName;

    const provider = providerFrom(substrate.kubeconfig, $`k8s-provider`);
    const ns = new k8s.core.v1.Namespace(
      $`namespace`,
      { metadata: { name: namespaceName } },
      { provider },
    );

    return {
      apiServerUrl: pulumi.output(substrate.apiServerUrl),
      namespace: ns.metadata.name,
    };
  },

  allocateWithPulumiCtx: async ({
    name,
    appComponentType,
    deploymentConfig,
    state,
    $,
    envStore,
    buildArtifact,
  }) => {
    const provider = providerFrom(
      pulumi.output(state.kubeconfig),
      $(`k8s-provider-${name}`),
    );
    const namespace = state.namespace as string;

    if (appComponentType === "postgres") {
      const config = PostgresDeployConfigSchema.parse(deploymentConfig);
      new k8s.apps.v1.StatefulSet(
        $`postgres`,
        {
          metadata: { namespace, name },
          spec: {
            serviceName: name,
            replicas: 1,
            selector: { matchLabels: { app: name } },
            template: {
              metadata: { labels: { app: name } },
              spec: {
                containers: [
                  {
                    name: "postgres",
                    image: DEFAULT_POSTGRES_IMAGE,
                    ports: [{ containerPort: POSTGRES_PORT }],
                    env: [
                      { name: "POSTGRES_DB", value: config.database },
                      { name: "POSTGRES_USER", value: LOCAL_POSTGRES_USERNAME },
                      { name: "POSTGRES_PASSWORD", value: LOCAL_POSTGRES_PASSWORD },
                    ],
                    volumeMounts: [
                      { name: "data", mountPath: "/var/lib/postgresql/data" },
                    ],
                  },
                ],
              },
            },
            volumeClaimTemplates: [
              {
                metadata: { name: "data" },
                spec: {
                  accessModes: ["ReadWriteOnce"],
                  resources: {
                    requests: { storage: `${config.storageGi}Gi` },
                  },
                },
              },
            ],
          },
        },
        { provider },
      );
      new k8s.core.v1.Service(
        $`postgres-svc`,
        {
          metadata: { namespace, name },
          spec: {
            selector: { app: name },
            ports: [{ port: POSTGRES_PORT, targetPort: POSTGRES_PORT }],
          },
        },
        { provider },
      );
      return;
    }

    const config = ServiceDeployConfigSchema.parse(deploymentConfig);

    // The workload's artifact-independent shape — addressability and its
    // recorded allocation — always converges; the running Deployment
    // materializes only from an admitted artifact, here when one is already
    // released, otherwise at the release act through upsertArtifacts.
    const allocations = (state.allocations ?? {}) as Record<
      string,
      {
        appComponentType: string;
        namespace: string;
        port: number;
        replicas: number;
        env: Record<string, string>;
        publicHost?: string;
      }
    >;
    allocations[name] = {
      appComponentType,
      namespace,
      port: config.port,
      replicas: config.replicas,
      env: config.env,
      publicHost: config.publicHost,
    };
    state.allocations = allocations;

    if (!buildArtifact) {
      console.error(
        `${LOCAL_WORLD_LABEL}: component "${name}" awaits its first admitted build artifact; the workload materializes at release`,
      );
    }

    if (buildArtifact) {
    const image = toClusterImageRef(
      buildArtifact.artifact.uri,
      state.registryPushAddress as string,
      state.registryClusterAddress as string,
    );
    const env = [
      ...Object.entries(envStore[name] ?? {}).map(([k, v]) => ({
        name: k,
        value: v,
      })),
      ...Object.entries(config.env).map(([k, v]) => ({ name: k, value: v })),
    ];

    new k8s.apps.v1.Deployment(
      $(`deployment-${name}`),
      {
        metadata: { namespace, name },
        spec: {
          replicas: config.replicas,
          selector: { matchLabels: { app: name } },
          template: {
            metadata: { labels: { app: name } },
            spec: {
              containers: [
                {
                  name,
                  image,
                  ports: [{ containerPort: config.port }],
                  env,
                },
              ],
            },
          },
        },
      },
      { provider },
    );
    }
    new k8s.core.v1.Service(
      $(`service-${name}`),
      {
        metadata: { namespace, name },
        spec: {
          selector: { app: name },
          ports: [{ port: config.port, targetPort: config.port }],
        },
      },
      { provider },
    );

    if (appComponentType === "http-service" && config.publicHost) {
      new k8s.networking.v1.Ingress(
        $(`ingress-${name}`),
        {
          metadata: { namespace, name },
          spec: {
            rules: [
              {
                host: `${config.publicHost}.localhost`,
                http: {
                  paths: [
                    {
                      path: "/",
                      pathType: "Prefix",
                      backend: {
                        service: {
                          name,
                          port: { number: config.port },
                        },
                      },
                    },
                  ],
                },
              },
            ],
          },
        },
        { provider },
      );
    }
  },

  connect: (ctx) => {
    const namespace = ctx.state.namespace as string;
    return [
      connectionHandler({
        interface: LocalPublicHttpCI,
        handler: async () => ({
          uri: pulumi.output(
            `http://${ctx.selfComponentName}.localhost:${SUBSTRATE_HTTP_PORT}`,
          ),
          metadata: {
            serviceName: ctx.selfComponentName,
            namespace,
            port: SUBSTRATE_HTTP_PORT,
          },
        }),
      }),
      connectionHandler({
        interface: LocalInternalServiceCI,
        handler: async () => ({
          uri: pulumi.output(
            `http://${ctx.selfComponentName}.${namespace}.svc.cluster.local`,
          ),
          metadata: {
            host: `${ctx.selfComponentName}.${namespace}.svc.cluster.local`,
            port: SUBSTRATE_HTTP_PORT,
          },
        }),
      }),
      connectionHandler({
        interface: LocalPostgresCI,
        handler: async () => {
          const host = `${ctx.selfComponentName}.${namespace}.svc.cluster.local`;
          return {
            uri: pulumi.output(
              `postgres://${LOCAL_POSTGRES_USERNAME}:${LOCAL_POSTGRES_PASSWORD}@${host}:${POSTGRES_PORT}`,
            ),
            metadata: {
              host,
              port: POSTGRES_PORT,
              database: ctx.selfComponentName,
              username: LOCAL_POSTGRES_USERNAME,
              password: LOCAL_POSTGRES_PASSWORD,
            },
          };
        },
      }),
    ] as const;
  },

  upsertArtifacts: async ({ buildArtifacts, state, envStore }) => {
    const pushAddress = state.registryPushAddress as string;
    const clusterAddress = state.registryClusterAddress as string;
    const allocations = (state.allocations ?? {}) as Record<
      string,
      {
        appComponentType: string;
        namespace: string;
        port: number;
        replicas: number;
        env: Record<string, string>;
        publicHost?: string;
      }
    >;
    for (const [componentName, info] of Object.entries(buildArtifacts)) {
      if (info.artifact.type !== DeploymentArtifactType.oci_spec_image) {
        throw new Error(
          `${LOCAL_WORLD_LABEL}: component "${componentName}" carries artifact type "${info.artifact.type}"; this world hosts only OCI images`,
        );
      }
      if (!info.artifact.uri.startsWith(`${pushAddress}/`)) {
        throw new Error(
          `${LOCAL_WORLD_LABEL}: artifact "${info.artifact.uri}" for "${componentName}" is not resolvable through the branch's bound artifact store at ${pushAddress}; bind the branch's image artifact store to the machine-reachable registry`,
        );
      }
      const allocation = allocations[componentName];
      if (!allocation) {
        console.error(
          `${LOCAL_WORLD_LABEL}: component "${componentName}" has no recorded allocation on this substrate; converge the branch before releasing onto it`,
        );
        continue;
      }
      const image = toClusterImageRef(info.artifact.uri, pushAddress, clusterAddress);
      const env = [
        ...Object.entries(
          ((envStore ?? {}) as Record<string, Record<string, string>>)[
            componentName
          ] ?? {},
        ).map(([k, v]) => ({ name: k, value: v })),
        ...Object.entries(allocation.env).map(([k, v]) => ({
          name: k,
          value: v,
        })),
      ];
      console.error(
        `${LOCAL_WORLD_LABEL}: materializing ${image} → deployment/${componentName} in "${allocation.namespace}"`,
      );
      await applyDeployment(state.kubeconfig as string, {
        name: componentName,
        namespace: allocation.namespace,
        image,
        port: allocation.port,
        replicas: allocation.replicas,
        env,
      });
    }
  },
});

type KubeconfigShape = {
  clusters: Array<{
    cluster: { server: string; "certificate-authority-data": string };
  }>;
  users: Array<{
    user: { "client-certificate-data": string; "client-key-data": string };
  }>;
};

// Server-side apply: one idempotent act that creates the workload when absent
// and converges it when standing — the release enacts materialization exactly
// as the contract's admitted-materials invariant demands.
async function applyDeployment(
  kubeconfigYaml: string,
  spec: {
    name: string;
    namespace: string;
    image: string;
    port: number;
    replicas: number;
    env: Array<{ name: string; value: string }>;
  },
): Promise<void> {
  const { load } = await import("js-yaml");
  const { request } = await import("node:https");
  const kubeconfig = load(kubeconfigYaml) as KubeconfigShape;
  const cluster = kubeconfig.clusters[0]?.cluster;
  const user = kubeconfig.users[0]?.user;
  if (!cluster || !user) {
    throw new Error(
      `${LOCAL_WORLD_LABEL}: substrate kubeconfig carries no cluster or user identity`,
    );
  }
  const body = JSON.stringify({
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: {
      name: spec.name,
      namespace: spec.namespace,
      labels: { app: spec.name },
    },
    spec: {
      replicas: spec.replicas,
      selector: { matchLabels: { app: spec.name } },
      template: {
        metadata: { labels: { app: spec.name } },
        spec: {
          containers: [
            {
              name: spec.name,
              image: spec.image,
              ports: [{ containerPort: spec.port }],
              env: spec.env,
            },
          ],
        },
      },
    },
  });
  const url = new URL(
    `${cluster.server}/apis/apps/v1/namespaces/${spec.namespace}/deployments/${spec.name}?fieldManager=sdlc-local-release&force=true`,
  );
  await new Promise<void>((resolve, reject) => {
    const req = request(
      {
        host: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        method: "PATCH",
        headers: {
          "Content-Type": "application/apply-patch+yaml",
          "Content-Length": Buffer.byteLength(body),
        },
        ca: Buffer.from(cluster["certificate-authority-data"], "base64"),
        cert: Buffer.from(user["client-certificate-data"], "base64"),
        key: Buffer.from(user["client-key-data"], "base64"),
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          if ((res.statusCode ?? 500) < 300) {
            resolve();
          } else {
            reject(
              new Error(
                `${LOCAL_WORLD_LABEL}: apply of deployment/${spec.name} refused: ${res.statusCode} ${data}`,
              ),
            );
          }
        });
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

export default component;
