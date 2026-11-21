import { z } from "zod";
import { AwsClientSchema, AwsRunCarriageStateSchema, AwsStatusCarriageSchema, StaticAwsCredentialsSchema } from "../aws-common";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const arn = z.string().regex(/^arn:[^:]+:lambda:[^:]+:[0-9]{12}:function:[^:]+:[1-9][0-9]*$/);

export const AwsLambdaConfigurationSchema = z.strictObject({
  region: z.string().min(1),
  client: AwsClientSchema,
  statusCarriage: AwsStatusCarriageSchema,
  function: z.strictObject({
    versionArn: arn,
    revisionId: z.string().min(1),
    codeSha256: z.string().min(1),
    configurationSha256: digest,
    packageType: z.literal("Image"),
    architecture: z.enum(["x86_64", "arm64"]),
    memoryMiB: z.number().int().min(128).max(10240),
    ephemeralStorageMiB: z.number().int().min(512).max(10240),
    nativeTimeoutSeconds: z.number().int().min(1).max(900),
    bootstrapReserveSeconds: z.number().int().nonnegative(),
    roleArn: z.string().min(1),
    environmentSha256: digest,
    protocolVersion: z.literal("1"),
    bootstrapIdentity: z.string().min(1),
    network: z.strictObject({ mode: z.literal("no-vpc") }),
  }),
  terminalTestimony: z.strictObject({
    mode: z.literal("lambda-destination-adapter"),
    adapterVersionArn: arn,
    adapterRevisionId: z.string().min(1),
    adapterCodeSha256: z.string().min(1),
    adapterConfigurationSha256: digest,
    adapterRoleArn: z.string().min(1),
    adapterProtocolVersion: z.literal("1"),
    maximumEventAgeSeconds: z.number().int().min(60).max(21600),
    maximumRetryAttempts: z.number().int().min(0).max(2),
    maximumRecordBytes: z.number().int().min(1).max(262144),
    qualificationProbeTimeoutMilliseconds: z.number().int().positive(),
  }),
});
export type AwsLambdaConfiguration = z.infer<typeof AwsLambdaConfigurationSchema>;
export { StaticAwsCredentialsSchema as AwsLambdaCredentialsSchema };
export type AwsLambdaCredentials = z.infer<typeof StaticAwsCredentialsSchema>;

export const AwsLambdaComputeConstraintsSchema = z.strictObject({
  system: z.strictObject({ os: z.literal("linux"), architecture: z.enum(["x86_64", "arm64"]) }),
  memoryMiB: z.number().int().positive(),
  ephemeralStorageMiB: z.number().int().positive(),
  network: z.strictObject({ egress: z.literal("open"), ingress: z.literal("none") }),
});

export const AwsLambdaAllocationStateSchema = z.strictObject({
  version: z.literal(1),
  configurationDigest: digest,
  function: z.strictObject({ versionArn: arn, revisionId: z.string().min(1), codeSha256: z.string().min(1) }),
  destination: z.strictObject({
    adapterVersionArn: arn,
    adapterRevisionId: z.string().min(1),
    adapterCodeSha256: z.string().min(1),
    eventInvokeConfigurationDigest: digest,
    qualificationProbeDigest: digest,
  }),
});
export type AwsLambdaAllocationState = z.infer<typeof AwsLambdaAllocationStateSchema>;

export const AwsLambdaRunStateSchema = z.strictObject({
  version: z.literal(1),
  runId: z.string().min(1),
  functionVersionArn: arn,
  invocationPayloadSha256: digest,
  launch: z.enum(["accepted", "lost-answer"]),
  carriage: AwsRunCarriageStateSchema,
});
export type AwsLambdaRunState = z.infer<typeof AwsLambdaRunStateSchema>;
