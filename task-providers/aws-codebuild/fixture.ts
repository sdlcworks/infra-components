import type { TaskProviderAct } from "@sdlcworks/components/task";
import { canonical, sha256 } from "../aws-common";
import type { ProviderScenarioDescriptor, ScenarioBinding } from "../scenario";
import type { AwsCodeBuildConfiguration } from "./schema";
import { codeBuildCarriageProgram } from "./buildspec";

export const validAwsCodeBuildConfiguration = (): AwsCodeBuildConfiguration => ({
  region: "us-east-1",
  client: { endpoint: { mode: "aws-standard" }, s3AddressingStyle: "virtual-hosted", connectionTimeoutMilliseconds: 1000, requestTimeoutMilliseconds: 5000, maximumAttempts: 2 },
  statusCarriage: { bucket: "task-evidence", prefix: "task-runs", maximumObjectBytes: 16777216, retention: "retain" },
  project: { mode: "existing", name: "task-project", arn: "arn:aws:codebuild:us-east-1:123456789012:project/task-project", expected: { serviceRoleArn: "arn:aws:iam::123456789012:role/codebuild", encryptionKeyArn: null, environment: { type: "LINUX_CONTAINER", computeType: "BUILD_GENERAL1_SMALL", image: "image@sha256:abc", imagePullCredentialsType: "CODEBUILD", privilegedMode: false, certificateArn: null, registryCredential: { mode: "none" } }, network: { mode: "none" }, cache: { mode: "none" }, logs: { cloudWatch: { mode: "disabled" }, s3: { mode: "disabled" } }, nativeLimits: { timeoutMinutes: 60, queuedTimeoutMinutes: 30, concurrentBuildLimit: null } } },
  lifecycle: { runnerBootstrapReserveSeconds: 60, cancellationPollMilliseconds: 10, cancellationMaximumPolls: 3 },
});

const bind = (source: "artifact" | "world", name: string): ScenarioBinding => ({ $scenario: { source, name, step: null, path: [] } });
const prior = (step: string, path: string[]): ScenarioBinding => ({ $scenario: { source: "account", name: "account", step, path } });
const credentials = { kind: "static", accessKeyId: "scenario-access-key", secretAccessKey: "scenario-secret-key", sessionToken: null };
const emptyEnvironment = { deliveryClaimed: null, entryStarted: null, entryExited: null, commandAcknowledgements: [] };
const taskContent = { entry: "#scenario", files: { "flake.nix": `{ outputs = { self }: { apps.scenario = { type = "app"; program = "${"${self}"}/scenario.sh"; }; }; };\n`, "flake.lock": `{"nodes":{"root":{"inputs":{}}},"root":"root","version":7}\n`, "scenario.sh": "#!/bin/sh\nprintf '%s\\n' '{\"scenario\":\"aws-codebuild\"}'\n" }, archiveSha256: "f2ab63c3e1345142806e81f690f1647b6cef5dc6a6743fff8d09098f73728be1", treeSha256: "a1033551d76867a4b552ca1f1b76d051185e722fff4b7c8867c1c1bfe178ea78" };
const awsDate = { $expect: { kind: "aws-amz-date", anchor: "step-start", offsetSeconds: 0, toleranceMilliseconds: 30000 } };
const observedAt = { $expect: { kind: "iso-8601", anchor: "step-start", offsetSeconds: 0, toleranceMilliseconds: 30000 } };
const document = (value: unknown) => JSON.parse(JSON.stringify(value));

function configuration() {
  const value = validAwsCodeBuildConfiguration();
  return { ...value, client: { ...value.client, endpoint: { mode: "custom", url: bind("world", "aws-http-root") }, s3AddressingStyle: "path" } };
}
function configurationExpectation() {
  const value = validAwsCodeBuildConfiguration();
  return { ...value, client: { ...value.client, endpoint: { mode: "custom", url: { $resolve: bind("world", "aws-http-root") } }, s3AddressingStyle: "path" } };
}
function demand(id: string, step: string, act: TaskProviderAct, previous: string | null) {
  return document({ version: 1, actIdentity: `${id}-${step}`, act, runId: `scenario-${id}`, definition: { address: { bundleIdentity: "scenario-bundle", member: "scenario-task" }, content: { uri: bind("artifact", "task-content-uri"), archiveSha256: taskContent.archiveSha256, treeSha256: taskContent.treeSha256 }, entry: { flakeSelector: taskContent.entry }, schemas: { input: { type: "object" }, output: { type: "object" } }, meta: { timeout: { mode: "duration", seconds: 600 }, computeConstraints: { os: "linux", architecture: "x86_64", codebuildComputeType: "BUILD_GENERAL1_SMALL", network: "public-egress" }, confidentialInputPaths: [] } }, realization: bind("artifact", "built-realization"), inputDocument: { scenario: id }, configuration: configuration(), credentials, allocationState: previous ? prior(previous, ["allocationState"]) : null, runState: previous ? prior(previous, ["runState"]) : null, environmentStatus: previous ? prior(previous, ["environmentStatus"]) : emptyEnvironment, runners: { linuxAmd64: { path: bind("artifact", "linux-amd64-runner-path"), sha256: bind("artifact", "linux-amd64-runner-sha256") }, linuxArm64: { path: bind("artifact", "linux-arm64-runner-path"), sha256: bind("artifact", "linux-arm64-runner-sha256") }, maximumOutputBytes: 1048576 } });
}

