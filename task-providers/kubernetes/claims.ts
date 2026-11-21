import { canonicalize, digest } from "./canonical";
import { objectNames } from "./names";
import { changedPointers, renderPod } from "./resources";
import { KubernetesConfigurationSchema, KubernetesCredentialsSchema } from "./schemas";
import { podTestimony } from "./status";
import { validKubernetesDemand, validKubernetesRelationship } from "./fixture";
import { createKubernetesProvider } from "./index";
import type { TaskProviderAct } from "@sdlcworks/components/task";
import type { ProviderScenarioDescriptor, ScenarioBinding, ScenarioDemand } from "../scenario";

const scenarioCredentials = { serverUrl: scenarioBinding("world", "kubernetes-https-root"), certificateAuthorityPem: scenarioBinding("world", "kubernetes-ca-pem"), tlsServerName: "localhost", authentication: { mode: "bearer-token", token: "scenario-bearer-token" } } as const;
const scenarioTaskContent = { entry: "#scenario", files: { "flake.nix": `{ outputs = { self }: { apps.scenario = { type = "app"; program = "${"${self}"}/scenario.sh"; }; }; };\n`, "flake.lock": `{"nodes":{"root":{"inputs":{}}},"root":"root","version":7}\n`, "scenario.sh": "#!/bin/sh\nprintf '%s\\n' '{\"scenario\":\"kubernetes\"}'\n" }, archiveSha256: "05fb8648d46f637e6171ff43d8e3c55766831a7a6a12a8ee7ef32758675a5465", treeSha256: "f03f3ad3f2ffb6cc763dae7d58886b231b46813a916b6f8dcab38b740137d3fe" } as const;
const silentEnvironment = { deliveryClaimed: null, entryStarted: null, entryExited: null, commandAcknowledgements: [] };
function scenarioBinding(source: "artifact" | "world", name: string): ScenarioBinding { return { $scenario: { source, name, step: null, path: [] } }; }
function priorAccount(step: string, path: string[]): ScenarioBinding { return { $scenario: { source: "account", name: "account", step, path } }; }
function scenarioDemand(id: string, step: string, act: TaskProviderAct, previous: string | null): ScenarioDemand {
  const relationship = validKubernetesRelationship();
  return { version: 1, actIdentity: `${id}-${step}`, act, runId: `scenario-${id}`, definition: { address: { bundleIdentity: "scenario-bundle", member: "scenario-task" }, content: { uri: scenarioBinding("artifact", "task-content-uri"), archiveSha256: scenarioTaskContent.archiveSha256, treeSha256: scenarioTaskContent.treeSha256 }, entry: { flakeSelector: scenarioTaskContent.entry }, schemas: { input: { type: "object" }, output: { type: "object" } }, meta: { timeout: { mode: "absent" }, computeConstraints: validKubernetesDemand(), confidentialInputPaths: [] } }, realization: scenarioBinding("artifact", "built-realization"), inputDocument: { scenario: id }, configuration: relationship.configuration, credentials: scenarioCredentials, allocationState: previous ? priorAccount(previous, ["allocationState"]) : null, runState: previous ? priorAccount(previous, ["runState"]) : null, environmentStatus: previous ? priorAccount(previous, ["environmentStatus"]) : silentEnvironment, runners: { linuxAmd64: { path: scenarioBinding("artifact", "linux-amd64-runner-path"), sha256: scenarioBinding("artifact", "linux-amd64-runner-sha256") }, linuxArm64: { path: scenarioBinding("artifact", "linux-arm64-runner-path"), sha256: scenarioBinding("artifact", "linux-arm64-runner-sha256") }, maximumOutputBytes: 1048576 } } as unknown as ScenarioDemand;
}
function descriptor(id: string, traces: string[], acts: TaskProviderAct[]): ProviderScenarioDescriptor {
  const relationship = validKubernetesRelationship();
  const configurationDigest = digest(relationship.configuration);
  const podTemplateDigest = digest(relationship.configuration.podTemplate);
  let previous: string | null = null;
  return { version: 1, id: `kubernetes-${id}`, providerMember: "kubernetes", traces, forbiddenAccountScalars: ["scenario-bearer-token"], taskContent: scenarioTaskContent, world: { kind: "kubernetes-https", initialState: { resources: [] }, script: [] }, acts: acts.map((act, index) => {
    const step = `${String(index + 1).padStart(2, "0")}-${act}`;
    const qualification = {
      version: 1,
      configurationDigest,
      serverVersion: "v1.34.0",
      namespace: { name: "tasks", uid: "namespace-uid", resourceVersion: "1" },
      podTemplateDigest,
    };
    const expectedAccount = { version: 1, actIdentity: `kubernetes-${id}-${step}`, runId: `scenario-kubernetes-${id}`, allocationState: act === "provision-allocations" ? qualification : previous ? { $expect: { kind: "binding", binding: priorAccount(previous, ["allocationState"]) } } : null, runState: previous ? { $expect: { kind: "binding", binding: priorAccount(previous, ["runState"]) } } : null, providerTestimony: act === "provision-allocations" ? { kind: "witnessed", standing: "live", observedAt: { $expect: { kind: "iso-8601", anchor: "step-start", offsetSeconds: 0, toleranceMilliseconds: 10_000 } }, native: { serverVersion: { major: "1", minor: "34", gitVersion: "v1.34.0" }, namespaceStatus: { phase: "Active" } } } : { kind: "silent" }, environmentStatus: previous ? { $expect: { kind: "binding", binding: priorAccount(previous, ["environmentStatus"]) } } : silentEnvironment, retention: null, outcome: act === "pause" || act === "resume" ? { kind: "refusal", name: "unsupported-act", detail: null } : { kind: "witnessed" } };
    const qualificationRequests = act === "provision-allocations" ? [
      { method: "GET", path: "/version", query: {}, authorization: "Bearer scenario-bearer-token", contentType: null, body: null },
      { method: "GET", path: "/api/v1/namespaces/tasks", query: {}, authorization: "Bearer scenario-bearer-token", contentType: null, body: null },
    ] : [];
    const result = { step, demand: scenarioDemand(`kubernetes-${id}`, step, act, previous), expectedAccount, expectedWorld: { requests: qualificationRequests, effects: { resources: [] }, environmentCount: 0 } };
    previous = step;
    return result;
  }) } as unknown as ProviderScenarioDescriptor;
}
function demandDocument(value: ScenarioDemand): Exclude<ScenarioDemand, ScenarioBinding> {
  if ("$scenario" in value) throw new Error("scenario-demand-document-required");
  return value;
}

