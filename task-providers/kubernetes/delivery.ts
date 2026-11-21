import { canonicalize, bytesDigest } from "./canonical";
import { carriageSource } from "./carriage";
import type { KubernetesContext, KubernetesDependencies } from "./index";

export type DeliveryBlob = { name: string; bytes: Uint8Array; sha256: string };
export function kubernetesDeliverySha256(bytes: Uint8Array): string { return bytesDigest(bytes); }
export function kubernetesDeliveryPayload(bytes: Uint8Array): string { return Buffer.from(bytes).toString("base64"); }
export async function buildDelivery(context: KubernetesContext, dependencies: KubernetesDependencies): Promise<{ blobs: DeliveryBlob[]; chunks: Array<{ blob: string; ordinal: number; count: number; sha256: string; bytes: Uint8Array }> }> {
  const archive = await dependencies.fetchContent(context.definition.content.uri);
  if (bytesDigest(archive) !== context.definition.content.archiveSha256) throw new Error("kubernetes-archive-digest-mismatch");
  const selected = (context.definition.meta.computeConstraints as any).architecture === "arm64" ? context.runners.linuxArm64 : context.runners.linuxAmd64;
  const runner = await dependencies.readFile(selected.path);
  if (bytesDigest(runner) !== selected.sha256) throw new Error("kubernetes-runner-digest-mismatch");
  const input = new TextEncoder().encode(canonicalize(context.inputDocument));
  const carriage = new TextEncoder().encode(carriageSource());
  const blobs = [{ name: "task-archive", bytes: archive, sha256: kubernetesDeliverySha256(archive) }, { name: "runner", bytes: runner, sha256: kubernetesDeliverySha256(runner) }, { name: "input", bytes: input, sha256: kubernetesDeliverySha256(input) }, { name: "kubernetes-carriage.mjs", bytes: carriage, sha256: kubernetesDeliverySha256(carriage) }];
  if (blobs.reduce((sum, blob) => sum + blob.bytes.length, 0) > context.configuration.delivery.maximumBundleBytes) throw new Error("kubernetes-delivery-limit-exceeded");
  const chunks = blobs.flatMap((blob) => { const count = Math.ceil(blob.bytes.length / context.configuration.delivery.chunkBytes) || 1; return Array.from({ length: count }, (_, ordinal) => ({ blob: blob.name, ordinal, count, sha256: blob.sha256, bytes: blob.bytes.slice(ordinal * context.configuration.delivery.chunkBytes, (ordinal + 1) * context.configuration.delivery.chunkBytes) })); });
  return { blobs, chunks };
}
