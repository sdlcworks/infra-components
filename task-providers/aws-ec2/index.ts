import {
  TaskProvider,
  taskProviderRefusal,
  type TaskProviderLifecycleHandler,
} from "@sdlcworks/components/task";
import type { AwsCommonDependencies } from "../aws-common";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createAwsEc2Clients } from "./client";
import { createLaunch } from "./launch";
import {
  createCancel,
  createObserve,
  createPause,
  createResume,
  createRetire,
} from "./lifecycle";
import { createProvisionAllocations } from "./provision";
import {
  AwsEc2AllocationStateSchema,
  AwsEc2ComputeConstraintsSchema,
  AwsEc2ConfigurationSchema,
  AwsEc2CredentialsSchema,
  AwsEc2RunStateSchema,
  type AwsEc2AllocationState,
  type AwsEc2Configuration,
  type AwsEc2Credentials,
  type AwsEc2RunState,
} from "./schemas";

export type AwsEc2Dependencies = AwsCommonDependencies & {
  ec2: { send(command: unknown): Promise<any> };
  iam: { send(command: unknown): Promise<any> };
};

type Handler = TaskProviderLifecycleHandler<
  AwsEc2Configuration,
  AwsEc2Credentials,
  AwsEc2AllocationState,
  AwsEc2RunState
>;

export function createAwsEc2Provider(
  dependencies: AwsEc2Dependencies,
  handlers: Partial<Record<"provisionAllocations" | "launch" | "observe" | "pause" | "resume" | "cancel" | "retire", Handler>> = {},
) {
  const provisionAllocations = handlers.provisionAllocations ?? createProvisionAllocations(dependencies);
  const launch = handlers.launch ?? createLaunch(dependencies);
  return new TaskProvider<
    AwsEc2Configuration,
    AwsEc2Credentials,
    AwsEc2AllocationState,
    AwsEc2RunState
  >({
    configurationSchema: AwsEc2ConfigurationSchema,
    credentialSchema: AwsEc2CredentialsSchema,
    allocationStateSchema: AwsEc2AllocationStateSchema,
    runStateSchema: AwsEc2RunStateSchema,
    computeConstraintsSchema: AwsEc2ComputeConstraintsSchema,
    capabilities: {
      "provision-allocations": true,
      launch: true,
      observe: true,
      pause: true,
      resume: true,
      cancel: true,
      retire: true,
    },
    runtimeEnvelope: { maximumRuntimeSeconds: null, admitsTimeoutAbsent: true },
    admitTask: ({ computeDemand, relationshipConfig, allocationState }) => {
      const demand = AwsEc2ComputeConstraintsSchema.parse(computeDemand);
      const qualified = allocationState.qualifiedConstraints;
      const attached = relationshipConfig.attachedVolume.mode !== "none";
      const refused =
        demand.architecture !== qualified.architecture ||
        demand.minimumVcpus > qualified.vcpus ||
        demand.minimumMemoryMiB > qualified.memoryMiB ||
        demand.minimumWorkspaceGiB > qualified.workspaceGiB ||
        (demand.attachedVolume === "required" && !attached) ||
        (demand.attachedVolume === "forbidden" && attached);
      return refused
        ? taskProviderRefusal("ec2-compute-demand-not-admitted", null)
        : { kind: "admitted", nativeRuntimeCeiling: { mode: "unbounded" } };
    },
    handlers: {
      provisionAllocations,
      launch,
      observe: handlers.observe ?? createObserve(dependencies),
      pause: handlers.pause ?? createPause(dependencies),
      resume: handlers.resume ?? createResume(dependencies),
      cancel: handlers.cancel ?? createCancel(dependencies),
      retire: handlers.retire ?? createRetire(dependencies),
    },
  });
}

const invocationDependencies = (
  configuration: AwsEc2Configuration,
  credentials: AwsEc2Credentials,
): AwsEc2Dependencies => ({
  ...createAwsEc2Clients(configuration, credentials),
  now: () => new Date(),
  sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  fetchContent: async (uri) =>
    uri.startsWith("file:")
      ? new Uint8Array(await readFile(fileURLToPath(uri)))
      : uri.startsWith("/")
        ? new Uint8Array(await readFile(uri))
        : new Uint8Array(await (await fetch(uri)).arrayBuffer()),
});

const invocationHandler = (factory: (dependencies: AwsEc2Dependencies) => Handler): Handler =>
  async (context) =>
    factory(
      invocationDependencies(
        AwsEc2ConfigurationSchema.parse(context.configuration),
        AwsEc2CredentialsSchema.parse(context.credentials),
      ),
    )(context);

export default createAwsEc2Provider({} as AwsEc2Dependencies, {
  provisionAllocations: invocationHandler(createProvisionAllocations),
  launch: invocationHandler(createLaunch),
  observe: invocationHandler(createObserve),
  pause: invocationHandler(createPause),
  resume: invocationHandler(createResume),
  cancel: invocationHandler(createCancel),
  retire: invocationHandler(createRetire),
});
