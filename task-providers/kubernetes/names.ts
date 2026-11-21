import { createHash } from "node:crypto";

const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
function base32(bytes: Uint8Array): string {
  let bits = 0, value = 0, output = "";
  for (const byte of Array.from(bytes)) { value = (value << 8) | byte; bits += 8; while (bits >= 5) { output += alphabet[(value >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits) output += alphabet[(value << (5 - bits)) & 31];
  return output;
}
export function kubernetesRunSuffix(runId: string, configurationDigest: string): string { return base32(createHash("sha256").update(`sdlc-kubernetes-v1\0${runId}\0${configurationDigest}`).digest()).slice(0, 20); }
export const runSuffix = kubernetesRunSuffix;
const name = (role: string, suffix: string) => `sdlc-${role}-${suffix}`.slice(0, 63).replace(/[-.]$/, "");
export function objectNames(runId: string, configurationDigest: string) {
  const suffix = kubernetesRunSuffix(runId, configurationDigest);
  return { suffix, pod: name("task", suffix), serviceAccount: name("task-sa", suffix), role: name("task-role", suffix), roleBinding: name("task-binding", suffix), commandSecret: name("task-command", suffix), deliverySecret: (ordinal: number) => name(`task-delivery-${ordinal}`, suffix), statusSecret: (ordinal: number) => name(`task-status-${ordinal}`, suffix) };
}
