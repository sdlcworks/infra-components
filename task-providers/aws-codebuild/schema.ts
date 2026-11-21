import { z } from "zod";
import { AwsClientSchema, AwsRunCarriageStateSchema, AwsStatusCarriageSchema, StaticAwsCredentialsSchema } from "../aws-common";

const text = z.string().min(1);
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const unique = (values: string[], context: z.RefinementCtx) => {
  if (new Set(values).size !== values.length) context.addIssue({ code: "custom", message: "duplicate-values" });
};
const registryCredential = z.discriminatedUnion("mode", [
  z.strictObject({ mode: z.literal("none") }),
  z.strictObject({ mode: z.literal("secrets-manager"), credentialArn: text, credentialProvider: z.literal("SECRETS_MANAGER") }),
]);

export const AwsCodeBuildConfigurationSchema = z.strictObject({
  region: text,
  client: AwsClientSchema,
  statusCarriage: AwsStatusCarriageSchema,
  project: z.strictObject({
    mode: z.literal("existing"), name: text, arn: text,
    expected: z.strictObject({
      serviceRoleArn: text, encryptionKeyArn: text.nullable(),
      environment: z.strictObject({ type: z.enum(["LINUX_CONTAINER", "ARM_CONTAINER"]), computeType: text, image: text, imagePullCredentialsType: z.enum(["CODEBUILD", "SERVICE_ROLE"]), privilegedMode: z.boolean(), certificateArn: text.nullable(), registryCredential }),
      network: z.discriminatedUnion("mode", [z.strictObject({ mode: z.literal("none") }), z.strictObject({ mode: z.literal("vpc"), vpcId: text, subnetIds: z.array(text).min(1).superRefine(unique), securityGroupIds: z.array(text).min(1).superRefine(unique) })]),
      cache: z.discriminatedUnion("mode", [z.strictObject({ mode: z.literal("none") }), z.strictObject({ mode: z.literal("local"), modes: z.array(z.enum(["LOCAL_DOCKER_LAYER_CACHE", "LOCAL_CUSTOM_CACHE"])).min(1).superRefine(unique) }), z.strictObject({ mode: z.literal("s3"), location: text, namespaceType: z.enum(["NONE", "BUILD_ID"]), cacheNamespace: text.nullable() })]),
      logs: z.strictObject({ cloudWatch: z.discriminatedUnion("mode", [z.strictObject({ mode: z.literal("disabled") }), z.strictObject({ mode: z.literal("enabled"), groupName: text, streamName: text })]), s3: z.discriminatedUnion("mode", [z.strictObject({ mode: z.literal("disabled") }), z.strictObject({ mode: z.literal("enabled"), location: text, encryptionDisabled: z.boolean(), bucketOwnerAccess: z.enum(["NONE", "READ_ONLY", "FULL"]) })]) }),
      nativeLimits: z.strictObject({ timeoutMinutes: z.number().int().min(5).max(2160), queuedTimeoutMinutes: z.number().int().min(5).max(480), concurrentBuildLimit: z.number().int().positive().nullable() }),
    }),
  }),
  lifecycle: z.strictObject({ runnerBootstrapReserveSeconds: z.number().int().nonnegative(), cancellationPollMilliseconds: z.number().int().positive(), cancellationMaximumPolls: z.number().int().positive() }),
});
export type AwsCodeBuildConfiguration = z.infer<typeof AwsCodeBuildConfigurationSchema>;
export { StaticAwsCredentialsSchema as AwsCodeBuildCredentialsSchema };
export type AwsCodeBuildCredentials = z.infer<typeof StaticAwsCredentialsSchema>;
export const AwsCodeBuildComputeConstraintsSchema = z.strictObject({ os: z.literal("linux"), architecture: z.enum(["x86_64", "arm64"]), codebuildComputeType: text, network: z.enum(["public-egress", "vpc"]) });
export const AwsCodeBuildAllocationStateSchema = z.strictObject({ version: z.literal(1), configurationDigest: digest, project: z.strictObject({ name: text, arn: text, shapeDigest: digest, serviceRoleArn: text, environmentType: z.enum(["LINUX_CONTAINER", "ARM_CONTAINER"]), computeType: text, image: text }), qualifiedConstraintEnvelope: z.strictObject({ os: z.literal("linux"), architecture: z.enum(["x86_64", "arm64"]), codebuildComputeType: text, network: z.enum(["public-egress", "vpc"]) }) });
export type AwsCodeBuildAllocationState = z.infer<typeof AwsCodeBuildAllocationStateSchema>;
export const AwsCodeBuildRunStateSchema = z.strictObject({ version: z.literal(1), runId: text, configurationDigest: digest, projectName: text, projectArn: text, projectShapeDigest: digest, idempotencyToken: digest, buildId: text.nullable(), launch: z.enum(["accepted", "lost-answer"]), deliveryDigest: digest, carriage: AwsRunCarriageStateSchema, lastProviderStatus: text.nullable() });
export type AwsCodeBuildRunState = z.infer<typeof AwsCodeBuildRunStateSchema>;
export type AwsCodeBuildComputeConstraints = z.infer<typeof AwsCodeBuildComputeConstraintsSchema>;
