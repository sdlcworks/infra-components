import { InvokeCommand } from "@aws-sdk/client-lambda";
import { GetObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { taskProviderLostAnswer, taskProviderRefusal, type JSONValue, type ProviderTestimony, type TaskEnactmentAccount, type TaskRealizationContext } from "@sdlcworks/components/task";
import { awsConfigurationDigest, canonical, classifyAwsError, readAwsEnvironmentStatus, selectRunner, sha256, stageAwsDelivery, writeAwsCommandImmutable } from "../aws-common";
import type { AwsLambdaDependencies } from "./client";
import { AwsLambdaAllocationStateSchema, AwsLambdaConfigurationSchema, AwsLambdaCredentialsSchema, AwsLambdaRunStateSchema, type AwsLambdaAllocationState, type AwsLambdaConfiguration, type AwsLambdaCredentials, type AwsLambdaRunState } from "./schema";

type Context = TaskRealizationContext<AwsLambdaConfiguration, AwsLambdaCredentials, AwsLambdaAllocationState, AwsLambdaRunState>;
type Account = TaskEnactmentAccount<AwsLambdaAllocationState, AwsLambdaRunState>;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const native = (value: unknown): JSONValue => JSON.parse(JSON.stringify(value)) as JSONValue;

export function lambdaInvocationPayload(runId: string, functionVersionArn: string, bucket: string, prefix: string, deliveryDigest: string, adapterVersionArn: string, maximumRecordBytes: number) {
  return { version: 1, runId, functionVersionArn, delivery: { bucket, prefix, deliveryDigest }, terminal: { adapterVersionArn, bucket, prefix, maximumRecordBytes } };
}

export function lambdaInvocationPayloadDigest(runId: string, functionVersionArn: string, bucket: string, prefix: string, deliveryDigest: string, adapterVersionArn: string, maximumRecordBytes: number) {
  return sha256(canonical(lambdaInvocationPayload(runId, functionVersionArn, bucket, prefix, deliveryDigest, adapterVersionArn, maximumRecordBytes)));
}

export function lambdaInvocationRecordedBody(runId: string, functionVersionArn: string, bucket: string, prefix: string, deliveryDigest: string, adapterVersionArn: string, maximumRecordBytes: number) {
  const text = canonical(lambdaInvocationPayload(runId, functionVersionArn, bucket, prefix, deliveryDigest, adapterVersionArn, maximumRecordBytes));
  return { base64: Buffer.from(text).toString("base64"), utf8: text };
}

function account(context: Context, additions: Partial<Account>): Account {
  return { version: 1, actIdentity: context.actIdentity, runId: context.runId, allocationState: context.allocationState, runState: context.runState, providerTestimony: { kind: "silent" }, environmentStatus: context.environmentStatus, retention: null, outcome: { kind: "witnessed" }, ...additions };
}

function validate(context: Context) {
  const configuration = AwsLambdaConfigurationSchema.parse(context.configuration);
  AwsLambdaCredentialsSchema.parse(context.credentials);
  const allocation = AwsLambdaAllocationStateSchema.parse(context.allocationState);
  if (allocation.configurationDigest !== awsConfigurationDigest(configuration) || allocation.function.versionArn !== configuration.function.versionArn || allocation.function.revisionId !== configuration.function.revisionId || allocation.function.codeSha256 !== configuration.function.codeSha256 || allocation.destination.adapterVersionArn !== configuration.terminalTestimony.adapterVersionArn)
    throw taskProviderRefusal("aws-lambda-allocation-qualification-conflict", null);
  const run = context.runState === null ? null : AwsLambdaRunStateSchema.parse(context.runState);
  if (run && (run.runId !== context.runId || run.functionVersionArn !== configuration.function.versionArn)) throw taskProviderRefusal("aws-lambda-run-association-conflict", null);
  return { configuration, allocation, run };
}

async function body(output: any) {
  if (output.Body instanceof Uint8Array) return output.Body;
  if (output.Body?.transformToByteArray) return new Uint8Array(await output.Body.transformToByteArray());
  throw taskProviderRefusal("aws-lambda-native-record-unreadable", null);
}

async function optionalJson(dependencies: AwsLambdaDependencies, bucket: string, key: string) {
  try { return JSON.parse(decoder.decode(await body(await dependencies.s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }))))); }
  catch (error) { if (/NoSuchKey|NotFound/.test(String((error as any)?.name ?? (error as any)?.code ?? ""))) return null; throw error; }
}

