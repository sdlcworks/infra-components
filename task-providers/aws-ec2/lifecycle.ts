import {
  DeleteVolumeCommand,
  DescribeInstancesCommand,
  DescribeVolumesCommand,
  StartInstancesCommand,
  StopInstancesCommand,
  TerminateInstancesCommand,
} from "@aws-sdk/client-ec2";
import {
  taskProviderLostAnswer,
  taskProviderRefusal,
  type JSONValue,
  type ProviderTestimony,
  type TaskEnactmentAccount,
  type TaskRealizationContext,
} from "@sdlcworks/components/task";
import {
  classifyAwsError,
  readAwsEnvironmentStatus,
  sha256,
  writeAwsCommandImmutable,
} from "../aws-common";
import type { AwsEc2Dependencies } from "./index";
import type { AwsEc2AllocationState, AwsEc2Configuration, AwsEc2Credentials, AwsEc2RunState } from "./schemas";

type Context = TaskRealizationContext<AwsEc2Configuration, AwsEc2Credentials, AwsEc2AllocationState, AwsEc2RunState>;
type Account = TaskEnactmentAccount<AwsEc2AllocationState, AwsEc2RunState>;

const protectedTags = {
  run: "sdlc:run-digest",
  configuration: "sdlc:configuration-digest",
  archive: "sdlc:archive-sha256",
  tree: "sdlc:tree-sha256",
  token: "sdlc:client-token",
};
const nativeJSON = (value: unknown): JSONValue => JSON.parse(JSON.stringify(value)) as JSONValue;

function account(context: Context, additions: Partial<Account>): Account {
  return {
    version: 1,
    actIdentity: context.actIdentity,
    runId: context.runId,
    allocationState: context.allocationState,
    runState: context.runState,
    providerTestimony: { kind: "silent" },
    environmentStatus: context.environmentStatus,
    retention: null,
    outcome: { kind: "witnessed" },
    ...additions,
  };
}

function standing(state: string, paused: boolean): Exclude<ProviderTestimony, { kind: "silent" }>["standing"] {
  if (state === "pending") return "pending";
  if (state === "running") return "live";
  if (state === "stopped") return paused ? "paused" : "conflict";
  if (state === "stopping" || state === "shutting-down") return "terminal";
  if (state === "terminated" || state === "missing") return "gone";
  return "conflict";
}

export async function readScopedInstance(
  dependencies: AwsEc2Dependencies,
  context: Context,
): Promise<{ kind: "found"; output: any; instance: any } | { kind: "missing"; native: JSONValue } | { kind: "conflict"; native: JSONValue }> {
  const runState = context.runState;
  const allocation = context.allocationState;
  if (!runState || !allocation) throw taskProviderRefusal("ec2-run-state-required", null);
  let output: any;
  try {
    output = await dependencies.ec2.send(new DescribeInstancesCommand({ InstanceIds: [runState.instanceId] }));
  } catch (error) {
    const code = String((error as { name?: unknown; code?: unknown }).name ?? (error as { code?: unknown }).code ?? "");
    if (/InvalidInstanceID\.NotFound|NotFound/.test(code)) return { kind: "missing", native: nativeJSON({ state: "missing", instanceId: runState.instanceId }) };
    throw classifyAwsError("DescribeInstances", "read", error);
  }
  const instances = (output.Reservations ?? []).flatMap((reservation: any) => reservation.Instances ?? []);
  if (instances.length === 0) return { kind: "missing", native: nativeJSON(output) };
  const instance = instances[0];
  const tags = Object.fromEntries((instance.Tags ?? []).map((tag: any) => [tag.Key, tag.Value]));
  const mappings = instance.BlockDeviceMappings ?? [];
  const attachedMatches = runState.attachedVolumeId === null || mappings.some((mapping: any) => mapping.Ebs?.VolumeId === runState.attachedVolumeId);
  const exact =
    instances.length === 1 &&
    instance.InstanceId === runState.instanceId &&
    instance.ClientToken === runState.clientToken &&
    instance.ImageId === allocation.image.id &&
    instance.InstanceType === allocation.instanceType.name &&
    instance.SubnetId === allocation.network.subnetId &&
    instance.IamInstanceProfile?.Arn === allocation.instanceProfileArn &&
    instance.HibernationOptions?.Configured === true &&
    mappings.some((mapping: any) => mapping.Ebs?.VolumeId === runState.rootVolumeId) &&
    attachedMatches &&
    tags[protectedTags.run] === sha256(context.runId) &&
    tags[protectedTags.configuration] === runState.configurationDigest &&
    tags[protectedTags.archive] === context.definition.content.archiveSha256 &&
    tags[protectedTags.tree] === context.definition.content.treeSha256 &&
    tags[protectedTags.token] === runState.clientToken;
  return exact ? { kind: "found", output, instance } : { kind: "conflict", native: nativeJSON(output) };
}

