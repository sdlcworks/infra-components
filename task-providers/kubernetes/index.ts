import { TaskProvider, taskProviderRefusal, type TaskEnactmentAccount, type TaskProviderLifecycleHandler, type TaskRealizationContext } from "@sdlcworks/components/task";
import { readFile } from "node:fs/promises";
import { KubernetesApiClient, KubernetesClientError } from "./client";
import { digest } from "./canonical";
import { createLaunch, createObserve, createCancel, createRetire } from "./lifecycle";
import { KubernetesAllocationStateSchema, KubernetesComputeConstraintsSchema, KubernetesConfigurationSchema, KubernetesCredentialsSchema, KubernetesRunStateSchema, requireKubernetesPodSpecObject, type KubernetesAllocationState, type KubernetesConfiguration, type KubernetesCredentials, type KubernetesRunState } from "./schemas";

export type KubernetesContext = TaskRealizationContext<KubernetesConfiguration, KubernetesCredentials, KubernetesAllocationState, KubernetesRunState>;
export type KubernetesHandler = TaskProviderLifecycleHandler<KubernetesConfiguration, KubernetesCredentials, KubernetesAllocationState, KubernetesRunState>;
export type KubernetesDependencies = { now(): Date; sleep(milliseconds: number): Promise<void>; fetchContent(uri: string): Promise<Uint8Array>; readFile(path: string): Promise<Uint8Array>; createClient(credentials: KubernetesCredentials, configuration: KubernetesConfiguration): KubernetesApiClient };

const baseAccount = (context: KubernetesContext) => ({ version: 1 as const, actIdentity: context.actIdentity, runId: context.runId, allocationState: context.allocationState, runState: context.runState, providerTestimony: { kind: "silent" as const }, environmentStatus: context.environmentStatus, retention: null });

export function createProvisionAllocations(dependencies: KubernetesDependencies): KubernetesHandler {
  return async (context): Promise<TaskEnactmentAccount<KubernetesAllocationState, KubernetesRunState>> => {
    const base = baseAccount(context);
    try {
      const client = dependencies.createClient(context.credentials, context.configuration);
      const version = await client.request<any>({ method: "GET", path: "/version", query: {}, body: null, contentType: null, expectedStatusCodes: [200] });
      const namespace = await client.request<any>({ method: "GET", path: `/api/v1/namespaces/${encodeURIComponent(context.configuration.namespace.name)}`, query: {}, body: null, contentType: null, expectedStatusCodes: [200] });
      if (namespace.body?.status?.phase !== "Active" || !namespace.body?.metadata?.uid || !namespace.body?.metadata?.resourceVersion || namespace.body?.metadata?.name !== context.configuration.namespace.name)
        return { ...base, outcome: taskProviderRefusal("kubernetes-namespace-not-qualified", null) };
      const allocationState: KubernetesAllocationState = { version: 1, configurationDigest: digest(context.configuration), serverVersion: String(version.body?.gitVersion ?? ""), namespace: { name: namespace.body.metadata.name, uid: namespace.body.metadata.uid, resourceVersion: namespace.body.metadata.resourceVersion }, podTemplateDigest: digest(context.configuration.podTemplate) };
      if (!allocationState.serverVersion) return { ...base, outcome: taskProviderRefusal("kubernetes-server-version-missing", null) };
      return { ...base, allocationState, providerTestimony: { kind: "witnessed", standing: "live", observedAt: dependencies.now().toISOString(), native: { serverVersion: version.body, namespaceStatus: namespace.body.status } }, outcome: { kind: "witnessed" } };
    } catch (error) {
      return { ...base, outcome: error instanceof KubernetesClientError ? error.result : taskProviderRefusal("kubernetes-qualification-failed", null) };
    }
  };
}

export function createKubernetesProvider(dependencies: KubernetesDependencies, overrides: Partial<Record<"provisionAllocations" | "launch" | "observe" | "cancel" | "retire", KubernetesHandler>> = {}) {
  return new TaskProvider<KubernetesConfiguration, KubernetesCredentials, KubernetesAllocationState, KubernetesRunState>({
    configurationSchema: KubernetesConfigurationSchema, credentialSchema: KubernetesCredentialsSchema, allocationStateSchema: KubernetesAllocationStateSchema, runStateSchema: KubernetesRunStateSchema, computeConstraintsSchema: KubernetesComputeConstraintsSchema,
    capabilities: { "provision-allocations": true, launch: true, observe: true, pause: false, resume: false, cancel: true, retire: true },
    runtimeEnvelope: { maximumRuntimeSeconds: null, admitsTimeoutAbsent: true },
    admitTask: ({ computeDemand, relationshipConfig, allocationState }) => {
      const demand = KubernetesComputeConstraintsSchema.parse(computeDemand);
      let spec: any;
      try { spec = requireKubernetesPodSpecObject(relationshipConfig.podTemplate.spec); }
      catch { return taskProviderRefusal("kubernetes-pod-spec-object-required", null); }
      const containers = Array.isArray(spec.containers) ? spec.containers.filter((item: any) => item?.name === relationshipConfig.runnerContainerName) : [];
      const runner = containers[0]; const requests = runner?.resources?.requests; const limits = runner?.resources?.limits;
      const gpu = demand.resources.gpu;
      const admitted = allocationState.configurationDigest === digest(relationshipConfig) && allocationState.namespace.name === relationshipConfig.namespace.name && containers.length === 1 && spec.nodeSelector?.["kubernetes.io/os"] === demand.os && spec.nodeSelector?.["kubernetes.io/arch"] === demand.architecture && requests?.cpu === demand.resources.requests.cpu && requests?.memory === demand.resources.requests.memory && requests?.["ephemeral-storage"] === demand.resources.requests.ephemeralStorage && limits?.cpu === demand.resources.limits.cpu && limits?.memory === demand.resources.limits.memory && limits?.["ephemeral-storage"] === demand.resources.limits.ephemeralStorage && relationshipConfig.workspace.sizeLimit === demand.resources.limits.ephemeralStorage && (gpu.mode === "none" ? true : requests?.[gpu.resourceName] === gpu.quantity && limits?.[gpu.resourceName] === gpu.quantity);
      return admitted ? { kind: "admitted", nativeRuntimeCeiling: { mode: "unbounded" } } : taskProviderRefusal("kubernetes-compute-demand-not-admitted", null);
    },
    handlers: { provisionAllocations: overrides.provisionAllocations ?? createProvisionAllocations(dependencies), launch: overrides.launch ?? createLaunch(dependencies), observe: overrides.observe ?? createObserve(dependencies), cancel: overrides.cancel ?? createCancel(dependencies), retire: overrides.retire ?? createRetire(dependencies) },
  });
}

export default createKubernetesProvider({ now: () => new Date(), sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)), fetchContent: async (uri) => new Uint8Array(await (await fetch(uri)).arrayBuffer()), readFile: async (path) => new Uint8Array(await readFile(path)), createClient: (credentials, configuration) => new KubernetesApiClient(credentials, configuration) });
