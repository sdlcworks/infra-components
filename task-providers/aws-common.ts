import {
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import {
  taskProviderLostAnswer,
  taskProviderRefusal,
  type EnvironmentStatusReport,
  type JSONValue,
  type RunnerArtifactCatalogue,
  type TaskDefinitionRuntime,
  type TaskProviderLostAnswer,
  type TaskProviderRefusal,
} from "@sdlcworks/components/task";
import { createHash } from "node:crypto";
import { posix } from "node:path";
import { z } from "zod";

const digest = z.string().regex(/^[0-9a-f]{64}$/);
const cleanPrefix = z.string().min(1).superRefine((value, context) => {
  if (
    value.startsWith("/") ||
    posix.normalize(value) !== value ||
    value.split("/").some((part) => part === "" || part === "..") ||
    !/^[A-Za-z0-9._/-]+$/.test(value)
  )
    context.addIssue({ code: "custom", message: "aws-prefix-invalid" });
});

export const StaticAwsCredentialsSchema = z.strictObject({
  kind: z.literal("static"),
  accessKeyId: z.string().min(1),
  secretAccessKey: z.string().min(1),
  sessionToken: z.string().min(1).nullable(),
});
export type StaticAwsCredentials = z.infer<typeof StaticAwsCredentialsSchema>;

export const AwsClientSchema = z.strictObject({
  endpoint: z.discriminatedUnion("mode", [
    z.strictObject({ mode: z.literal("aws-standard") }),
    z
      .strictObject({ mode: z.literal("custom"), url: z.string().url() })
      .superRefine((value, context) => {
        const url = new URL(value.url);
        if (
          (url.protocol !== "http:" && url.protocol !== "https:") ||
          url.username !== "" ||
          url.password !== "" ||
          url.pathname !== "/" ||
          url.search !== "" ||
          url.hash !== ""
        )
          context.addIssue({ code: "custom", message: "aws-custom-endpoint-invalid" });
      }),
  ]),
  s3AddressingStyle: z.enum(["virtual-hosted", "path"]),
  connectionTimeoutMilliseconds: z.number().int().positive(),
  requestTimeoutMilliseconds: z.number().int().positive(),
  maximumAttempts: z.number().int().positive(),
});
export type AwsClient = z.infer<typeof AwsClientSchema>;

export const AwsStatusCarriageSchema = z.strictObject({
  bucket: z.string().min(3),
  prefix: cleanPrefix,
  maximumObjectBytes: z.number().int().positive(),
  retention: z.literal("retain"),
});
export type AwsStatusCarriage = z.infer<typeof AwsStatusCarriageSchema>;

export const AwsRunCarriageStateSchema = z.strictObject({
  version: z.literal(1),
  bucket: z.string(),
  runPrefix: z.string(),
  archiveSha256: digest,
  treeSha256: digest,
  runnerSha256: digest,
  deliverySha256: digest,
  lastEnvironmentSequence: z.number().int().nonnegative(),
  lastCommandSequence: z.number().int().nonnegative(),
});
export type AwsRunCarriageState = z.infer<typeof AwsRunCarriageStateSchema>;

export type AwsClientConfig = {
  region: string;
  credentials: {
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken?: string;
  };
  maxAttempts: number;
  requestHandler: NodeHttpHandler;
  endpoint?: string;
};

export function awsClientConfig(
  region: string,
  client: AwsClient,
  credentials: StaticAwsCredentials,
  requestHandler?: NodeHttpHandler,
): AwsClientConfig {
  const parsedClient = AwsClientSchema.parse(client);
  const parsedCredentials = StaticAwsCredentialsSchema.parse(credentials);
  return {
    region: z.string().min(1).parse(region),
    credentials: {
      accessKeyId: parsedCredentials.accessKeyId,
      secretAccessKey: parsedCredentials.secretAccessKey,
      ...(parsedCredentials.sessionToken === null
        ? {}
        : { sessionToken: parsedCredentials.sessionToken }),
    },
    maxAttempts: parsedClient.maximumAttempts,
    ...(parsedClient.endpoint.mode === "custom"
      ? { endpoint: parsedClient.endpoint.url }
      : {}),
    requestHandler:
      requestHandler ??
      new NodeHttpHandler({
        connectionTimeout: parsedClient.connectionTimeoutMilliseconds,
        requestTimeout: parsedClient.requestTimeoutMilliseconds,
      }),
  };
}

type AwsError = {
  name?: unknown;
  code?: unknown;
  Code?: unknown;
  message?: unknown;
  $metadata?: { requestId?: unknown; httpStatusCode?: unknown };
};

function errorDetail(error: AwsError): JSONValue {
  const code = String(error.name ?? error.code ?? error.Code ?? "UnknownAwsError");
  const requestId = error.$metadata?.requestId;
  const detail: Record<string, JSONValue> = {
    code,
    requestId: typeof requestId === "string" ? requestId : null,
  };
  if (code === "Error" && typeof error.message === "string" && error.message)
    detail.message = error.message;
  return detail;
}

export function classifyAwsError(
  operation: string,
  kind: "read" | "mutation",
  error: unknown,
): TaskProviderRefusal | TaskProviderLostAnswer {
  const candidate = (typeof error === "object" && error !== null
    ? error
    : {}) as AwsError;
  const code = String(candidate.name ?? candidate.code ?? candidate.Code ?? "");
  const detail = errorDetail(candidate);
  if (code === "IdempotentParameterMismatch")
    return taskProviderRefusal("aws-idempotency-conflict", detail);
  if (/AccessDenied|Unauthorized|AuthFailure/.test(code))
    return taskProviderRefusal("aws-access-denied", detail);
  if (/InvalidParameter|Validation|Malformed/.test(code))
    return taskProviderRefusal("aws-invalid-parameter", detail);
  if (/IncorrectState|ResourceInUse|OperationNotPermitted/.test(code))
    return taskProviderRefusal("aws-incompatible-resource-state", detail);
  if (/LimitExceeded|Quota|InsufficientInstanceCapacity/.test(code))
    return taskProviderRefusal("aws-quota-exceeded", detail);
  if (kind === "read" && /NotFound|NoSuch|Invalid.*NotFound/.test(code))
    return taskProviderRefusal("aws-resource-not-found", detail);
  if (
    /Timeout|RequestTimeout|Networking|ECONN|Throttl|SlowDown|ServiceUnavailable/.test(
      `${code} ${String(candidate.message ?? "")}`,
    )
  )
    return taskProviderLostAnswer(operation, detail);
  return kind === "mutation"
    ? taskProviderLostAnswer(operation, detail)
    : taskProviderRefusal("aws-read-failed", detail);
}

export function awsNativeJSON(value: unknown): JSONValue {
  return JSON.parse(JSON.stringify(value)) as JSONValue;
}

export type AwsObjectAssociation = {
  runDigest: string;
  configurationDigest: string;
  archiveSha256: string;
  treeSha256: string;
  runnerSha256: string;
};
export type AwsObjectLocation = {
  bucket: string;
  runPrefix: string;
  maximumObjectBytes: number;
};
export type S3Sender = Pick<S3Client, "send">;

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const sha256 = (bytes: Uint8Array | string) =>
  createHash("sha256").update(bytes).digest("hex");
const canonical = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
    .join(",")}}`;
};

export function awsConfigurationDigest(configuration: unknown): string {
  return sha256(canonical(configuration));
}

function associationMetadata(association: AwsObjectAssociation) {
  return {
    "run-digest": association.runDigest,
    "configuration-digest": association.configurationDigest,
    "archive-sha256": association.archiveSha256,
    "tree-sha256": association.treeSha256,
    "runner-sha256": association.runnerSha256,
  };
}

export function assertAwsObjectAssociation(
  metadata: Record<string, string> | undefined,
  expected: AwsObjectAssociation,
): void {
  const actual = metadata ?? {};
  for (const [key, value] of Object.entries(associationMetadata(expected)))
    if (actual[key] !== value)
      throw taskProviderRefusal("aws-object-association-conflict", { key });
}

async function bodyBytes(body: unknown): Promise<Uint8Array> {
  if (body instanceof Uint8Array) return body;
  if (
    typeof body === "object" &&
    body !== null &&
    "transformToByteArray" in body &&
    typeof body.transformToByteArray === "function"
  )
    return new Uint8Array(await body.transformToByteArray());
  throw taskProviderRefusal("aws-object-body-unreadable", null);
}

export async function putAwsObjectImmutable(
  s3: S3Sender,
  location: AwsObjectLocation,
  relativeKey: string,
  bytes: Uint8Array,
  association: AwsObjectAssociation,
): Promise<void> {
  if (bytes.byteLength > location.maximumObjectBytes)
    throw taskProviderRefusal("aws-object-too-large", {
      bytes: bytes.byteLength,
      maximumObjectBytes: location.maximumObjectBytes,
    });
  const key = `${location.runPrefix}/${relativeKey}`;
  try {
    await s3.send(
      new PutObjectCommand({
        Bucket: location.bucket,
        Key: key,
        Body: bytes,
        IfNoneMatch: "*",
        Metadata: associationMetadata(association),
      }),
    );
  } catch (error) {
    const code = (error as AwsError).name ?? (error as AwsError).code;
    if (code !== "PreconditionFailed")
      throw classifyAwsError("PutObject", "mutation", error);
    const existing = await s3.send(
      new GetObjectCommand({ Bucket: location.bucket, Key: key }),
    );
    assertAwsObjectAssociation(existing.Metadata, association);
    const existingBytes = await bodyBytes(existing.Body);
    if (
      existingBytes.byteLength !== bytes.byteLength ||
      !existingBytes.every((value, index) => value === bytes[index])
    )
      throw taskProviderRefusal("aws-object-content-conflict", { key: relativeKey });
  }
}

export async function getAwsObjectOptional(
  s3: S3Sender,
  location: AwsObjectLocation,
  relativeKey: string,
  association: AwsObjectAssociation,
): Promise<Uint8Array | null> {
  try {
    const output = await s3.send(
      new GetObjectCommand({
        Bucket: location.bucket,
        Key: `${location.runPrefix}/${relativeKey}`,
      }),
    );
    assertAwsObjectAssociation(output.Metadata, association);
    const bytes = await bodyBytes(output.Body);
    if (bytes.byteLength > location.maximumObjectBytes)
      throw taskProviderRefusal("aws-object-too-large", null);
    return bytes;
  } catch (error) {
    const code = String((error as AwsError).name ?? (error as AwsError).code ?? "");
    if (/NoSuchKey|NotFound/.test(code)) return null;
    if (
      typeof error === "object" &&
      error !== null &&
      "kind" in error &&
      ((error as { kind: unknown }).kind === "refusal" ||
        (error as { kind: unknown }).kind === "lost-answer")
    )
      throw error;
    throw classifyAwsError("GetObject", "read", error);
  }
}

export type AwsCommonDependencies = {
  s3: S3Sender;
  now: () => Date;
  sleep: (milliseconds: number) => Promise<void>;
  fetchContent: (uri: string) => Promise<Uint8Array>;
};

export function awsRunPrefix(
  carriage: AwsStatusCarriage,
  configurationDigest: string,
  runDigest: string,
): string {
  return `${carriage.prefix}/relationships/${configurationDigest}/runs/${runDigest}`;
}

export function awsDeliverySha256(delivery: Uint8Array): string {
  return sha256(delivery);
}

export function awsDeliveryDocument(
  runId: string,
  content: TaskDefinitionRuntime["content"],
  inputDocument: JSONValue,
  runnerSha256: string,
  bucket: string,
  runPrefix: string,
  association: AwsObjectAssociation,
): Uint8Array {
  return encoder.encode(
    canonical({
      version: 1,
      runId,
      content,
      inputDocument,
      runnerSha256,
      carriage: { bucket, runPrefix, association },
    }),
  );
}

export async function stageAwsDelivery(args: {
  s3: S3Sender;
  carriage: AwsStatusCarriage;
  runId: string;
  configuration: unknown;
  definition: TaskDefinitionRuntime;
  inputDocument: JSONValue;
  runner: { path: string; sha256: string };
  guestProgram: Uint8Array;
  fetchContent: (uri: string) => Promise<Uint8Array>;
}): Promise<AwsRunCarriageState> {
  const carriage = AwsStatusCarriageSchema.parse(args.carriage);
  const archive = await args.fetchContent(args.definition.content.uri);
  if (archive.byteLength > carriage.maximumObjectBytes)
    throw taskProviderRefusal("aws-object-too-large", null);
  if (sha256(archive) !== args.definition.content.archiveSha256)
    throw taskProviderRefusal("task-archive-digest-mismatch", null);
  const runner = await args.fetchContent(args.runner.path);
  if (runner.byteLength > carriage.maximumObjectBytes)
    throw taskProviderRefusal("aws-object-too-large", null);
  if (sha256(runner) !== args.runner.sha256)
    throw taskProviderRefusal("task-runner-digest-mismatch", null);
  const configurationDigest = sha256(canonical(args.configuration));
  const runDigest = sha256(args.runId);
  const runPrefix = awsRunPrefix(carriage, configurationDigest, runDigest);
  const association: AwsObjectAssociation = {
    runDigest,
    configurationDigest,
    archiveSha256: args.definition.content.archiveSha256,
    treeSha256: args.definition.content.treeSha256,
    runnerSha256: args.runner.sha256,
  };
  const delivery = awsDeliveryDocument(
    args.runId,
    args.definition.content,
    args.inputDocument,
    args.runner.sha256,
    carriage.bucket,
    runPrefix,
    association,
  );
  const location = {
    bucket: carriage.bucket,
    runPrefix,
    maximumObjectBytes: carriage.maximumObjectBytes,
  };
  await putAwsObjectImmutable(args.s3, location, "task/archive", archive, association);
  await putAwsObjectImmutable(args.s3, location, "runner/task-runner", runner, association);
  await putAwsObjectImmutable(args.s3, location, "delivery.json", delivery, association);
  await putAwsObjectImmutable(args.s3, location, "guest/carriage.mjs", args.guestProgram, association);
  return {
    version: 1,
    bucket: carriage.bucket,
    runPrefix,
    archiveSha256: args.definition.content.archiveSha256,
    treeSha256: args.definition.content.treeSha256,
    runnerSha256: args.runner.sha256,
    deliverySha256: awsDeliverySha256(delivery),
    lastEnvironmentSequence: 0,
    lastCommandSequence: 0,
  };
}

const emptyEnvironmentStatus: EnvironmentStatusReport = {
  deliveryClaimed: null,
  entryStarted: null,
  entryExited: null,
  commandAcknowledgements: [],
};

function stateAssociation(state: AwsRunCarriageState): AwsObjectAssociation {
  const segments = state.runPrefix.split("/");
  const relationshipIndex = segments.lastIndexOf("relationships");
  const runIndex = segments.lastIndexOf("runs");
  return {
    configurationDigest: segments[relationshipIndex + 1] ?? "",
    runDigest: segments[runIndex + 1] ?? "",
    archiveSha256: state.archiveSha256,
    treeSha256: state.treeSha256,
    runnerSha256: state.runnerSha256,
  };
}

export async function readAwsEnvironmentStatus(
  s3: S3Sender,
  state: AwsRunCarriageState,
): Promise<EnvironmentStatusReport> {
  const parsed = AwsRunCarriageStateSchema.parse(state);
  const listed = await s3.send(
    new ListObjectsV2Command({
      Bucket: parsed.bucket,
      Prefix: `${parsed.runPrefix}/status/`,
    }),
  );
  const keys = (listed.Contents ?? [])
    .map((item) => item.Key)
    .filter((key): key is string => typeof key === "string")
    .sort();
  let report = emptyEnvironmentStatus;
  for (let index = 0; index < keys.length; index += 1) {
    const expected = `${parsed.runPrefix}/status/${String(index + 1).padStart(20, "0")}.json`;
    if (keys[index] !== expected)
      throw taskProviderRefusal("aws-status-sequence-conflict", {
        expected,
        actual: keys[index] ?? null,
      });
    const bytes = await getAwsObjectOptional(
      s3,
      {
        bucket: parsed.bucket,
        runPrefix: parsed.runPrefix,
        maximumObjectBytes: Number.MAX_SAFE_INTEGER,
      },
      `status/${String(index + 1).padStart(20, "0")}.json`,
      stateAssociation(parsed),
    );
    if (bytes === null) throw taskProviderRefusal("aws-status-sequence-conflict", null);
    report = JSON.parse(decoder.decode(bytes)) as EnvironmentStatusReport;
  }
  return report;
}

export async function writeAwsCommandImmutable(
  s3: S3Sender,
  state: AwsRunCarriageState,
  command: JSONValue,
): Promise<AwsRunCarriageState> {
  const parsed = AwsRunCarriageStateSchema.parse(state);
  const sequence = parsed.lastCommandSequence + 1;
  await putAwsObjectImmutable(
    s3,
    {
      bucket: parsed.bucket,
      runPrefix: parsed.runPrefix,
      maximumObjectBytes: Number.MAX_SAFE_INTEGER,
    },
    `commands/${String(sequence).padStart(20, "0")}.json`,
    encoder.encode(canonical(command)),
    stateAssociation(parsed),
  );
  return { ...parsed, lastCommandSequence: sequence };
}

export function selectRunner(
  architecture: "x86_64" | "arm64",
  runners: RunnerArtifactCatalogue,
) {
  return architecture === "x86_64" ? runners.linuxAmd64 : runners.linuxArm64;
}

export { canonical, sha256 };