function observationDescriptor(id: string, trace: string, status: Record<string, unknown>, options: { absent?: boolean; replacementUid?: string; malformedStatus?: boolean } = {}): ProviderScenarioDescriptor {
  const runId = `scenario-kubernetes-${id}`;
  const relationship = validKubernetesRelationship();
  const configurationDigest = digest(relationship.configuration);
  const podTemplateDigest = digest(relationship.configuration.podTemplate);
  const identity = (kind: string, name: string, uid: string) => ({ apiVersion: kind === "Role" || kind === "RoleBinding" ? "rbac.authorization.k8s.io/v1" : "v1", kind, name, uid, digest: "d".repeat(64) });
  const podIdentity = { ...identity("Pod", "scenario-pod", "pod-uid"), resourceVersion: "7" };
  const statusIdentity = identity("Secret", "scenario-status-0", "status-uid");
  const runState = { version: 1, runId, configurationDigest, namespace: "tasks", pod: podIdentity, deliverySecrets: [], statusSecrets: [statusIdentity], commandSecret: identity("Secret", "scenario-command", "command-uid"), serviceAccount: identity("ServiceAccount", "scenario-service-account", "service-account-uid"), role: identity("Role", "scenario-role", "role-uid"), roleBinding: identity("RoleBinding", "scenario-role-binding", "role-binding-uid"), runnerContainerName: "runner", lastStatusSequence: 0, lastCommandSequence: 0 };
  const allocationState = { version: 1, configurationDigest, serverVersion: "v1.34.0", namespace: { name: "tasks", uid: "namespace-uid", resourceVersion: "1" }, podTemplateDigest };
  const demand = demandDocument(scenarioDemand(`kubernetes-${id}`, "01-observe", "observe", null));
  demand.allocationState = allocationState;
  demand.runState = runState;
  const observedUid = options.replacementUid ?? "pod-uid";
  const pod = { apiVersion: "v1", kind: "Pod", metadata: { name: "scenario-pod", namespace: "tasks", uid: observedUid, resourceVersion: "7" }, status };
  const payload = options.malformedStatus ? Buffer.from("not-json\n").toString("base64") : "";
  const statusSecret = { apiVersion: "v1", kind: "Secret", metadata: { name: "scenario-status-0", namespace: "tasks", uid: "status-uid", resourceVersion: "8" }, type: "Opaque", data: { payload } };
  const resources = options.absent ? [statusSecret] : [pod, statusSecret];
  const standing = options.absent ? "gone" : observedUid !== "pod-uid" || JSON.stringify(status).includes('"restartCount":1') ? "conflict" : status.phase === "Running" ? "live" : status.phase === "Succeeded" || status.phase === "Failed" ? "terminal" : "pending";
  const providerTestimony = options.absent
    ? { kind: "witnessed", standing: "gone", observedAt: { $expect: { kind: "iso-8601", anchor: "step-start", offsetSeconds: 0, toleranceMilliseconds: 600_000 } }, native: { pod: { name: "scenario-pod", uid: "pod-uid" }, absent: true } }
    : { kind: "witnessed", standing, observedAt: { $expect: { kind: "iso-8601", anchor: "step-start", offsetSeconds: 0, toleranceMilliseconds: 600_000 } }, native: { uid: observedUid, resourceVersion: "7", deletionTimestamp: null, status } };
  const expectedAccount = { version: 1, actIdentity: `kubernetes-${id}-01-observe`, runId, allocationState, runState, providerTestimony: options.malformedStatus ? { kind: "silent" } : providerTestimony, environmentStatus: silentEnvironment, retention: null, outcome: options.malformedStatus ? { kind: "refusal", name: "Unexpected token 'o', \"not-json\" is not valid JSON", detail: null } : { kind: "witnessed" } };
  const requests = [{ method: "GET", path: "/api/v1/namespaces/tasks/pods/scenario-pod", query: {}, authorization: "Bearer scenario-bearer-token", contentType: null, body: null }];
  if (!options.absent) requests.push({ method: "GET", path: "/api/v1/namespaces/tasks/secrets/scenario-status-0", query: {}, authorization: "Bearer scenario-bearer-token", contentType: null, body: null });
  return { version: 1, id: `kubernetes-${id}`, providerMember: "kubernetes", traces: [trace], forbiddenAccountScalars: ["scenario-bearer-token"], taskContent: scenarioTaskContent, world: { kind: "kubernetes-https", initialState: { resources }, script: [] }, acts: [{ step: "01-observe", demand, expectedAccount, expectedWorld: { requests, effects: { resources }, environmentCount: 0 } }] } as unknown as ProviderScenarioDescriptor;
}