async function providerEvidence(dependencies: AwsLambdaDependencies, context: Context, run: AwsLambdaRunState): Promise<{ testimony: ProviderTestimony; refusal: ReturnType<typeof taskProviderRefusal> | null }> {
  const claim = await optionalJson(dependencies, run.carriage.bucket, `${run.carriage.runPrefix}/lambda-claim.json`);
  let records: any[] = [];
  if (claim) {
    const record = await optionalJson(dependencies, run.carriage.bucket, `${run.carriage.runPrefix}/lambda-terminal/${claim.requestId}.json`);
    if (record) records = [record];
  } else {
    const listed = await dependencies.s3.send(new ListObjectsV2Command({ Bucket: run.carriage.bucket, Prefix: `${run.carriage.runPrefix}/lambda-terminal/` }));
    for (const item of listed.Contents ?? []) if (item.Key) { const record = await optionalJson(dependencies, run.carriage.bucket, item.Key); if (record) records.push(record); }
  }
  const correlated = (record: any) => record.runId === context.runId && record.functionVersionArn === run.functionVersionArn && (!claim || record.requestId === claim.requestId);
  if ((claim && (claim.runId !== context.runId || claim.functionVersionArn !== run.functionVersionArn)) || records.some((record) => !correlated(record))) return { testimony: { kind: "witnessed", standing: "conflict", observedAt: dependencies.now().toISOString(), native: native({ claim, records }) }, refusal: taskProviderRefusal("aws-lambda-terminal-association-conflict", null) };
  if (!claim && records.length > 1) return { testimony: { kind: "witnessed", standing: "conflict", observedAt: dependencies.now().toISOString(), native: native({ claim, records }) }, refusal: taskProviderRefusal("aws-lambda-terminal-ambiguous", null) };
  if (records.length === 1) return { testimony: { kind: "witnessed", standing: "gone", observedAt: dependencies.now().toISOString(), native: native({ claim, terminal: records[0] }) }, refusal: null };
  if (claim) return { testimony: { kind: "witnessed", standing: "live", observedAt: dependencies.now().toISOString(), native: native({ claim }) }, refusal: null };
  return { testimony: { kind: "silent" }, refusal: null };
}

export function createLaunch(dependencies: AwsLambdaDependencies) {
  return async (context: Context): Promise<Account> => {
    try {
      const { configuration, run } = validate(context);
      if (run) return createObserve(dependencies)(context);
      const runner = selectRunner(configuration.function.architecture, context.runners);
      const carriage = await stageAwsDelivery({ s3: dependencies.s3, carriage: configuration.statusCarriage, runId: context.runId, configuration, definition: context.definition, inputDocument: context.inputDocument, runner, guestProgram: new Uint8Array(), fetchContent: dependencies.fetchContent });
      const payload = lambdaInvocationPayload(context.runId, configuration.function.versionArn, carriage.bucket, carriage.runPrefix, carriage.deliverySha256, configuration.terminalTestimony.adapterVersionArn, configuration.terminalTestimony.maximumRecordBytes);
      const payloadBytes = encoder.encode(canonical(payload));
      if (payloadBytes.byteLength > 262144) return account(context, { outcome: taskProviderRefusal("aws-lambda-invocation-payload-too-large", null) });
      const stateBase = { version: 1 as const, runId: context.runId, functionVersionArn: configuration.function.versionArn, invocationPayloadSha256: sha256(payloadBytes), carriage };
      try {
        const response = await dependencies.lambda.send(new InvokeCommand({ FunctionName: configuration.function.versionArn, InvocationType: "Event", Payload: payloadBytes }));
        if (response.StatusCode !== 202) return account(context, { outcome: taskProviderLostAnswer("Invoke", native(response)) });
        return account(context, { runState: { ...stateBase, launch: "accepted" }, providerTestimony: { kind: "witnessed", standing: "pending", observedAt: dependencies.now().toISOString(), native: native(response) } });
      } catch (error) {
        const outcome = classifyAwsError("Invoke", "mutation", error);
        return account(context, { runState: outcome.kind === "lost-answer" ? { ...stateBase, launch: "lost-answer" } : null, outcome });
      }
    } catch (error) { return account(context, { outcome: typeof error === "object" && error !== null && "kind" in error ? error as any : classifyAwsError("Launch", "mutation", error) }); }
  };
}

export function createObserve(dependencies: AwsLambdaDependencies) {
  return async (context: Context): Promise<Account> => {
    try {
      const { run } = validate(context);
      if (!run) return account(context, { outcome: taskProviderRefusal("aws-lambda-run-state-required", null) });
      const [environmentStatus, evidence] = await Promise.all([readAwsEnvironmentStatus(dependencies.s3, run.carriage), providerEvidence(dependencies, context, run)]);
      return account(context, { environmentStatus, providerTestimony: evidence.testimony, outcome: evidence.refusal ?? { kind: "witnessed" } });
    } catch (error) { return account(context, { outcome: typeof error === "object" && error !== null && "kind" in error ? error as any : classifyAwsError("Observe", "read", error) }); }
  };
}

export function createCancel(dependencies: AwsLambdaDependencies) {
  return async (context: Context): Promise<Account> => {
    try {
      const { run } = validate(context);
      if (!run) return account(context, { outcome: taskProviderRefusal("aws-lambda-run-state-required", null) });
      const commandId = sha256(canonical({ actIdentity: context.actIdentity, command: "cancel" }));
      const carriage = await writeAwsCommandImmutable(dependencies.s3, run.carriage, { version: 1, commandId, command: "cancel" });
      return createObserve(dependencies)({ ...context, runState: { ...run, carriage } });
    } catch (error) { return account(context, { outcome: typeof error === "object" && error !== null && "kind" in error ? error as any : classifyAwsError("Cancel", "mutation", error) }); }
  };
}

export function createRetire(dependencies: AwsLambdaDependencies) {
  return async (context: Context): Promise<Account> => {
    const observed = await createObserve(dependencies)(context);
    if (observed.providerTestimony.kind === "witnessed" && observed.providerTestimony.standing === "gone") return observed;
    return { ...observed, outcome: taskProviderRefusal("aws-lambda-live-environment-not-retirable", null) };
  };
}