const project = (serviceRole = "arn:aws:iam::123456789012:role/codebuild") => ({ name: "task-project", arn: validAwsCodeBuildConfiguration().project.arn, serviceRole, source: { type: "NO_SOURCE" }, artifacts: { type: "NO_ARTIFACTS" }, environment: { type: "LINUX_CONTAINER", computeType: "BUILD_GENERAL1_SMALL", image: "image@sha256:abc", imagePullCredentialsType: "CODEBUILD", privilegedMode: false, environmentVariables: [] }, cache: { type: "NO_CACHE" }, logsConfig: { cloudWatchLogs: { status: "DISABLED" }, s3Logs: { status: "DISABLED" } }, timeoutInMinutes: 60, queuedTimeoutInMinutes: 30, projectVisibility: "PRIVATE" });
const shape = (serviceRole = "arn:aws:iam::123456789012:role/codebuild") => ({ serviceRole, encryptionKey: null, source: { type: "NO_SOURCE" }, artifacts: { type: "NO_ARTIFACTS" }, environment: { type: "LINUX_CONTAINER", computeType: "BUILD_GENERAL1_SMALL", image: "image@sha256:abc", imagePullCredentialsType: "CODEBUILD", privilegedMode: false, certificate: null, registryCredential: null, environmentVariables: [] }, vpcConfig: null, cache: { mode: "none" }, logsConfig: { cloudWatch: { mode: "disabled" }, s3: { mode: "disabled" } }, timeoutInMinutes: 60, queuedTimeoutInMinutes: 30, concurrentBuildLimit: null, secondarySources: [], secondaryArtifacts: [], fileSystemLocations: [], batchConfig: null, publicProject: false });
const signed = (operation: string, body: unknown) => ({ operation, method: "POST", path: "/", query: {}, body, authorization: { algorithm: "AWS4-HMAC-SHA256", accessKeyId: credentials.accessKeyId, date: awsDate, region: "us-east-1", service: "codebuild", signedHeaders: ["amz-sdk-invocation-id", "amz-sdk-request", "content-length", "content-type", "host", "x-amz-content-sha256", "x-amz-date", "x-amz-target", "x-amz-user-agent"], signaturePresent: true }, signingDate: awsDate, conditional: { ifNoneMatch: null }, metadata: {} });
const qualificationRequest = () => signed("BatchGetProjects", { names: ["task-project"] });

function qualification(id: string, mode: "success" | "drift" | "missing" | "denial"): ProviderScenarioDescriptor {
  const response = mode === "missing" ? { projects: [], projectsNotFound: ["task-project"] } : { projects: [project(mode === "drift" ? "arn:aws:iam::123456789012:role/other" : undefined)], projectsNotFound: [] };
  const nativeResponse = { ...response, $metadata: { httpStatusCode: 200, attempts: 1, totalRetryDelay: 0 } };
  const outcome = mode === "success" ? { kind: "witnessed" } : mode === "drift" ? { kind: "refusal", name: "aws-codebuild-project-drift", detail: { expected: shape(), actual: shape("arn:aws:iam::123456789012:role/other") } } : mode === "missing" ? { kind: "refusal", name: "aws-codebuild-project-not-found", detail: null } : { kind: "refusal", name: "aws-access-denied", detail: { code: "AccessDeniedException", requestId: null } };
  const script = mode === "denial" ? [{ request: {}, response: { kind: "service-error", status: 400, code: "AccessDeniedException", headers: { "content-type": "application/x-amz-json-1.1" }, body: { message: "denied" } }, externalEffect: {} }] : [{ request: {}, response: { kind: "success", status: 200, headers: { "content-type": "application/x-amz-json-1.1" }, body: response }, externalEffect: {} }];
  const success = mode === "success";
  return document({ version: 1, id: `codebuild-${id}`, providerMember: "aws-codebuild", traces: [id, "credential-confinement"], forbiddenAccountScalars: [credentials.accessKeyId, credentials.secretAccessKey], taskContent, world: { kind: "aws-http", initialState: { codebuild: {}, s3: {} }, script }, acts: [{ step: "01-provision-allocations", demand: demand(`codebuild-${id}`, "01-provision-allocations", "provision-allocations", null), expectedAccount: { version: 1, actIdentity: `codebuild-${id}-01-provision-allocations`, runId: `scenario-codebuild-${id}`, allocationState: success ? { version: 1, configurationDigest: { $expect: { kind: "derived", name: "aws-configuration-digest", inputs: { configuration: { kind: "literal", value: configurationExpectation() } } } }, project: { name: "task-project", arn: validAwsCodeBuildConfiguration().project.arn, shapeDigest: sha256(canonical(shape())), serviceRoleArn: validAwsCodeBuildConfiguration().project.expected.serviceRoleArn, environmentType: "LINUX_CONTAINER", computeType: "BUILD_GENERAL1_SMALL", image: "image@sha256:abc" }, qualifiedConstraintEnvelope: { os: "linux", architecture: "x86_64", codebuildComputeType: "BUILD_GENERAL1_SMALL", network: "public-egress" } } : null, runState: null, providerTestimony: success ? { kind: "witnessed", standing: "live", observedAt, native: nativeResponse } : { kind: "silent" }, environmentStatus: emptyEnvironment, retention: null, outcome }, expectedWorld: { requests: [signed("BatchGetProjects", { names: ["task-project"] })], effects: { codebuild: {}, s3: {} }, environmentCount: 0 } }] });
}

