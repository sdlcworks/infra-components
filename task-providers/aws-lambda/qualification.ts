import { GetFunctionConfigurationCommand, GetFunctionEventInvokeConfigCommand, InvokeCommand } from "@aws-sdk/client-lambda";
import { taskProviderRefusal, type TaskEnactmentAccount, type TaskRealizationContext } from "@sdlcworks/components/task";
import { awsConfigurationDigest, canonical, classifyAwsError, getAwsObjectOptional, sha256 } from "../aws-common";
import type { AwsLambdaDependencies } from "./client";
import type { AwsLambdaAllocationState, AwsLambdaConfiguration, AwsLambdaCredentials, AwsLambdaRunState } from "./schema";

type Context = TaskRealizationContext<AwsLambdaConfiguration, AwsLambdaCredentials, AwsLambdaAllocationState, AwsLambdaRunState>;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const json = (value: unknown) => JSON.parse(JSON.stringify(value));

export function lambdaConfigurationDigest(output: any) {
  const configuration = {
    FunctionName: output.FunctionName,
    FunctionArn: output.FunctionArn,
    Runtime: output.Runtime,
    Role: output.Role,
    Handler: output.Handler,
    CodeSha256: output.CodeSha256,
    Version: output.Version,
    VpcConfig: output.VpcConfig,
    DeadLetterConfig: output.DeadLetterConfig,
    Environment: output.Environment,
    KMSKeyArn: output.KMSKeyArn,
    TracingConfig: output.TracingConfig,
    MasterArn: output.MasterArn,
    RevisionId: output.RevisionId,
    Layers: output.Layers,
    FileSystemConfigs: output.FileSystemConfigs,
    PackageType: output.PackageType,
    ImageConfigResponse: output.ImageConfigResponse,
    SigningProfileVersionArn: output.SigningProfileVersionArn,
    SigningJobArn: output.SigningJobArn,
    Architectures: output.Architectures,
    EphemeralStorage: output.EphemeralStorage,
    SnapStart: output.SnapStart,
    RuntimeVersionConfig: output.RuntimeVersionConfig,
    LoggingConfig: output.LoggingConfig,
    MemorySize: output.MemorySize,
    Timeout: output.Timeout,
  };
  return sha256(canonical(json(configuration)));
}

export function lambdaQualificationProbeIdentity(configurationDigest: string, bucket: string, prefix: string) {
  return sha256(canonical({ configurationDigest, bucket, prefix }));
}

export function lambdaQualificationProbe(configurationDigest: string, bucket: string, prefix: string, adapterVersionArn: string) {
  const probeIdentity = lambdaQualificationProbeIdentity(configurationDigest, bucket, prefix);
  const association = { runDigest: probeIdentity, configurationDigest, archiveSha256: "0".repeat(64), treeSha256: "0".repeat(64), runnerSha256: "0".repeat(64) };
  return { version: 1, kind: "qualification", adapterVersionArn, probeIdentity, bucket, prefix, key: `qualification/${probeIdentity}.json`, association };
}

export function lambdaQualificationRecord(configurationDigest: string, bucket: string, prefix: string, adapterVersionArn: string) {
  const probe = lambdaQualificationProbe(configurationDigest, bucket, prefix, adapterVersionArn);
  const record = { version: 1, adapterVersionArn, probeIdentity: probe.probeIdentity };
  return { ...record, digest: sha256(canonical(record)) };
}

export function lambdaQualificationRecordDigest(configurationDigest: string, bucket: string, prefix: string, adapterVersionArn: string) {
  return sha256(encoder.encode(JSON.stringify(lambdaQualificationRecord(configurationDigest, bucket, prefix, adapterVersionArn))));
}

export function lambdaQualificationProbeRecordedBody(configurationDigest: string, bucket: string, prefix: string, adapterVersionArn: string) {
  const bytes = encoder.encode(canonical(lambdaQualificationProbe(configurationDigest, bucket, prefix, adapterVersionArn)));
  return { base64: Buffer.from(bytes).toString("base64"), utf8: decoder.decode(bytes) };
}

export function lambdaEventInvokeConfigurationDigest(output: any) {
  return sha256(canonical(json({ DestinationConfig: output.DestinationConfig, MaximumEventAgeInSeconds: output.MaximumEventAgeInSeconds, MaximumRetryAttempts: output.MaximumRetryAttempts })));
}

function exactFunction(configuration: AwsLambdaConfiguration, output: any, adapter: boolean) {
  const expectedArn = adapter ? configuration.terminalTestimony.adapterVersionArn : configuration.function.versionArn;
  const expectedRevision = adapter ? configuration.terminalTestimony.adapterRevisionId : configuration.function.revisionId;
  const expectedCode = adapter ? configuration.terminalTestimony.adapterCodeSha256 : configuration.function.codeSha256;
  const expectedRole = adapter ? configuration.terminalTestimony.adapterRoleArn : configuration.function.roleArn;
  const expectedDigest = adapter ? configuration.terminalTestimony.adapterConfigurationSha256 : configuration.function.configurationSha256;
  const variables = output.Environment?.Variables ?? {};
  if (output.FunctionArn !== expectedArn || output.RevisionId !== expectedRevision || output.CodeSha256 !== expectedCode || output.Role !== expectedRole || lambdaConfigurationDigest(output) !== expectedDigest) return false;
  if (adapter) return variables.SDLC_TASK_DESTINATION_PROTOCOL === configuration.terminalTestimony.adapterProtocolVersion;
  return output.State === "Active" && output.PackageType === "Image" && output.Architectures?.length === 1 && output.Architectures[0] === configuration.function.architecture && output.MemorySize === configuration.function.memoryMiB && output.EphemeralStorage?.Size === configuration.function.ephemeralStorageMiB && output.Timeout === configuration.function.nativeTimeoutSeconds && (output.VpcConfig?.SubnetIds?.length ?? 0) === 0 && (output.VpcConfig?.SecurityGroupIds?.length ?? 0) === 0 && variables.SDLC_TASK_PROTOCOL === configuration.function.protocolVersion && variables.SDLC_TASK_BOOTSTRAP_ID === configuration.function.bootstrapIdentity && sha256(canonical(variables)) === configuration.function.environmentSha256;
}