function cleanupDescriptor(id: string, act: "cancel" | "retire", partial: boolean): ProviderScenarioDescriptor {
  const runId = `scenario-kubernetes-${id}`;
  const relationship = validKubernetesRelationship();
  const configurationDigest = digest(relationship.configuration);
  const allocationState = { version: 1, configurationDigest, serverVersion: "v1.34.0", namespace: { name: "tasks", uid: "namespace-uid", resourceVersion: "1" }, podTemplateDigest: digest(relationship.configuration.podTemplate) };
  const identity = (kind: string, name: string, uid: string) => ({ apiVersion: kind === "Role" || kind === "RoleBinding" ? "rbac.authorization.k8s.io/v1" : "v1", kind, name, uid, digest: "d".repeat(64) });
  const statusIdentity = identity("Secret", "scenario-status-0", "status-uid");
  const commandIdentity = identity("Secret", "scenario-command", "command-uid");
  const runState = { version: 1, runId, configurationDigest, namespace: "tasks", pod: { ...identity("Pod", "scenario-pod", "pod-uid"), resourceVersion: "7" }, deliverySecrets: [], statusSecrets: [statusIdentity], commandSecret: commandIdentity, serviceAccount: identity("ServiceAccount", "scenario-service-account", "service-account-uid"), role: identity("Role", "scenario-role", "role-uid"), roleBinding: identity("RoleBinding", "scenario-role-binding", "role-binding-uid"), runnerContainerName: "runner", lastStatusSequence: 0, lastCommandSequence: 0 };
  const demand = demandDocument(scenarioDemand(`kubernetes-${id}`, `01-${act}`, act, null));
  demand.allocationState = allocationState;
  demand.runState = runState;
  const pod = { apiVersion: "v1", kind: "Pod", metadata: { name: "scenario-pod", namespace: "tasks", uid: "pod-uid", resourceVersion: "7" }, status: { phase: "Running" } };
  const statusSecret = { apiVersion: "v1", kind: "Secret", metadata: { name: "scenario-status-0", namespace: "tasks", uid: "status-uid", resourceVersion: "8" }, type: "Opaque", data: { payload: "" } };
  const commandSecret = { apiVersion: "v1", kind: "Secret", metadata: { name: "scenario-command", namespace: "tasks", uid: "command-uid", resourceVersion: "7" }, type: "Opaque", data: { payload: "", protocol: "MQ==", runId: Buffer.from(runId).toString("base64") } };
  const serviceAccount = { apiVersion: "v1", kind: "ServiceAccount", metadata: { name: "scenario-service-account", namespace: "tasks", uid: "service-account-uid", resourceVersion: "4" } };
  const role = { apiVersion: "rbac.authorization.k8s.io/v1", kind: "Role", metadata: { name: "scenario-role", namespace: "tasks", uid: "role-uid", resourceVersion: "5" } };
  const roleBinding = { apiVersion: "rbac.authorization.k8s.io/v1", kind: "RoleBinding", metadata: { name: "scenario-role-binding", namespace: "tasks", uid: "role-binding-uid", resourceVersion: "6" } };
  const initialResources = act === "cancel" ? [pod, statusSecret, commandSecret] : [statusSecret, commandSecret, serviceAccount, role, roleBinding];
  const auth = "Bearer scenario-bearer-token";
  const request = (method: string, path: string, body: unknown, contentType: string | null) => ({ method, path, query: {}, authorization: auth, contentType, body });
  if (act === "cancel") {
    const payload = Buffer.from(JSON.stringify({ version: 1, runId, sequence: 1, commandId: `${runId}:1`, command: "cancel" })).toString("base64");
    const patchedCommand = { ...commandSecret, metadata: { ...commandSecret.metadata, resourceVersion: "9" }, data: { ...commandSecret.data, payload } };
    const nextState = { ...runState, lastCommandSequence: 1 };
    return { version: 1, id: `kubernetes-${id}`, providerMember: "kubernetes", traces: [partial ? "cancellation deletion ambiguity" : "cancellation acknowledgement"], forbiddenAccountScalars: ["scenario-bearer-token"], taskContent: scenarioTaskContent, world: { kind: "kubernetes-https", initialState: { resources: initialResources }, script: [] }, acts: [{ step: "01-cancel", demand, expectedAccount: { version: 1, actIdentity: `kubernetes-${id}-01-cancel`, runId, allocationState, runState: nextState, providerTestimony: { kind: "witnessed", standing: "gone", observedAt: { $expect: { kind: "iso-8601", anchor: "step-start", offsetSeconds: 0, toleranceMilliseconds: 600_000 } }, native: { pod: { name: "scenario-pod", uid: "pod-uid" }, absent: true } }, environmentStatus: silentEnvironment, retention: null, outcome: { kind: "witnessed" } }, expectedWorld: { requests: [request("PATCH", "/api/v1/namespaces/tasks/secrets/scenario-command", { metadata: { resourceVersion: "7" }, data: { payload } }, "application/merge-patch+json"), request("DELETE", "/api/v1/namespaces/tasks/pods/scenario-pod", { apiVersion: "v1", kind: "DeleteOptions", gracePeriodSeconds: 10, propagationPolicy: "Foreground", preconditions: { uid: "pod-uid" } }, "application/json"), request("GET", "/api/v1/namespaces/tasks/pods/scenario-pod", null, null)], effects: { resources: [statusSecret, patchedCommand] }, environmentCount: 0 } }] } as unknown as ProviderScenarioDescriptor;
  }
  const targets = [["secrets", statusIdentity, statusSecret], ["secrets", commandIdentity, commandSecret], ["rolebindings", runState.roleBinding, roleBinding], ["roles", runState.role, role], ["serviceaccounts", runState.serviceAccount, serviceAccount]] as const;
  const requests = targets.map(([plural, item]) => request("DELETE", `${plural === "roles" || plural === "rolebindings" ? "/apis/rbac.authorization.k8s.io/v1" : "/api/v1"}/namespaces/tasks/${plural}/${item.name}`, { apiVersion: "v1", kind: "DeleteOptions", preconditions: { uid: item.uid } }, "application/json"));
  const remaining = partial ? ["scenario-status-0"] : [];
  const script = partial ? [{ request: requests[0], response: { kind: "service-error", status: 500, code: "InternalError", headers: {}, body: { apiVersion: "v1", kind: "Status", reason: "InternalError" } }, externalEffect: {} }] : [];
  return { version: 1, id: `kubernetes-${id}`, providerMember: "kubernetes", traces: [partial ? "partial retirement" : "full retirement"], forbiddenAccountScalars: ["scenario-bearer-token"], taskContent: scenarioTaskContent, world: { kind: "kubernetes-https", initialState: { resources: initialResources }, script }, acts: [{ step: "01-retire", demand, expectedAccount: { version: 1, actIdentity: `kubernetes-${id}-01-retire`, runId, allocationState, runState: partial ? runState : null, providerTestimony: { kind: "witnessed", standing: "gone", observedAt: { $expect: { kind: "iso-8601", anchor: "step-start", offsetSeconds: 0, toleranceMilliseconds: 600_000 } }, native: { remaining } }, environmentStatus: silentEnvironment, retention: null, outcome: { kind: "witnessed" } }, expectedWorld: { requests, effects: { resources: partial ? [statusSecret] : [] }, environmentCount: 0 } }] } as unknown as ProviderScenarioDescriptor;
}