const resolve = (value: unknown) => ({ $resolve: value });
const literal = (value: unknown) => ({ kind: "literal", value });
const derived = (name: string, inputs: Record<string, unknown>) => ({ kind: "derived", name, inputs });
const joined = (...parts: unknown[]) => ({ kind: "joined", parts });
const expected = (value: unknown) => ({ $expect: value });
const successResponse = (body: unknown, headers: Record<string, unknown> = { "content-type": "application/x-amz-json-1.1" }) => ({ request: {}, response: { kind: "success", status: 200, headers, body }, externalEffect: {} });
const configurationDigestExpectation = () => expected(derived("aws-configuration-digest", { configuration: literal(configurationExpectation()) }));
const runDigestValue = (id: string) => sha256(`scenario-codebuild-${id}`);
const resolvedConfigurationDigest = () => resolve(derived("aws-configuration-digest", { configuration: literal(configurationExpectation()) }));
const runPrefixDerived = (id: string) => derived("aws-run-prefix", { carriage: literal(validAwsCodeBuildConfiguration().statusCarriage), configurationDigest: literal(resolvedConfigurationDigest()), runDigest: literal(runDigestValue(id)) });
const deliveryDocumentDerived = (id: string) => derived("aws-delivery-document", {
  runId: literal(`scenario-codebuild-${id}`),
  content: literal({ uri: resolve(bind("artifact", "task-content-uri")), archiveSha256: taskContent.archiveSha256, treeSha256: taskContent.treeSha256 }),
  inputDocument: literal({ scenario: `codebuild-${id}` }),
  runnerSha256: { kind: "binding", binding: bind("artifact", "linux-amd64-runner-sha256") },
  bucket: literal("task-evidence"), runPrefix: literal(resolve(runPrefixDerived(id))),
  association: literal({ runDigest: runDigestValue(id), configurationDigest: resolvedConfigurationDigest(), archiveSha256: taskContent.archiveSha256, treeSha256: taskContent.treeSha256, runnerSha256: resolve(bind("artifact", "linux-amd64-runner-sha256")) }),
});
const deliveryDigestDerived = (id: string) => derived("aws-delivery-sha256", { delivery: literal(resolve(deliveryDocumentDerived(id))) });
const runPrefixExpectation = (id: string) => expected(runPrefixDerived(id));
const deliveryDigestExpectation = (id: string) => expected(deliveryDigestDerived(id));
const runnerDigestExpectation = { $expect: { kind: "binding", binding: bind("artifact", "linux-amd64-runner-sha256") } };
const deliveryUri = (id: string) => joined("s3://task-evidence/", runPrefixDerived(id), "/delivery.json");
const carriagePath = (id: string) => joined("/", runPrefixDerived(id), "/guest/carriage.mjs");
const variableValues = (id: string) => [
  ["SDLC_TASK_ARCHIVE_SHA256", taskContent.archiveSha256], ["SDLC_TASK_CARRIAGE_PATH", resolve(carriagePath(id))], ["SDLC_TASK_DELIVERY_DIGEST", resolve(deliveryDigestDerived(id))], ["SDLC_TASK_DELIVERY_URI", resolve(deliveryUri(id))], ["SDLC_TASK_PROJECT_DIGEST", sha256(canonical(shape()))], ["SDLC_TASK_PROTOCOL", "1"], ["SDLC_TASK_RUN_DIGEST", runDigestValue(id)], ["SDLC_TASK_TREE_SHA256", taskContent.treeSha256],
].map(([name, value]) => ({ name, value, type: "PLAINTEXT" }));
const build = (id: string, status = "QUEUED", projectName = "task-project") => ({ id: `task-project:${id}`, arn: `arn:aws:codebuild:us-east-1:123456789012:build/task-project:${id}`, projectName, buildStatus: status, environment: { environmentVariables: variableValues(id) } });
const expectedBuild = (id: string, status = "QUEUED", projectName = "task-project") => ({ ...build(id, status, projectName), environment: { environmentVariables: variableValues(id).map(({ name, value, type }) => ({ name, value: typeof value === "object" && value !== null && "$resolve" in value ? expected(value.$resolve) : value, type })) } });
const native = (value: Record<string, unknown>) => ({ ...value, $metadata: { httpStatusCode: 200, attempts: 1, totalRetryDelay: 0 } });

