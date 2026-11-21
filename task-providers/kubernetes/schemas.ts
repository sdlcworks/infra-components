import { z } from "zod";
import { rawJSONDocument, typedMap } from "@sdlcworks/components";

const digest = z.string().regex(/^[0-9a-f]{64}$/);
const nonempty = z.string().min(1);
export const DnsLabelSchema = z.string().regex(/^[a-z0-9](?:[a-z0-9.-]{0,61}[a-z0-9])?$/);
export const KubernetesQuantitySchema = z.string().regex(/^(?:[0-9]+(?:\.[0-9]+)?|\.[0-9]+)(?:m|[EPTGMK]i?|[numk])?$/);
export const AbsolutePathSchema = z.string().regex(/^\/(?!.*(?:\/\.|\/\/|\/\.\.(?:\/|$))).+$/);
export const HttpsUrlSchema = z.string().url().superRefine((value, context) => {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/")
    context.addIssue({ code: "custom", message: "kubernetes-https-root-url-required" });
});

export const KubernetesConfigurationSchema = z.strictObject({
  apiVersion: z.literal("v1"),
  namespace: z.strictObject({ mode: z.literal("existing"), name: DnsLabelSchema }),
  podTemplate: z.strictObject({
    apiVersion: z.literal("v1"), kind: z.literal("Pod"),
    metadata: z.strictObject({ labels: typedMap(DnsLabelSchema, z.string()), annotations: typedMap(nonempty, z.string()) }),
    spec: rawJSONDocument(),
  }),
  runnerContainerName: DnsLabelSchema,
  workspaceVolumeName: DnsLabelSchema,
  workspace: z.strictObject({ sizeLimit: KubernetesQuantitySchema }),
  delivery: z.strictObject({ chunkBytes: z.number().int().min(1).max(524288), maximumBundleBytes: z.number().int().positive() }),
  statusCarriage: z.strictObject({ kind: z.literal("secret-chunks"), chunkBytes: z.number().int().min(1).max(524288), maximumOutputBytes: z.number().int().positive(), commandPollMilliseconds: z.number().int().positive() }),
  carriage: z.strictObject({
    nodePath: AbsolutePathSchema, shellPath: AbsolutePathSchema, catPath: AbsolutePathSchema,
    sha256Path: AbsolutePathSchema, tarPath: AbsolutePathSchema, workspaceRoot: AbsolutePathSchema,
    inClusterApiUrl: HttpsUrlSchema, clusterCaConfigMapName: DnsLabelSchema,
    serviceAccountAudience: nonempty, serviceAccountTokenExpirationSeconds: z.number().int().min(600).max(86400),
  }),
  deletion: z.strictObject({ gracePeriodSeconds: z.number().int().nonnegative(), propagationPolicy: z.enum(["Foreground", "Background", "Orphan"]), commandGraceMilliseconds: z.number().int().nonnegative() }),
  api: z.strictObject({ requestTimeoutMilliseconds: z.number().int().positive(), providerPollMilliseconds: z.number().int().positive(), fieldManager: nonempty }),
});
export type KubernetesConfiguration = z.infer<typeof KubernetesConfigurationSchema>;

export function requireKubernetesPodSpecObject(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("kubernetes-pod-spec-object-required");
  return value as Record<string, unknown>;
}

export const KubernetesCredentialsSchema = z.strictObject({
  serverUrl: HttpsUrlSchema, certificateAuthorityPem: nonempty, tlsServerName: nonempty,
  authentication: z.discriminatedUnion("mode", [
    z.strictObject({ mode: z.literal("bearer-token"), token: nonempty }),
    z.strictObject({ mode: z.literal("client-certificate"), certificatePem: nonempty, privateKeyPem: nonempty }),
  ]),
});
export type KubernetesCredentials = z.infer<typeof KubernetesCredentialsSchema>;

export const KubernetesComputeConstraintsSchema = z.strictObject({
  os: z.literal("linux"), architecture: z.enum(["amd64", "arm64"]),
  resources: z.strictObject({
    requests: z.strictObject({ cpu: KubernetesQuantitySchema, memory: KubernetesQuantitySchema, ephemeralStorage: KubernetesQuantitySchema }),
    limits: z.strictObject({ cpu: KubernetesQuantitySchema, memory: KubernetesQuantitySchema, ephemeralStorage: KubernetesQuantitySchema }),
    gpu: z.discriminatedUnion("mode", [z.strictObject({ mode: z.literal("none") }), z.strictObject({ mode: z.literal("extended-resource"), resourceName: z.string().regex(/^[a-z0-9.-]+\/[A-Za-z0-9_.-]+$/), quantity: KubernetesQuantitySchema })]),
  }),
});
export type KubernetesComputeConstraints = z.infer<typeof KubernetesComputeConstraintsSchema>;

export const KubernetesObjectIdentitySchema = z.strictObject({ apiVersion: nonempty, kind: nonempty, name: nonempty, uid: nonempty, digest });
export type KubernetesObjectIdentity = z.infer<typeof KubernetesObjectIdentitySchema>;
export const KubernetesAllocationStateSchema = z.strictObject({ version: z.literal(1), configurationDigest: digest, serverVersion: nonempty, namespace: z.strictObject({ name: nonempty, uid: nonempty, resourceVersion: nonempty }), podTemplateDigest: digest });
export type KubernetesAllocationState = z.infer<typeof KubernetesAllocationStateSchema>;
export const KubernetesRunStateSchema = z.strictObject({
  version: z.literal(1), runId: nonempty, configurationDigest: digest, namespace: nonempty,
  pod: KubernetesObjectIdentitySchema.extend({ resourceVersion: nonempty }), deliverySecrets: z.array(KubernetesObjectIdentitySchema), statusSecrets: z.array(KubernetesObjectIdentitySchema),
  commandSecret: KubernetesObjectIdentitySchema, serviceAccount: KubernetesObjectIdentitySchema, role: KubernetesObjectIdentitySchema, roleBinding: KubernetesObjectIdentitySchema,
  runnerContainerName: nonempty, lastStatusSequence: z.number().int().nonnegative(), lastCommandSequence: z.number().int().nonnegative(),
});
export type KubernetesRunState = z.infer<typeof KubernetesRunStateSchema>;
