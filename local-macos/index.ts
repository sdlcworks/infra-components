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
      $`k8s-provider`,
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
    if (!buildArtifact) {
      throw new Error(
        `${LOCAL_WORLD_LABEL}: component "${name}" has no admitted build artifact; workloads materialize only from admitted materials`,
      );
    }
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
      $`deployment`,
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
    new k8s.core.v1.Service(
      $`service`,
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
        $`ingress`,
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

  upsertArtifacts: async ({ buildArtifacts, state }) => {
    const pushAddress = state.registryPushAddress as string;
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
    }
  },
});

export default component;