function allocationState() { return { version: 1, configurationDigest: configurationDigestExpectation(), project: { name: "task-project", arn: validAwsCodeBuildConfiguration().project.arn, shapeDigest: sha256(canonical(shape())), serviceRoleArn: validAwsCodeBuildConfiguration().project.expected.serviceRoleArn, environmentType: "LINUX_CONTAINER", computeType: "BUILD_GENERAL1_SMALL", image: "image@sha256:abc" }, qualifiedConstraintEnvelope: { os: "linux", architecture: "x86_64", codebuildComputeType: "BUILD_GENERAL1_SMALL", network: "public-egress" } }; }
function qualifiedAccount(id: string) { const response = { projects: [project()], projectsNotFound: [] }; return { version: 1, actIdentity: `codebuild-${id}-01-provision-allocations`, runId: `scenario-codebuild-${id}`, allocationState: allocationState(), runState: null, providerTestimony: { kind: "witnessed", standing: "live", observedAt, native: native(response) }, environmentStatus: emptyEnvironment, retention: null, outcome: { kind: "witnessed" } }; }
function runState(id: string, buildId: string | null, launch: "accepted" | "lost-answer" = "accepted", lastProviderStatus: string | null = null, lastCommandSequence = 0) { return { version: 1, runId: `scenario-codebuild-${id}`, configurationDigest: configurationDigestExpectation(), projectName: "task-project", projectArn: validAwsCodeBuildConfiguration().project.arn, projectShapeDigest: sha256(canonical(shape())), idempotencyToken: sha256(`sdlc-task-codebuild-v1\0scenario-codebuild-${id}`), buildId, launch, deliveryDigest: deliveryDigestExpectation(id), carriage: { version: 1, bucket: "task-evidence", runPrefix: runPrefixExpectation(id), archiveSha256: taskContent.archiveSha256, treeSha256: taskContent.treeSha256, runnerSha256: runnerDigestExpectation, deliverySha256: deliveryDigestExpectation(id), lastEnvironmentSequence: 0, lastCommandSequence }, lastProviderStatus }; }

function s3PutRequest(id: string, suffix: string, bytes: unknown) {
  const metadata = { "x-amz-meta-run-digest": runDigestValue(id), "x-amz-meta-configuration-digest": { $expect: { kind: "binding", binding: prior("01-provision-allocations", ["allocationState", "configurationDigest"]) } }, "x-amz-meta-archive-sha256": taskContent.archiveSha256, "x-amz-meta-tree-sha256": taskContent.treeSha256, "x-amz-meta-runner-sha256": runnerDigestExpectation };
  return { operation: "PutObject", method: "PUT", path: expected(joined("/task-evidence/", runPrefixDerived(id), `/${suffix}`)), query: { "x-id": "PutObject" }, body: expected(derived("recorded-body", { bytes })), authorization: { algorithm: "AWS4-HMAC-SHA256", accessKeyId: credentials.accessKeyId, date: awsDate, region: "us-east-1", service: "s3", signedHeaders: ["amz-sdk-invocation-id", "amz-sdk-request", "content-length", "content-type", "host", "if-none-match", "x-amz-checksum-crc32", "x-amz-content-sha256", "x-amz-date", "x-amz-meta-archive-sha256", "x-amz-meta-configuration-digest", "x-amz-meta-run-digest", "x-amz-meta-runner-sha256", "x-amz-meta-tree-sha256", "x-amz-sdk-checksum-algorithm", "x-amz-user-agent"], signaturePresent: true }, signingDate: awsDate, conditional: { ifNoneMatch: "*" }, metadata };
}
function launchRequests(id: string) {
  const startBody = { projectName: "task-project", idempotencyToken: sha256(`sdlc-task-codebuild-v1\0scenario-codebuild-${id}`), sourceTypeOverride: "NO_SOURCE", artifactsOverride: { type: "NO_ARTIFACTS" }, autoRetryLimitOverride: 0, timeoutInMinutesOverride: 60, queuedTimeoutInMinutesOverride: 30, buildspecOverride: "version: 0.2\nphases:\n  build:\n    commands:\n      - node \"$SDLC_TASK_CARRIAGE_PATH\" --delivery \"$SDLC_TASK_DELIVERY_URI\"\n", environmentVariablesOverride: variableValues(id).map(({ name, value, type }) => ({ name, value: typeof value === "object" && value !== null && "$resolve" in value ? expected(value.$resolve) : value, type })) };
  return [qualificationRequest(), s3PutRequest(id, "task/archive", { kind: "task-archive" }), s3PutRequest(id, "runner/task-runner", { kind: "runner-file", binding: "linux-amd64-runner-path" }), s3PutRequest(id, "delivery.json", deliveryDocumentDerived(id)), { ...s3PutRequest(id, "guest/carriage.mjs", literal(null)), body: { base64: Buffer.from(codeBuildCarriageProgram).toString("base64"), utf8: Buffer.from(codeBuildCarriageProgram).toString("utf8") } }, signed("StartBuild", startBody)];
}
function launchScript(id: string, response: unknown) { return [successResponse({ projects: [project()], projectsNotFound: [] }), successResponse("", {}), successResponse("", {}), successResponse("", {}), successResponse("", {}), successResponse(response)]; }
function acceptedLaunchAccount(id: string, responseBuild: Record<string, unknown>) { return { version: 1, actIdentity: `codebuild-${id}-02-launch`, runId: `scenario-codebuild-${id}`, allocationState: { $expect: { kind: "binding", binding: prior("01-provision-allocations", ["allocationState"]) } }, runState: runState(id, `task-project:${id}`), providerTestimony: { kind: "witnessed", standing: "pending", observedAt, native: responseBuild }, environmentStatus: { $expect: { kind: "binding", binding: prior("01-provision-allocations", ["environmentStatus"]) } }, retention: null, outcome: { kind: "witnessed" } }; }