async function environment(dependencies: AwsEc2Dependencies, context: Context) {
  return context.runState
    ? readAwsEnvironmentStatus(dependencies.s3, context.runState.carriage)
    : context.environmentStatus;
}

export function createObserve(dependencies: AwsEc2Dependencies) {
  return async (context: Context): Promise<Account> => {
    try {
      const scoped = await readScopedInstance(dependencies, context);
      const environmentStatus = await environment(dependencies, context);
      if (scoped.kind === "missing")
        return account(context, { environmentStatus, providerTestimony: { kind: "witnessed", standing: "gone", observedAt: dependencies.now().toISOString(), native: scoped.native } });
      if (scoped.kind === "conflict")
        return account(context, { environmentStatus, providerTestimony: { kind: "witnessed", standing: "conflict", observedAt: dependencies.now().toISOString(), native: scoped.native }, outcome: taskProviderRefusal("ec2-run-scope-conflict", null) });
      const state = String(scoped.instance.State?.Name ?? "unknown");
      const runState = { ...context.runState!, lastProviderState: state as AwsEc2RunState["lastProviderState"] };
      return account(context, { runState, environmentStatus, providerTestimony: { kind: "witnessed", standing: standing(state, runState.pauseWitnessedAt !== null), observedAt: dependencies.now().toISOString(), native: nativeJSON(scoped.output) } });
    } catch (error) {
      if (typeof error === "object" && error !== null && "kind" in error) return account(context, { outcome: error as any });
      return account(context, { outcome: classifyAwsError("Observe", "read", error) });
    }
  };
}

async function pollState(dependencies: AwsEc2Dependencies, context: Context, wanted: string) {
  for (;;) {
    const scoped = await readScopedInstance(dependencies, context);
    if (scoped.kind !== "found") return scoped;
    if (scoped.instance.State?.Name === wanted) return scoped;
    await dependencies.sleep(context.configuration.lifecycle.providerPollMilliseconds);
  }
}

export function createPause(dependencies: AwsEc2Dependencies) {
  return async (context: Context): Promise<Account> => {
    try {
      const scoped = await readScopedInstance(dependencies, context);
      if (scoped.kind !== "found" || scoped.instance.State?.Name !== "running")
        return account(context, { outcome: taskProviderRefusal("ec2-pause-state-invalid", scoped.kind === "found" ? nativeJSON(scoped.output) : scoped.native) });
      const response = await dependencies.ec2.send(new StopInstancesCommand({ InstanceIds: [context.runState!.instanceId], Hibernate: true }));
      if (scoped.instance.HibernationOptions?.Configured !== true || response.StoppingInstances?.[0]?.InstanceId !== context.runState!.instanceId)
        return account(context, { outcome: taskProviderRefusal("ec2-hibernation-unwitnessed", nativeJSON(response)) });
      const stopped = await pollState(dependencies, context, "stopped");
      if (stopped.kind !== "found") return account(context, { outcome: taskProviderRefusal("ec2-hibernation-unwitnessed", stopped.native) });
      const pausedAt = dependencies.now();
      const runState = { ...context.runState!, lastProviderState: "stopped" as const, pauseWitnessedAt: pausedAt.toISOString() };
      return account(context, { runState, providerTestimony: { kind: "witnessed", standing: "paused", observedAt: pausedAt.toISOString(), native: nativeJSON(stopped.output) }, retention: { kind: "paused", expiresAt: new Date(pausedAt.getTime() + context.configuration.lifecycle.pausedRetentionSeconds * 1000).toISOString() } });
    } catch (error) {
      return account(context, { outcome: typeof error === "object" && error !== null && "kind" in error ? error as any : classifyAwsError("StopInstances", "mutation", error) });
    }
  };
}

export function createResume(dependencies: AwsEc2Dependencies) {
  return async (context: Context): Promise<Account> => {
    try {
      const scoped = await readScopedInstance(dependencies, context);
      if (scoped.kind !== "found" || scoped.instance.State?.Name !== "stopped" || context.runState?.pauseWitnessedAt === null)
        return account(context, { outcome: taskProviderRefusal("ec2-resume-state-invalid", scoped.kind === "found" ? nativeJSON(scoped.output) : scoped.native) });
      await dependencies.ec2.send(new StartInstancesCommand({ InstanceIds: [context.runState!.instanceId] }));
      const running = await pollState(dependencies, context, "running");
      if (running.kind !== "found") return account(context, { outcome: taskProviderLostAnswer("StartInstances", running.native) });
      const environmentStatus = await environment(dependencies, context);
      return account(context, { runState: { ...context.runState!, lastProviderState: "running", pauseWitnessedAt: null }, environmentStatus, providerTestimony: { kind: "witnessed", standing: "live", observedAt: dependencies.now().toISOString(), native: nativeJSON(running.output) } });
    } catch (error) {
      return account(context, { outcome: typeof error === "object" && error !== null && "kind" in error ? error as any : classifyAwsError("StartInstances", "mutation", error) });
    }
  };
}

