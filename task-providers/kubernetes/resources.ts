import { clone, digest } from "./canonical";
import { objectNames } from "./names";
import { requireKubernetesPodSpecObject, type KubernetesComputeConstraints, type KubernetesConfiguration } from "./schemas";

export const protectedLabelKeys = ["sdlc.dev/task-run-id-digest", "sdlc.dev/configuration-digest", "sdlc.dev/content-archive-sha256", "sdlc.dev/content-tree-sha256", "sdlc.dev/object-role"] as const;
export function kubernetesRunIdDigest(runId: string): string { return digest(runId); }
export function protectedLabels(runId: string, configurationDigest: string, archiveSha256: string, treeSha256: string, role: string) { return { "sdlc.dev/task-run-id-digest": kubernetesRunIdDigest(runId), "sdlc.dev/configuration-digest": configurationDigest, "sdlc.dev/content-archive-sha256": archiveSha256, "sdlc.dev/content-tree-sha256": treeSha256, "sdlc.dev/object-role": role }; }

export function renderPod(input: { configuration: KubernetesConfiguration; demand: KubernetesComputeConstraints; runId: string; configurationDigest: string; archiveSha256: string; treeSha256: string; deliveryNames: string[] }): any {
  requireKubernetesPodSpecObject(input.configuration.podTemplate.spec);
  const { configuration, demand } = input; const pod = clone(configuration.podTemplate) as any; const names = objectNames(input.runId, input.configurationDigest);
  for (const key of [...Object.keys(pod.metadata.labels), ...Object.keys(pod.metadata.annotations)]) if (key.startsWith("sdlc.dev/")) throw new Error("kubernetes-reserved-metadata-collision");
  if (pod.spec.restartPolicy !== "Never" || pod.spec.automountServiceAccountToken !== false || pod.spec.serviceAccountName !== undefined) throw new Error("kubernetes-pod-policy-invalid");
  const containers = Array.isArray(pod.spec.containers) ? pod.spec.containers.filter((item: any) => item?.name === configuration.runnerContainerName) : [];
  if (containers.length !== 1) throw new Error("kubernetes-runner-container-not-unique");
  const runner = containers[0]; if (runner.command !== undefined || runner.args !== undefined) throw new Error("kubernetes-runner-command-authored");
  const requests = runner.resources?.requests; const limits = runner.resources?.limits; const gpu = demand.resources.gpu;
  if (pod.spec.nodeSelector?.["kubernetes.io/os"] !== demand.os || pod.spec.nodeSelector?.["kubernetes.io/arch"] !== demand.architecture || requests?.cpu !== demand.resources.requests.cpu || requests?.memory !== demand.resources.requests.memory || requests?.["ephemeral-storage"] !== demand.resources.requests.ephemeralStorage || limits?.cpu !== demand.resources.limits.cpu || limits?.memory !== demand.resources.limits.memory || limits?.["ephemeral-storage"] !== demand.resources.limits.ephemeralStorage || (gpu.mode === "extended-resource" && (requests?.[gpu.resourceName] !== gpu.quantity || limits?.[gpu.resourceName] !== gpu.quantity))) throw new Error("kubernetes-compute-resource-mismatch");
  const reserved = `${configuration.carriage.workspaceRoot}/.sdlc`; if ((runner.env ?? []).some((item: any) => String(item?.name).startsWith("SDLC_TASK_")) || (runner.volumeMounts ?? []).some((item: any) => String(item?.mountPath).startsWith(reserved))) throw new Error("kubernetes-runner-reserved-collision");
  const existingVolumes = new Set((pod.spec.volumes ?? []).map((item: any) => item?.name)); if (existingVolumes.has(configuration.workspaceVolumeName) || Array.from(existingVolumes).some((value) => String(value).startsWith("sdlc-"))) throw new Error("kubernetes-volume-collision");
  pod.metadata = { ...pod.metadata, name: names.pod, namespace: configuration.namespace.name, labels: { ...pod.metadata.labels, ...protectedLabels(input.runId, input.configurationDigest, input.archiveSha256, input.treeSha256, "pod") } };
  pod.spec.serviceAccountName = names.serviceAccount; pod.spec.automountServiceAccountToken = false;
  pod.spec.volumes = [...(pod.spec.volumes ?? []), { name: configuration.workspaceVolumeName, emptyDir: { sizeLimit: configuration.workspace.sizeLimit } }, ...input.deliveryNames.map((secretName, index) => ({ name: `sdlc-delivery-${index}`, secret: { secretName } })), { name: "sdlc-identity", projected: { sources: [{ serviceAccountToken: { audience: configuration.carriage.serviceAccountAudience, expirationSeconds: configuration.carriage.serviceAccountTokenExpirationSeconds, path: "token" } }, { configMap: { name: configuration.carriage.clusterCaConfigMapName, items: [{ key: "ca.crt", path: "ca.crt" }] } }] } }];
  runner.volumeMounts = [...(runner.volumeMounts ?? []), { name: configuration.workspaceVolumeName, mountPath: configuration.carriage.workspaceRoot }, ...input.deliveryNames.map((_, index) => ({ name: `sdlc-delivery-${index}`, mountPath: `${reserved}/delivery/${index}`, readOnly: true })), { name: "sdlc-identity", mountPath: `${reserved}/identity`, readOnly: true }];
  runner.command = [configuration.carriage.nodePath]; runner.args = [`${reserved}/delivery/kubernetes-carriage.mjs`, configuration.carriage.workspaceRoot];
  return pod;
}

const stripped = (value: any) => { const result = clone(value); if (result.metadata) for (const key of ["uid", "resourceVersion", "generation", "creationTimestamp", "managedFields"]) delete result.metadata[key]; delete result.status; return result; };
export function changedPointers(expected: unknown, actual: unknown): string[] {
  const changes: string[] = []; const walk = (left: any, right: any, path: string) => { if (Object.is(left, right)) return; if (Array.isArray(left) && Array.isArray(right)) { const length = Math.max(left.length, right.length); for (let i = 0; i < length; i++) walk(left[i], right[i], `${path}/${i}`); return; } if (left && right && typeof left === "object" && typeof right === "object") { for (const key of Array.from(new Set([...Object.keys(left), ...Object.keys(right)])).sort()) walk(left[key], right[key], `${path}/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`); return; } changes.push(path || "/"); }; walk(stripped(expected), stripped(actual), ""); return changes.sort();
}