function launchAccepted(id: string): ProviderScenarioDescriptor {
  const responseBuild = build(id);
  return document({ version: 1, id: `codebuild-${id}`, providerMember: "aws-codebuild", traces: [id, "credential-confinement"], forbiddenAccountScalars: [credentials.accessKeyId, credentials.secretAccessKey], taskContent, world: { kind: "aws-http", initialState: { codebuild: {}, s3: {} }, script: launchScript(id, { build: responseBuild }) }, acts: [
    { step: "01-provision-allocations", demand: demand(`codebuild-${id}`, "01-provision-allocations", "provision-allocations", null), expectedAccount: qualifiedAccount(id), expectedWorld: { requests: [qualificationRequest()], effects: { codebuild: {}, s3: {} }, environmentCount: 0 } },
    { step: "02-launch", demand: demand(`codebuild-${id}`, "02-launch", "launch", "01-provision-allocations"), expectedAccount: acceptedLaunchAccount(id, expectedBuild(id)), expectedWorld: { requests: launchRequests(id), effects: { codebuild: {}, s3: {} }, environmentCount: 1 } },
  ] });
}

function s3ListRequest(id: string) {
  return { operation: "ListObjectsV2", method: "GET", path: "/task-evidence/", query: { "list-type": "2", prefix: expected(joined(runPrefixDerived(id), "/status/")) }, body: null, authorization: { algorithm: "AWS4-HMAC-SHA256", accessKeyId: credentials.accessKeyId, date: awsDate, region: "us-east-1", service: "s3", signedHeaders: ["amz-sdk-invocation-id", "amz-sdk-request", "host", "x-amz-content-sha256", "x-amz-date", "x-amz-user-agent"], signaturePresent: true }, signingDate: awsDate, conditional: { ifNoneMatch: null }, metadata: {} };
}
function observeDescriptor(label: string, status: string): ProviderScenarioDescriptor {
  const id = `provider-${label}`;
  const responseBuild = build(id, status === "unknown" ? "FUTURE" : status === "cross-project" ? "QUEUED" : status, status === "cross-project" ? "other-project" : "task-project");
  const missing = status === "missing";
  const batchBody = missing ? { builds: [], buildsNotFound: [`task-project:${id}`] } : { builds: [responseBuild], buildsNotFound: [] };
  const scripts = [...launchScript(id, { build: build(id) }), successResponse(batchBody), successResponse("<?xml version=\"1.0\" encoding=\"UTF-8\"?><ListBucketResult xmlns=\"http://s3.amazonaws.com/doc/2006-03-01/\"><Name>task-evidence</Name><Prefix></Prefix><KeyCount>0</KeyCount><MaxKeys>1000</MaxKeys><IsTruncated>false</IsTruncated></ListBucketResult>", { "content-type": "application/xml" })];
  const allRequests = [...launchRequests(id), signed("BatchGetBuilds", { ids: [`task-project:${id}`] }), s3ListRequest(id)];
  const terminal = ["SUCCEEDED", "FAILED", "FAULT", "STOPPED", "TIMED_OUT"].includes(status);
  const conflict = status === "cross-project";
  const known = status !== "unknown" && !missing && !conflict;
  const account = { version: 1, actIdentity: `codebuild-${id}-03-observe`, runId: `scenario-codebuild-${id}`, allocationState: { $expect: { kind: "binding", binding: prior("02-launch", ["allocationState"]) } }, runState: known ? { ...runState(id, `task-project:${id}`, "accepted", status), carriage: { $expect: { kind: "binding", binding: prior("02-launch", ["runState", "carriage"]) } } } : { $expect: { kind: "binding", binding: prior("02-launch", ["runState"]) } }, providerTestimony: conflict ? { kind: "witnessed", standing: "conflict", observedAt, native: expectedBuild(id, status === "cross-project" ? "QUEUED" : status, "other-project") } : known ? { kind: "witnessed", standing: status === "QUEUED" ? "pending" : status === "IN_PROGRESS" ? "live" : terminal ? "gone" : "conflict", observedAt, native: expectedBuild(id, status) } : { kind: "silent" }, environmentStatus: emptyEnvironment, retention: null, outcome: missing ? { kind: "lost-answer", operation: "aws-codebuild-batch-get-builds", detail: { buildId: `task-project:${id}` } } : conflict ? { kind: "refusal", name: "aws-codebuild-run-scope-conflict", detail: null } : status === "unknown" ? { kind: "refusal", name: "aws-codebuild-status-unknown", detail: { status: "FUTURE" } } : { kind: "witnessed" } };
  return document({ version: 1, id: `codebuild-${id}`, providerMember: "aws-codebuild", traces: ["provider-testimony", `provider-status-${status}`, "credential-confinement"], forbiddenAccountScalars: [credentials.accessKeyId, credentials.secretAccessKey], taskContent, world: { kind: "aws-http", initialState: { codebuild: {}, s3: {} }, script: scripts }, acts: [
    { step: "01-provision-allocations", demand: demand(`codebuild-${id}`, "01-provision-allocations", "provision-allocations", null), expectedAccount: qualifiedAccount(id), expectedWorld: { requests: [qualificationRequest()], effects: { codebuild: {}, s3: {} }, environmentCount: 0 } },
    { step: "02-launch", demand: demand(`codebuild-${id}`, "02-launch", "launch", "01-provision-allocations"), expectedAccount: acceptedLaunchAccount(id, expectedBuild(id)), expectedWorld: { requests: launchRequests(id), effects: { codebuild: {}, s3: {} }, environmentCount: 1 } },
    { step: "03-observe", demand: demand(`codebuild-${id}`, "03-observe", "observe", "02-launch"), expectedAccount: account, expectedWorld: { requests: allRequests, effects: { codebuild: {}, s3: {} }, environmentCount: 1 } },
  ] });
}
function unsupported(id: string, act: "pause" | "resume"): ProviderScenarioDescriptor {
  return document({ version: 1, id: `codebuild-${id}`, providerMember: "aws-codebuild", traces: ["pause-resume-absent", "credential-confinement"], forbiddenAccountScalars: [credentials.accessKeyId, credentials.secretAccessKey], taskContent, world: { kind: "aws-http", initialState: { codebuild: {}, s3: {} }, script: [] }, acts: [{ step: `01-${act}`, demand: demand(`codebuild-${id}`, `01-${act}`, act, null), expectedAccount: { version: 1, actIdentity: `codebuild-${id}-01-${act}`, runId: `scenario-codebuild-${id}`, allocationState: null, runState: null, providerTestimony: { kind: "silent" }, environmentStatus: emptyEnvironment, retention: null, outcome: { kind: "refusal", name: "unsupported-act", detail: null } }, expectedWorld: { requests: [], effects: { codebuild: {}, s3: {} }, environmentCount: 0 } }] });
}
function recovery(id: string, mode: "zero" | "one" | "multiple"): ProviderScenarioDescriptor {
  const found = build(id);
  const second = { ...build(id), id: `task-project:${id}-duplicate`, arn: `arn:aws:codebuild:us-east-1:123456789012:build/task-project:${id}-duplicate` };
  const ids = mode === "zero" ? [] : mode === "one" ? [found.id] : [found.id, second.id];
  const recoveryScripts = [successResponse({ ids }) , ...(ids.length ? [successResponse({ builds: mode === "one" ? [found] : [found, second], buildsNotFound: [] })] : [])];
  const lost = { request: {}, response: { kind: "connection-loss", phase: "after-apply", appliedEffect: {} }, externalEffect: {} };
  const scripts = [...launchScript(id, { build: found }).slice(0, 5), lost, lost, ...recoveryScripts];
  const baseRequests = launchRequests(id);
  const firstRequests = [...baseRequests, baseRequests[baseRequests.length - 1]!];
  const recoveryRequests = [signed("ListBuildsForProject", { projectName: "task-project", sortOrder: "DESCENDING" }), ...(ids.length ? [signed("BatchGetBuilds", { ids })] : [])];
  const lostState = runState(id, null, "lost-answer");
  const firstAccount = { version: 1, actIdentity: `codebuild-${id}-02-launch`, runId: `scenario-codebuild-${id}`, allocationState: { $expect: { kind: "binding", binding: prior("01-provision-allocations", ["allocationState"]) } }, runState: lostState, providerTestimony: { kind: "silent" }, environmentStatus: emptyEnvironment, retention: null, outcome: { kind: "lost-answer", operation: "aws-codebuild-start-build", detail: { projectName: "task-project" } } };
  const finalAccount = { version: 1, actIdentity: `codebuild-${id}-03-launch`, runId: `scenario-codebuild-${id}`, allocationState: { $expect: { kind: "binding", binding: prior("02-launch", ["allocationState"]) } }, runState: mode === "one" ? runState(id, found.id) : { $expect: { kind: "binding", binding: prior("02-launch", ["runState"]) } }, providerTestimony: mode === "one" ? { kind: "witnessed", standing: "pending", observedAt, native: expectedBuild(id) } : { kind: "silent" }, environmentStatus: emptyEnvironment, retention: null, outcome: mode === "multiple" ? { kind: "refusal", name: "aws-codebuild-launch-association-conflict", detail: null } : mode === "zero" ? { kind: "lost-answer", operation: "aws-codebuild-start-build", detail: { projectName: "task-project" } } : { kind: "witnessed" } };
  return document({ version: 1, id: `codebuild-${id}`, providerMember: "aws-codebuild", traces: ["recovery", "lost-answer", "credential-confinement"], forbiddenAccountScalars: [credentials.accessKeyId, credentials.secretAccessKey], taskContent, world: { kind: "aws-http", initialState: { codebuild: {}, s3: {} }, script: scripts }, acts: [
    { step: "01-provision-allocations", demand: demand(`codebuild-${id}`, "01-provision-allocations", "provision-allocations", null), expectedAccount: qualifiedAccount(id), expectedWorld: { requests: [qualificationRequest()], effects: { codebuild: {}, s3: {} }, environmentCount: 0 } },
    { step: "02-launch", demand: demand(`codebuild-${id}`, "02-launch", "launch", "01-provision-allocations"), expectedAccount: firstAccount, expectedWorld: { requests: firstRequests, effects: { codebuild: {}, s3: {} }, environmentCount: 1 } },
    { step: "03-launch", demand: demand(`codebuild-${id}`, "03-launch", "launch", "02-launch"), expectedAccount: finalAccount, expectedWorld: { requests: [...firstRequests, ...recoveryRequests], effects: { codebuild: {}, s3: {} }, environmentCount: 1 } },
  ] });
}
function s3GetRequest(id: string) {
  return { operation: "GetObject", method: "GET", path: expected(joined("/task-evidence/", runPrefixDerived(id), "/status/00000000000000000001.json")), query: { "x-id": "GetObject" }, body: null, authorization: { algorithm: "AWS4-HMAC-SHA256", accessKeyId: credentials.accessKeyId, date: awsDate, region: "us-east-1", service: "s3", signedHeaders: ["amz-sdk-invocation-id", "amz-sdk-request", "host", "x-amz-checksum-mode", "x-amz-content-sha256", "x-amz-date", "x-amz-user-agent"], signaturePresent: true }, signingDate: awsDate, conditional: { ifNoneMatch: null }, metadata: {} };
}
function environmentDescriptor(kind: "delivery" | "start" | "exit"): ProviderScenarioDescriptor {
  const id = `environment-${kind}`;
  const deliveryClaimed = { at: "2026-11-21T00:00:00.000Z" };
  const entryStarted = { at: "2026-11-21T00:00:01.000Z" };
  const report = kind === "delivery" ? { deliveryClaimed, entryStarted: null, entryExited: null, commandAcknowledgements: [] } : kind === "start" ? { deliveryClaimed, entryStarted, entryExited: null, commandAcknowledgements: [] } : { deliveryClaimed, entryStarted, entryExited: { at: "2026-11-21T00:00:02.000Z", exitEvidence: { kind: "code", code: 0 }, output: { kind: "document", document: { scenario: "aws-codebuild" } } }, commandAcknowledgements: [] };
  const listBody = resolve(joined("<?xml version=\"1.0\" encoding=\"UTF-8\"?><ListBucketResult xmlns=\"http://s3.amazonaws.com/doc/2006-03-01/\"><Name>task-evidence</Name><Prefix></Prefix><KeyCount>1</KeyCount><MaxKeys>1000</MaxKeys><IsTruncated>false</IsTruncated><Contents><Key>", runPrefixDerived(id), "/status/00000000000000000001.json</Key></Contents></ListBucketResult>"));
  const metadata = { "x-amz-meta-run-digest": runDigestValue(id), "x-amz-meta-configuration-digest": resolvedConfigurationDigest(), "x-amz-meta-archive-sha256": taskContent.archiveSha256, "x-amz-meta-tree-sha256": taskContent.treeSha256, "x-amz-meta-runner-sha256": resolve(bind("artifact", "linux-amd64-runner-sha256")) };
  const scripts = [...launchScript(id, { build: build(id) }), successResponse({ builds: [build(id)], buildsNotFound: [] }), successResponse(listBody, { "content-type": "application/xml" }), successResponse(JSON.stringify(report), metadata)];
  const requests = [...launchRequests(id), signed("BatchGetBuilds", { ids: [`task-project:${id}`] }), s3ListRequest(id), s3GetRequest(id)];
  return document({ version: 1, id: `codebuild-${id}`, providerMember: "aws-codebuild", traces: ["environment-testimony", `environment-${kind}`, "credential-confinement"], forbiddenAccountScalars: [credentials.accessKeyId, credentials.secretAccessKey], taskContent, world: { kind: "aws-http", initialState: { codebuild: {}, s3: {} }, script: scripts }, acts: [
    { step: "01-provision-allocations", demand: demand(`codebuild-${id}`, "01-provision-allocations", "provision-allocations", null), expectedAccount: qualifiedAccount(id), expectedWorld: { requests: [qualificationRequest()], effects: { codebuild: {}, s3: {} }, environmentCount: 0 } },
    { step: "02-launch", demand: demand(`codebuild-${id}`, "02-launch", "launch", "01-provision-allocations"), expectedAccount: acceptedLaunchAccount(id, expectedBuild(id)), expectedWorld: { requests: launchRequests(id), effects: { codebuild: {}, s3: {} }, environmentCount: 1 } },
    { step: "03-observe", demand: demand(`codebuild-${id}`, "03-observe", "observe", "02-launch"), expectedAccount: { version: 1, actIdentity: `codebuild-${id}-03-observe`, runId: `scenario-codebuild-${id}`, allocationState: { $expect: { kind: "binding", binding: prior("02-launch", ["allocationState"]) } }, runState: { ...runState(id, `task-project:${id}`, "accepted", "QUEUED"), carriage: { $expect: { kind: "binding", binding: prior("02-launch", ["runState", "carriage"]) } } }, providerTestimony: { kind: "witnessed", standing: "pending", observedAt, native: expectedBuild(id) }, environmentStatus: report, retention: null, outcome: { kind: "witnessed" } }, expectedWorld: { requests, effects: { codebuild: {}, s3: {} }, environmentCount: 1 } },
  ] });
}
function commandPutRequest(id: string, actIdentity: string) {
  const document = canonical({ version: 1, commandId: sha256(`cancel\0${actIdentity}`), command: "cancel", graceMilliseconds: 30 });
  return { ...s3PutRequest(id, "commands/00000000000000000001.json", literal(null)), body: { base64: Buffer.from(document).toString("base64"), utf8: document } };
}
function lifecycleDescriptor(id: string, act: "cancel" | "retire", mode: "witnessed" | "exhausted" | "terminal"): ProviderScenarioDescriptor {
  const actIdentity = `codebuild-${id}-03-${act}`;
  const live = build(id, "IN_PROGRESS");
  const stopped = build(id, "STOPPED");
  const scripts = [...launchScript(id, { build: build(id) })];
  const requests = [...launchRequests(id)];
  scripts.push(successResponse({ builds: [mode === "terminal" ? stopped : live], buildsNotFound: [] }));
  requests.push(signed("BatchGetBuilds", { ids: [`task-project:${id}`] }));
  if (mode !== "terminal") {
    if (act === "retire") {
      scripts.push(successResponse({ builds: [live], buildsNotFound: [] }));
      requests.push(signed("BatchGetBuilds", { ids: [`task-project:${id}`] }));
    }
    scripts.push(successResponse("", {}), successResponse({ build: live }));
    requests.push(commandPutRequest(id, actIdentity), signed("StopBuild", { id: `task-project:${id}` }));
    const polls = mode === "exhausted" ? 3 : 1;
    for (let index = 0; index < polls; index += 1) {
      scripts.push(successResponse({ builds: [mode === "witnessed" ? stopped : live], buildsNotFound: [] }));
      requests.push(signed("BatchGetBuilds", { ids: [`task-project:${id}`] }));
    }
  }
  const exhausted = mode === "exhausted";
  const finalState = mode === "terminal" ? runState(id, `task-project:${id}`, "accepted", "STOPPED") : { ...runState(id, `task-project:${id}`, "accepted", mode === "witnessed" ? "STOPPED" : null, 1) };
  const finalAccount = { version: 1, actIdentity, runId: `scenario-codebuild-${id}`, allocationState: { $expect: { kind: "binding", binding: prior("02-launch", ["allocationState"]) } }, runState: finalState, providerTestimony: exhausted ? { kind: "silent" } : { kind: "witnessed", standing: "gone", observedAt, native: expectedBuild(id, "STOPPED") }, environmentStatus: emptyEnvironment, retention: null, outcome: exhausted ? { kind: "lost-answer", operation: "aws-codebuild-stop-build", detail: { buildId: `task-project:${id}` } } : { kind: "witnessed" } };
  return document({ version: 1, id: `codebuild-${id}`, providerMember: "aws-codebuild", traces: [act, exhausted ? "lost-answer" : mode, "credential-confinement"], forbiddenAccountScalars: [credentials.accessKeyId, credentials.secretAccessKey], taskContent, world: { kind: "aws-http", initialState: { codebuild: {}, s3: {} }, script: scripts }, acts: [
    { step: "01-provision-allocations", demand: demand(`codebuild-${id}`, "01-provision-allocations", "provision-allocations", null), expectedAccount: qualifiedAccount(id), expectedWorld: { requests: [qualificationRequest()], effects: { codebuild: {}, s3: {} }, environmentCount: 0 } },
    { step: "02-launch", demand: demand(`codebuild-${id}`, "02-launch", "launch", "01-provision-allocations"), expectedAccount: acceptedLaunchAccount(id, expectedBuild(id)), expectedWorld: { requests: launchRequests(id), effects: { codebuild: {}, s3: {} }, environmentCount: 1 } },
    { step: `03-${act}`, demand: demand(`codebuild-${id}`, `03-${act}`, act, "02-launch"), expectedAccount: finalAccount, expectedWorld: { requests, effects: { codebuild: {}, s3: {} }, environmentCount: 1 } },
  ] });
}

export const awsCodeBuildScenarioCatalogue: ProviderScenarioDescriptor[] = [
  qualification("qualification-success", "success"), qualification("qualification-project-drift", "drift"), qualification("qualification-missing-project", "missing"), qualification("qualification-denial", "denial"),
  launchAccepted("launch-accepted"),
  recovery("recovery-zero", "zero"), recovery("recovery-one", "one"), recovery("recovery-multiple", "multiple"),
  ...["QUEUED", "IN_PROGRESS", "SUCCEEDED", "FAILED", "FAULT", "STOPPED", "TIMED_OUT", "unknown", "missing", "cross-project"].map((status) => observeDescriptor(status.toLowerCase(), status)),
  environmentDescriptor("delivery"), environmentDescriptor("start"), environmentDescriptor("exit"),
  lifecycleDescriptor("cancel-witnessed", "cancel", "witnessed"), lifecycleDescriptor("cancel-poll-exhaustion", "cancel", "exhausted"), lifecycleDescriptor("retire-live", "retire", "witnessed"), lifecycleDescriptor("retire-terminal", "retire", "terminal"),
  unsupported("unsupported-pause", "pause"), unsupported("unsupported-resume", "resume"),
];