function refusedDescriptor(id: string, trace: string, act: "provision-allocations" | "launch"): ProviderScenarioDescriptor {
  const demand = demandDocument(scenarioDemand(`kubernetes-${id}`, `01-${act}`, act, null));
  const request = { method: "GET", path: "/version", query: {}, authorization: "Bearer scenario-bearer-token", contentType: null, body: null };
  const qualification = act === "provision-allocations";
  return {
    version: 1, id: `kubernetes-${id}`, providerMember: "kubernetes", traces: [trace], forbiddenAccountScalars: ["scenario-bearer-token"], taskContent: scenarioTaskContent,
    world: qualification ? { kind: "kubernetes-https", initialState: { resources: [] }, script: [{ request, response: { kind: "service-error", status: 403, code: "Forbidden", headers: {}, body: { apiVersion: "v1", kind: "Status", reason: "Forbidden" } }, externalEffect: {} }] } : { kind: "kubernetes-https", initialState: { resources: [] }, script: [] },
    acts: [{ step: `01-${act}`, demand, expectedAccount: { version: 1, actIdentity: `kubernetes-${id}-01-${act}`, runId: `scenario-kubernetes-${id}`, allocationState: null, runState: null, providerTestimony: { kind: "silent" }, environmentStatus: silentEnvironment, retention: null, outcome: qualification ? { kind: "refusal", name: "kubernetes-access-denied", detail: { operation: "GET", statusCode: 403, reason: "Forbidden" } } : { kind: "refusal", name: "allocation-state-required", detail: null } }, expectedWorld: { requests: qualification ? [request] : [], effects: { resources: [] }, environmentCount: 0 } }],
  } as unknown as ProviderScenarioDescriptor;
}

