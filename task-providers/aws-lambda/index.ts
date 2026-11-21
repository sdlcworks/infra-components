import { TaskProvider, taskProviderRefusal, type TaskProviderLifecycleHandler } from "@sdlcworks/components/task";
import { createAwsLambdaClients, type AwsLambdaDependencies } from "./client";
import { createProvisionAllocations } from "./qualification";
import { createCancel, createLaunch, createObserve, createRetire } from "./lifecycle";
import { AwsLambdaAllocationStateSchema, AwsLambdaComputeConstraintsSchema, AwsLambdaConfigurationSchema, AwsLambdaCredentialsSchema, AwsLambdaRunStateSchema, type AwsLambdaAllocationState, type AwsLambdaConfiguration, type AwsLambdaCredentials, type AwsLambdaRunState } from "./schema";
import { awsConfigurationDigest } from "../aws-common";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

type Handler = TaskProviderLifecycleHandler<AwsLambdaConfiguration, AwsLambdaCredentials, AwsLambdaAllocationState, AwsLambdaRunState>;

export function createAwsLambdaProvider(dependencies: AwsLambdaDependencies, handlers: Partial<Record<"provisionAllocations" | "launch" | "observe" | "cancel" | "retire", Handler>> = {}) {
  return new TaskProvider<AwsLambdaConfiguration, AwsLambdaCredentials, AwsLambdaAllocationState, AwsLambdaRunState>({
    configurationSchema: AwsLambdaConfigurationSchema,
    credentialSchema: AwsLambdaCredentialsSchema,
    allocationStateSchema: AwsLambdaAllocationStateSchema,
    runStateSchema: AwsLambdaRunStateSchema,
    computeConstraintsSchema: AwsLambdaComputeConstraintsSchema,
    capabilities: { "provision-allocations": true, launch: true, observe: true, pause: false, resume: false, cancel: true, retire: true },
    runtimeEnvelope: { maximumRuntimeSeconds: 900, admitsTimeoutAbsent: false },
    admitTask: ({ definitionMeta, computeDemand, relationshipConfig, allocationState }) => {
      const demand = AwsLambdaComputeConstraintsSchema.parse(computeDemand);
      const ceiling = relationshipConfig.function.nativeTimeoutSeconds - relationshipConfig.function.bootstrapReserveSeconds;
      const refused = allocationState.configurationDigest !== awsConfigurationDigest(relationshipConfig) || relationshipConfig.function.bootstrapReserveSeconds >= relationshipConfig.function.nativeTimeoutSeconds || definitionMeta.timeout.mode === "absent" || definitionMeta.timeout.seconds > ceiling || demand.system.architecture !== relationshipConfig.function.architecture || demand.memoryMiB > relationshipConfig.function.memoryMiB || demand.ephemeralStorageMiB > relationshipConfig.function.ephemeralStorageMiB;
      return refused ? taskProviderRefusal("aws-lambda-task-demand-not-admitted", null) : { kind: "admitted", nativeRuntimeCeiling: { mode: "finite", seconds: ceiling } };
    },
    handlers: { provisionAllocations: handlers.provisionAllocations ?? createProvisionAllocations(dependencies), launch: handlers.launch ?? createLaunch(dependencies), observe: handlers.observe ?? createObserve(dependencies), cancel: handlers.cancel ?? createCancel(dependencies), retire: handlers.retire ?? createRetire(dependencies) },
  });
}

const invocationDependencies = (configuration: AwsLambdaConfiguration, credentials: AwsLambdaCredentials): AwsLambdaDependencies => ({ ...createAwsLambdaClients(configuration, credentials), now: () => new Date(), sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)), fetchContent: async (uri) => uri.startsWith("file:") ? new Uint8Array(await readFile(fileURLToPath(uri))) : uri.startsWith("/") ? new Uint8Array(await readFile(uri)) : new Uint8Array(await (await fetch(uri)).arrayBuffer()) });
const invocationHandler = (factory: (dependencies: AwsLambdaDependencies) => Handler): Handler => async (context) => factory(invocationDependencies(AwsLambdaConfigurationSchema.parse(context.configuration), AwsLambdaCredentialsSchema.parse(context.credentials)))(context);
export default createAwsLambdaProvider({} as AwsLambdaDependencies, {
  provisionAllocations: invocationHandler(createProvisionAllocations),
  launch: invocationHandler(createLaunch),
  observe: invocationHandler(createObserve),
  cancel: invocationHandler(createCancel),
  retire: invocationHandler(createRetire),
});