async function terminate(dependencies: AwsEc2Dependencies, context: Context) {
  await dependencies.ec2.send(new TerminateInstancesCommand({ InstanceIds: [context.runState!.instanceId] }));
  return pollState(dependencies, context, "terminated");
}

export function createCancel(dependencies: AwsEc2Dependencies) {
  return async (context: Context): Promise<Account> => {
    if (!context.runState) return account(context, { outcome: taskProviderRefusal("ec2-run-state-required", null) });
    try {
      const commandId = sha256(`cancel\0${context.actIdentity}`);
      const carriage = await writeAwsCommandImmutable(dependencies.s3, context.runState.carriage, { version: 1, commandId, command: "cancel", graceMilliseconds: context.configuration.lifecycle.cancelGraceMilliseconds });
      const deadline = dependencies.now().getTime() + context.configuration.lifecycle.cancelGraceMilliseconds;
      let environmentStatus = await environment(dependencies, { ...context, runState: { ...context.runState, carriage } });
      while (!environmentStatus.entryExited && !environmentStatus.commandAcknowledgements.some((item) => item.commandId === commandId) && dependencies.now().getTime() < deadline) {
        await dependencies.sleep(context.configuration.lifecycle.providerPollMilliseconds);
        environmentStatus = await environment(dependencies, { ...context, runState: { ...context.runState, carriage } });
      }
      const terminal = await terminate(dependencies, context);
      const native = terminal.kind === "found" ? nativeJSON(terminal.output) : terminal.native;
      return account(context, { runState: { ...context.runState, carriage, commandSequence: carriage.lastCommandSequence, lastProviderState: terminal.kind === "missing" ? "missing" : "terminated" }, environmentStatus, providerTestimony: { kind: "witnessed", standing: terminal.kind === "conflict" ? "conflict" : terminal.kind === "missing" ? "gone" : "terminal", observedAt: dependencies.now().toISOString(), native }, outcome: terminal.kind === "conflict" ? taskProviderRefusal("ec2-run-scope-conflict", null) : { kind: "witnessed" } });
    } catch (error) {
      return account(context, { outcome: typeof error === "object" && error !== null && "kind" in error ? error as any : classifyAwsError("Cancel", "mutation", error) });
    }
  };
}

export function createRetire(dependencies: AwsEc2Dependencies) {
  return async (context: Context): Promise<Account> => {
    if (!context.runState) return account(context, { outcome: taskProviderRefusal("ec2-run-state-required", null) });
    try {
      const scoped = await readScopedInstance(dependencies, context);
      let terminal: Awaited<ReturnType<typeof pollState>> = scoped;
      if (scoped.kind === "found" && scoped.instance.State?.Name !== "terminated") terminal = await terminate(dependencies, context);
      if (terminal.kind === "conflict") return account(context, { providerTestimony: { kind: "witnessed", standing: "conflict", observedAt: dependencies.now().toISOString(), native: terminal.native }, outcome: taskProviderRefusal("ec2-run-scope-conflict", null) });
      const attached = context.configuration.attachedVolume;
      if (context.runState.attachedVolumeOwnership === "run" && context.runState.attachedVolumeId && attached.mode === "create-per-run" && attached.deleteOnRetire) {
        try {
          await dependencies.ec2.send(new DeleteVolumeCommand({ VolumeId: context.runState.attachedVolumeId }));
          await dependencies.ec2.send(new DescribeVolumesCommand({ VolumeIds: [context.runState.attachedVolumeId] }));
          return account(context, { outcome: taskProviderLostAnswer("DeleteVolume", { volumeId: context.runState.attachedVolumeId }) });
        } catch (error) {
          const code = String((error as { name?: unknown; code?: unknown }).name ?? (error as { code?: unknown }).code ?? "");
          if (!/NotFound|InvalidVolume\.NotFound/.test(code)) return account(context, { outcome: classifyAwsError("DeleteVolume", "mutation", error) });
        }
      }
      if (context.runState.attachedVolumeOwnership === "external" && context.runState.attachedVolumeId) {
        const volume = await dependencies.ec2.send(new DescribeVolumesCommand({ VolumeIds: [context.runState.attachedVolumeId] }));
        if (volume.Volumes?.[0]?.State !== "available") return account(context, { outcome: taskProviderRefusal("ec2-existing-volume-not-detached", nativeJSON(volume)) });
      }
      const native = terminal.kind === "found" ? nativeJSON(terminal.output) : terminal.native;
      return account(context, { runState: { ...context.runState, lastProviderState: terminal.kind === "missing" ? "missing" : "terminated" }, providerTestimony: { kind: "witnessed", standing: terminal.kind === "missing" ? "gone" : "terminal", observedAt: dependencies.now().toISOString(), native } });
    } catch (error) {
      return account(context, { outcome: typeof error === "object" && error !== null && "kind" in error ? error as any : classifyAwsError("Retire", "mutation", error) });
    }
  };
}