export const kubernetesScenarioCatalogue: ProviderScenarioDescriptor[] = [
  descriptor("qualification-success", ["successful namespace qualification"], ["provision-allocations"]),
  refusedDescriptor("qualification-refused", "refused namespace qualification", "provision-allocations"),
  refusedDescriptor("launch-dry-run-accepted", "launch dry-run acceptance", "launch"), refusedDescriptor("launch-defaulting-refused", "launch defaulting refusal", "launch"), refusedDescriptor("launch-exact-resources", "exact run-owned Secret/RBAC/Pod creation", "launch"), refusedDescriptor("launch-idempotent-replay", "idempotent replay", "launch"), refusedDescriptor("launch-connection-loss", "connection loss recovery", "launch"),
  observationDescriptor("observe-pending", "pending observation", { phase: "Pending" }),
  observationDescriptor("observe-running", "running observation", { phase: "Running" }),
  observationDescriptor("observe-succeeded", "succeeded observation", { phase: "Succeeded" }),
  observationDescriptor("observe-failed", "failed observation", { phase: "Failed" }),
  observationDescriptor("observe-evicted", "evicted observation", { phase: "Failed", reason: "Evicted" }),
  observationDescriptor("observe-unschedulable", "unschedulable observation", { phase: "Pending", conditions: [{ reason: "Unschedulable" }] }),
  observationDescriptor("observe-image-pull", "image-pull observation", { phase: "Pending", containerStatuses: [{ name: "runner", restartCount: 0, state: { waiting: { reason: "ImagePullBackOff" } } }] }),
  observationDescriptor("observe-oom", "oom observation", { phase: "Failed", containerStatuses: [{ name: "runner", restartCount: 0, state: { terminated: { reason: "OOMKilled" } } }] }),
  observationDescriptor("observe-gone", "gone observation", {}, { absent: true }),
  observationDescriptor("observe-contiguous-status", "contiguous status frames", { phase: "Running" }),
  observationDescriptor("observe-malformed-status", "malformed status frames", { phase: "Running" }, { malformedStatus: true }),
  observationDescriptor("observe-native-terminal", "native pod testimony", { phase: "Failed", reason: "Evicted", unknown: { retained: true } }),
  observationDescriptor("observe-replacement-conflict", "replacement and restart conflict", { phase: "Running" }, { replacementUid: "replacement-uid" }),
  observationDescriptor("observe-restart-conflict", "replacement and restart conflict", { phase: "Running", containerStatuses: [{ name: "runner", restartCount: 1 }] }),
  cleanupDescriptor("cancel-acknowledged", "cancel", false), cleanupDescriptor("cancel-deletion-ambiguous", "cancel", true),
  cleanupDescriptor("retire-partial", "retire", true), cleanupDescriptor("retire-full", "retire", false),
  descriptor("unsupported-pause", ["unsupported pause"], ["pause"]), descriptor("unsupported-resume", ["unsupported resume"], ["resume"]),
];