function base(context: Context) {
  return { version: 1 as const, actIdentity: context.actIdentity, runId: context.runId, allocationState: context.allocationState, runState: context.runState, providerTestimony: { kind: "silent" as const }, environmentStatus: context.environmentStatus, retention: null };
}

export function createProvisionAllocations(dependencies: AwsLambdaDependencies) {
  return async (context: Context): Promise<TaskEnactmentAccount<AwsLambdaAllocationState, AwsLambdaRunState>> => {
    const account = base(context);
    try {
      const configuration = context.configuration;
      const [task, adapter, event] = await Promise.all([
        dependencies.lambda.send(new GetFunctionConfigurationCommand({ FunctionName: configuration.function.versionArn })),
        dependencies.lambda.send(new GetFunctionConfigurationCommand({ FunctionName: configuration.terminalTestimony.adapterVersionArn })),
        dependencies.lambda.send(new GetFunctionEventInvokeConfigCommand({ FunctionName: configuration.function.versionArn, Qualifier: configuration.function.versionArn.split(":").slice(-1)[0] })),
      ]);
      const destinations = event.DestinationConfig;
      const eventExact = destinations?.OnSuccess?.Destination === configuration.terminalTestimony.adapterVersionArn && destinations?.OnFailure?.Destination === configuration.terminalTestimony.adapterVersionArn && event.MaximumEventAgeInSeconds === configuration.terminalTestimony.maximumEventAgeSeconds && event.MaximumRetryAttempts === configuration.terminalTestimony.maximumRetryAttempts;
      if (!exactFunction(configuration, task, false) || !exactFunction(configuration, adapter, true) || !eventExact)
        return { ...account, outcome: taskProviderRefusal("aws-lambda-terminal-testimony-unqualified", json({ task, adapter, event })) };
      const configurationDigest = awsConfigurationDigest(configuration);
      const probeIdentity = lambdaQualificationProbeIdentity(configurationDigest, configuration.statusCarriage.bucket, configuration.statusCarriage.prefix);
      const relativeKey = `qualification/${probeIdentity}.json`;
      const association = { runDigest: probeIdentity, configurationDigest, archiveSha256: "0".repeat(64), treeSha256: "0".repeat(64), runnerSha256: "0".repeat(64) };
      const probe = lambdaQualificationProbe(configurationDigest, configuration.statusCarriage.bucket, configuration.statusCarriage.prefix, configuration.terminalTestimony.adapterVersionArn);
      const response = await dependencies.lambda.send(new InvokeCommand({ FunctionName: configuration.terminalTestimony.adapterVersionArn, InvocationType: "RequestResponse", Payload: encoder.encode(canonical(probe)) }));
      if (response.StatusCode !== 200 || response.FunctionError) return { ...account, outcome: taskProviderRefusal("aws-lambda-terminal-testimony-unqualified", json(response)) };
      const location = { bucket: configuration.statusCarriage.bucket, runPrefix: configuration.statusCarriage.prefix, maximumObjectBytes: configuration.statusCarriage.maximumObjectBytes };
      const deadline = dependencies.now().getTime() + configuration.terminalTestimony.qualificationProbeTimeoutMilliseconds;
      let bytes: Uint8Array | null = null;
      while (dependencies.now().getTime() <= deadline && bytes === null) { bytes = await getAwsObjectOptional(dependencies.s3, location, relativeKey, association); if (bytes === null) await dependencies.sleep(10); }
      if (bytes === null) return { ...account, outcome: taskProviderRefusal("aws-lambda-terminal-testimony-unqualified", null) };
      const record = JSON.parse(decoder.decode(bytes));
      const { digest: recordDigest, ...recordWithoutDigest } = record;
      if (record.version !== 1 || record.adapterVersionArn !== probe.adapterVersionArn || record.probeIdentity !== probeIdentity || recordDigest !== sha256(canonical(recordWithoutDigest))) return { ...account, outcome: taskProviderRefusal("aws-lambda-terminal-testimony-unqualified", json(record)) };
      const allocationState: AwsLambdaAllocationState = { version: 1, configurationDigest, function: { versionArn: configuration.function.versionArn, revisionId: configuration.function.revisionId, codeSha256: configuration.function.codeSha256 }, destination: { adapterVersionArn: configuration.terminalTestimony.adapterVersionArn, adapterRevisionId: configuration.terminalTestimony.adapterRevisionId, adapterCodeSha256: configuration.terminalTestimony.adapterCodeSha256, eventInvokeConfigurationDigest: lambdaEventInvokeConfigurationDigest(event), qualificationProbeDigest: sha256(bytes) } };
      return { ...account, allocationState, providerTestimony: { kind: "witnessed", standing: "live", observedAt: dependencies.now().toISOString(), native: json({ task, adapter, event, probe: record }) }, outcome: { kind: "witnessed" } };
    } catch (error) { return { ...account, outcome: classifyAwsError("QualifyLambda", "read", error) }; }
  };
}
