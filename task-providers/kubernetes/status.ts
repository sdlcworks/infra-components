import type { EnvironmentStatusReport } from "@sdlcworks/components/task";
import type { KubernetesRunState } from "./schemas";

export function emptyEnvironmentStatus(): EnvironmentStatusReport { return { deliveryClaimed: null, entryStarted: null, entryExited: null, commandAcknowledgements: [] }; }
export function foldStatus(payloads: Uint8Array[], runState: KubernetesRunState, prior: EnvironmentStatusReport): { environmentStatus: EnvironmentStatusReport; lastSequence: number } {
  const text = payloads.map((item) => new TextDecoder().decode(item)).join(""); if (!text) return { environmentStatus: prior, lastSequence: runState.lastStatusSequence };
  const report: EnvironmentStatusReport = JSON.parse(JSON.stringify(prior)); let expected = runState.lastStatusSequence + 1;
  for (const line of text.split("\n").filter(Boolean)) {
    const frame = JSON.parse(line); if (frame.version !== 1 || frame.runId !== runState.runId || frame.sequence !== expected) throw new Error("kubernetes-status-frame-sequence"); expected++;
    if (frame.kind === "delivery-claimed") { if (report.deliveryClaimed && report.deliveryClaimed.at !== frame.at) throw new Error("kubernetes-status-contradiction"); report.deliveryClaimed = { at: frame.at }; }
    else if (frame.kind === "entry-started") { if (report.entryStarted && report.entryStarted.at !== frame.at) throw new Error("kubernetes-status-contradiction"); report.entryStarted = { at: frame.at }; }
    else if (frame.kind === "entry-exited") { if (report.entryExited) throw new Error("kubernetes-status-contradiction"); report.entryExited = { at: frame.at, exitEvidence: frame.exitEvidence, output: frame.output }; }
    else if (frame.kind === "command-acknowledgement") report.commandAcknowledgements.push({ commandId: frame.commandId, command: frame.command, acknowledgedAt: frame.acknowledgedAt, outcome: frame.outcome, detail: frame.detail });
    else throw new Error("kubernetes-status-frame-kind");
  }
  return { environmentStatus: report, lastSequence: expected - 1 };
}

export function podTestimony(pod: any, observedAt: string, expectedUid: string) {
  const uid = pod?.metadata?.uid; const restarts = (pod?.status?.containerStatuses ?? []).find((item: any) => item.name)?.restartCount ?? 0;
  const standing = uid !== expectedUid || restarts > 0 ? "conflict" : pod?.metadata?.deletionTimestamp ? "terminal" : pod?.status?.phase === "Pending" ? "pending" : pod?.status?.phase === "Running" ? "live" : pod?.status?.phase === "Succeeded" || pod?.status?.phase === "Failed" ? "terminal" : "pending";
  return { kind: "witnessed" as const, standing: standing as "pending" | "live" | "terminal" | "conflict", observedAt, native: { uid, resourceVersion: pod?.metadata?.resourceVersion, deletionTimestamp: pod?.metadata?.deletionTimestamp ?? null, status: pod?.status ?? {} } };
}