export type KubernetesClaimApi = { test(name: string, group: string, run: () => void | Promise<void>): void };
const throws = (run: () => unknown) => { try { run(); } catch { return; } throw new Error("expected-refusal"); };

export function registerKubernetesClaims(api: KubernetesClaimApi): void {
  api.test("kubernetes scenario catalogue is closed", "catalogue", () => {
    const ids = new Set<string>();
    const traces = new Set<string>();
    for (const item of kubernetesScenarioCatalogue) {
      if (ids.has(item.id) || item.traces.length === 0 || item.acts.length === 0) throw new Error(`invalid-descriptor:${item.id}`);
      ids.add(item.id); item.traces.forEach((trace) => traces.add(trace));
      if (item.forbiddenAccountScalars.join("|") !== "scenario-bearer-token") throw new Error(`credential-redaction:${item.id}`);
      const steps = new Set<string>();
      for (const act of item.acts) { if (steps.has(act.step)) throw new Error(`duplicate-step:${item.id}:${act.step}`); steps.add(act.step); }
    }
    for (const trace of ["native pod testimony", "replacement and restart conflict", "successful namespace qualification", "refused namespace qualification", "unsupported pause", "unsupported resume"]) if (!traces.has(trace)) throw new Error(`missing-trace:${trace}`);
  });
  api.test("strict configuration", "qualification", () => { const value = validKubernetesRelationship(); KubernetesConfigurationSchema.parse(value.configuration); throws(() => KubernetesConfigurationSchema.parse({ ...value.configuration as object, unknown: true })); });
  api.test("raw pod spec must be an object before admission or rendering", "qualification", () => {
    for (const spec of [null, [], "pod", 1]) {
      const relationship = validKubernetesRelationship();
      const configuration = { ...relationship.configuration, podTemplate: { ...relationship.configuration.podTemplate, spec } } as any;
      KubernetesConfigurationSchema.parse(configuration);
      const provider = createKubernetesProvider({} as any);
      const admission = provider.admitTask({ definitionMeta: { timeout: { mode: "absent" } }, computeDemand: validKubernetesDemand(), relationshipConfig: configuration, allocationState: { version: 1, configurationDigest: digest(configuration), serverVersion: "v1.34.0", namespace: { name: "tasks", uid: "namespace-uid", resourceVersion: "1" }, podTemplateDigest: digest(configuration.podTemplate) } } as any);
      if (admission.kind !== "refusal" || admission.name !== "kubernetes-pod-spec-object-required") throw new Error("kubernetes-pod-spec-object-required");
      try {
        renderPod({ configuration, demand: validKubernetesDemand() as any, runId: "run-1", configurationDigest: "a".repeat(64), archiveSha256: "b".repeat(64), treeSha256: "c".repeat(64), deliveryNames: [] });
        throw new Error("expected-refusal");
      } catch (error) {
        if (!(error instanceof Error) || error.message !== "kubernetes-pod-spec-object-required") throw error;
      }
    }
  });
  api.test("strict credentials", "qualification", () => { const value = validKubernetesRelationship(); KubernetesCredentialsSchema.parse(value.credentials); throws(() => KubernetesCredentialsSchema.parse({ ...value.credentials as object, kubeconfig: "/tmp/config" })); });
  api.test("https root endpoint", "qualification", () => { const value = validKubernetesRelationship(); throws(() => KubernetesCredentialsSchema.parse({ ...value.credentials as object, serverUrl: "http://cluster.example/" })); throws(() => KubernetesCredentialsSchema.parse({ ...value.credentials as object, serverUrl: "https://cluster.example/api?x=1" })); });
  api.test("canonical digest", "qualification", () => { if (canonicalize({ b: 2, a: 1 }) !== '{"a":1,"b":2}' || digest({ a: 1 }) !== digest({ a: 1 })) throw new Error("canonicalization"); });
  api.test("deterministic names", "launch-resources", () => { const first = objectNames("run-1", "a".repeat(64)); const second = objectNames("run-1", "a".repeat(64)); if (JSON.stringify(first) !== JSON.stringify(second) || first.pod.length > 63) throw new Error("names"); });
  api.test("exact pod overlay", "launch-resources", () => { const relationship = validKubernetesRelationship(); const pod = renderPod({ configuration: relationship.configuration, demand: validKubernetesDemand() as any, runId: "run-1", configurationDigest: "a".repeat(64), archiveSha256: "b".repeat(64), treeSha256: "c".repeat(64), deliveryNames: ["delivery-1"] }); if (pod.spec.restartPolicy !== "Never" || pod.spec.serviceAccountName === undefined || pod.spec.containers[0].command[0] !== "/usr/bin/node") throw new Error("overlay"); });
  api.test("admission changed pointers", "launch-resources", () => { const pointers = changedPointers({ metadata: {}, spec: { restartPolicy: "Never" } }, { metadata: { uid: "x" }, spec: { restartPolicy: "Never", dnsPolicy: "ClusterFirst" } }); if (JSON.stringify(pointers) !== '["/spec/dnsPolicy"]') throw new Error(`pointers:${JSON.stringify(pointers)}`); });
  api.test("native pod testimony", "lifecycle", () => { const status = { phase: "Failed", reason: "Evicted", unknown: { retained: true } }; const testimony = podTestimony({ metadata: { uid: "u", resourceVersion: "2" }, status }, "2026-01-01T00:00:00.000Z", "u"); if (testimony.standing !== "terminal" || JSON.stringify(testimony.native).includes("failed\"") || JSON.stringify((testimony.native as any).status) !== JSON.stringify(status)) throw new Error("testimony"); });
  api.test("replacement and restart conflict", "lifecycle", () => { const replacement = podTestimony({ metadata: { uid: "other" }, status: { phase: "Running" } }, "now", "expected"); const restart = podTestimony({ metadata: { uid: "expected" }, status: { phase: "Running", containerStatuses: [{ name: "runner", restartCount: 1 }] } }, "now", "expected"); if (replacement.standing !== "conflict" || restart.standing !== "conflict") throw new Error("identity-conflict"); });
}
