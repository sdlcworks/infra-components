import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { taskEnactmentDemand, type JSONValue, type TaskEnactmentAccount, type TaskProviderRealizationRuntime } from "@sdlcworks/components/task";
import { awsConfigurationDigest, awsDeliveryDocument, awsDeliverySha256, awsRunPrefix } from "../aws-common";
import * as awsCodeBuildBuildspec from "../aws-codebuild/buildspec";
import * as awsCodeBuildLaunch from "../aws-codebuild/launch";
import * as awsCodeBuildLifecycle from "../aws-codebuild/lifecycle";
import * as awsCodeBuildQualification from "../aws-codebuild/qualification";
import * as awsCodeBuildRecovery from "../aws-codebuild/recovery";
import * as awsEc2Guest from "../aws-ec2/guest";
import * as awsEc2Launch from "../aws-ec2/launch";
import * as awsEc2Lifecycle from "../aws-ec2/lifecycle";
import * as awsEc2Provision from "../aws-ec2/provision";
import * as awsLambdaLifecycle from "../aws-lambda/lifecycle";
import * as awsLambdaQualification from "../aws-lambda/qualification";
import type { ProviderScenarioDescriptor, ScenarioBinding, ScenarioDerived, ScenarioDerivedInput, ScenarioJoined, ScenarioJoinedPart, ScenarioWorld } from "../scenario";
import { recordedRequestBody, startAwsHttpWorld, type WorldObservation } from "./aws-http-world";
import { startKubernetesHttpsWorld } from "./kubernetes-https-world";

const members: Record<ProviderScenarioDescriptor["providerMember"], string> = {
  "aws-ec2": "aws-ec2", "aws-lambda": "aws-lambda",
  "aws-codebuild": "aws-codebuild", kubernetes: "kubernetes",
};
const artifactNames = new Set(["built-realization", "task-content-uri", "linux-amd64-runner-path", "linux-amd64-runner-sha256", "linux-arm64-runner-path", "linux-arm64-runner-sha256"]);
const worldNames = new Set(["aws-http-root", "kubernetes-https-root", "kubernetes-ca-pem", "kubernetes-client-certificate-pem", "kubernetes-client-private-key-pem"]);
const accountRoots = new Set(["allocationState", "runState", "environmentStatus"]);
const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));

export type DescriptorFailure = { provider: string; descriptor: string; shapeErrors: string[]; firstMismatch: string | null };
export type CatalogueReport = { failures: DescriptorFailure[] };
type Account = TaskEnactmentAccount<JSONValue, JSONValue>;
export type Build = { root: string; sidecar: any; bundle: string; bundleSha256: string; host: string; runners: Record<string, string>; realizations: Record<string, TaskProviderRealizationRuntime>; close(): void };
type TaskContent = ProviderScenarioDescriptor["taskContent"];

const sha256 = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

function walk(value: unknown, path: string, visit: (value: unknown, path: string) => void): void {
  visit(value, path);
  if (Array.isArray(value)) value.forEach((item, index) => walk(item, `${path}[${index}]`, visit));
  else if (object(value)) for (const [name, item] of Object.entries(value)) walk(item, path ? `${path}.${name}` : name, visit);
}

export function validateScenarioDescriptor(value: unknown): string[] {
  const errors: string[] = [];
  if (!object(value)) return ["descriptor: expected object"];
  const exact = ["version", "id", "providerMember", "traces", "forbiddenAccountScalars", "taskContent", "world", "acts"];
  for (const name of exact) if (!(name in value)) errors.push(`${name}: required`);
  for (const name of Object.keys(value)) if (!exact.includes(name)) errors.push(`${name}: unknown field`);
  if (value.version !== 1) errors.push("version: expected 1");
  if (typeof value.id !== "string" || !value.id) errors.push("id: expected nonempty string");
  if (!Object.keys(members).includes(String(value.providerMember))) errors.push("providerMember: unknown");
  if (!Array.isArray(value.traces) || value.traces.length === 0 || value.traces.some((item) => typeof item !== "string" || !item)) errors.push("traces: expected nonempty string array");
  if (!Array.isArray(value.forbiddenAccountScalars) || value.forbiddenAccountScalars.some((item) => typeof item !== "string" || !item)) errors.push("forbiddenAccountScalars: expected string array");
  if (!object(value.taskContent) || typeof value.taskContent.entry !== "string" || !object(value.taskContent.files) || !/^[0-9a-f]{64}$/.test(String(value.taskContent.archiveSha256)) || !/^[0-9a-f]{64}$/.test(String(value.taskContent.treeSha256))) errors.push("taskContent: invalid");
  if (!object(value.world) || !["aws-http", "kubernetes-https"].includes(String(value.world.kind)) || !Array.isArray(value.world.script)) errors.push("world: invalid");
  if (!Array.isArray(value.acts) || value.acts.length === 0) errors.push("acts: expected nonempty array");
  const steps = new Set<string>();
  const digest = "0".repeat(64);
  const validationBindings: Record<string, unknown> = {
    "built-realization": { schemas: { configuration: {}, credentials: {}, allocationState: {}, runState: {}, computeConstraints: {} }, supportedActs: [], runtimeEnvelope: { maximumRuntimeSeconds: null, admitsTimeoutAbsent: true }, address: { bundleIdentity: "validation", member: "validation" }, bundle: { uri: "file:///validation", archiveSha256: digest } },
    "task-content-uri": "file:///validation", "linux-amd64-runner-path": "/validation/amd64", "linux-amd64-runner-sha256": digest,
    "linux-arm64-runner-path": "/validation/arm64", "linux-arm64-runner-sha256": digest, "aws-http-root": "http://127.0.0.1:1",
    "kubernetes-https-root": "https://localhost:1", "kubernetes-ca-pem": "validation", "kubernetes-client-certificate-pem": "validation", "kubernetes-client-private-key-pem": "validation",
  };
  const validationAccounts = new Map<string, Account>();
  const dummyAccount: Account = { version: 1, actIdentity: "validation", runId: "validation", outcome: { kind: "witnessed" }, providerTestimony: { kind: "silent" }, environmentStatus: { deliveryClaimed: null, entryStarted: null, entryExited: null, commandAcknowledgements: [] }, allocationState: {}, runState: {}, retention: null };
  if (Array.isArray(value.acts)) value.acts.forEach((act, index) => {
    if (!object(act)) { errors.push(`acts[${index}]: expected object`); return; }
    if (typeof act.step !== "string" || !act.step) errors.push(`acts[${index}].step: expected nonempty string`);
    else if (steps.has(act.step)) errors.push(`acts[${index}].step: duplicate`); else steps.add(act.step);
    for (const field of ["demand", "expectedAccount", "expectedWorld"]) if (!(field in act)) errors.push(`acts[${index}].${field}: required`);
    if (object(act.expectedWorld) && (!Array.isArray(act.expectedWorld.requests) || !Number.isInteger(act.expectedWorld.environmentCount) || Number(act.expectedWorld.environmentCount) < 0 || !("effects" in act.expectedWorld))) errors.push(`acts[${index}].expectedWorld: invalid`);
    try { taskEnactmentDemand(resolveTemplate(act.demand, validationBindings, validationAccounts, String(act.step))); } catch (error) { errors.push(`acts[${index}].demand: ${String((error as Error).message)}`); }
    if (typeof act.step === "string" && act.step) validationAccounts.set(act.step, dummyAccount);
  });
  walk(value, "", (item, path) => {
    if (object(item) && "$resolve" in item) {
      const scriptedResponse = /^world\.script\[\d+\]\.response(?:\.|$)/.test(path);
      const literalInput = /\.inputs\.[^.]+\.value(?:\.|\[|$)/.test(path);
      if (!isDeepStrictEqual(Object.keys(item), ["$resolve"]) || (!scriptedResponse && !literalInput)) errors.push(`${path}: resolver location refused`);
      const resolver = item.$resolve;
      if (!object(resolver)) errors.push(`${path}: resolver form refused`);
      else if ("$scenario" in resolver) {
        validateBinding(resolver, `${path}.$resolve`, errors);
        if (scriptedResponse && object(resolver.$scenario) && resolver.$scenario.source === "account") errors.push(`${path}: account resolver refused at world seed`);
      }
      else if (resolver.kind === "derived") {
        validateDerivedMatcher(resolver, `${path}.$resolve`, errors);
        if (scriptedResponse) walk(resolver, `${path}.$resolve`, (nested, nestedPath) => {
          if (object(nested) && nested.kind === "account") errors.push(`${nestedPath}: account resolver refused at world seed`);
        });
      }
      else if (resolver.kind === "joined") validateJoined(resolver, `${path}.$resolve`, errors, scriptedResponse);
      else errors.push(`${path}: resolver form refused`);
    }
    if (object(item) && "$scenario" in item) {
      validateBinding(item, path, errors);
    }
    if (object(item) && "$expect" in item) {
      const matcher = item.$expect;
      if (!object(matcher)) errors.push(`${path}: invalid matcher`);
      else if (matcher.kind === "iso-8601" && !/(providerTestimony\.observedAt|retention\.expiresAt|runState(?:\.[^.[]+|\[\d+\])*\.[^.[]*WitnessedAt)$/.test(path)) errors.push(`${path}: iso-8601 matcher location refused`);
      else if (matcher.kind === "aws-amz-date" && !/(?:^|\.)(?:signingDate|authorization\.date)$/.test(path)) errors.push(`${path}: aws-amz-date matcher location refused`);
      else if (matcher.kind === "derived") validateDerivedMatcher(matcher, path, errors);
      else if (matcher.kind === "joined") validateJoined(matcher, path, errors, false);
      else if (!["binding", "iso-8601", "aws-amz-date"].includes(String(matcher.kind))) errors.push(`${path}: matcher kind refused`);
    }
  });
  return errors;
}

function validateBinding(item: Record<string, unknown>, path: string, errors: string[]): void {
  const binding = item as unknown as ScenarioBinding;
  const b = binding.$scenario;
  if (!object(b) || !isDeepStrictEqual(Object.keys(item), ["$scenario"]) || !isDeepStrictEqual(Object.keys(b).sort(), ["name", "path", "source", "step"]) || !["artifact", "world", "account"].includes(String(b.source)) || !Array.isArray(b.path)) errors.push(`${path}: invalid binding`);
  else if (b.source === "artifact" && (!artifactNames.has(b.name) || b.step !== null || b.path.length)) errors.push(`${path}: invalid artifact binding`);
  else if (b.source === "world" && (!worldNames.has(b.name) || b.step !== null || b.path.length)) errors.push(`${path}: invalid world binding`);
  else if (b.source === "account" && (b.name !== "account" || typeof b.step !== "string" || !b.step || b.path.length === 0 || !accountRoots.has(b.path[0]!))) errors.push(`${path}: invalid account binding`);
}

const derivedInputs: Record<string, string[]> = {
  "aws-configuration-digest": ["configuration"], "aws-run-prefix": ["carriage", "configurationDigest", "runDigest"], "aws-delivery-sha256": ["delivery"],
  "aws-delivery-document": ["runId", "content", "inputDocument", "runnerSha256", "bucket", "runPrefix", "association"],
  "kubernetes-delivery-sha256": ["bytes"], "kubernetes-delivery-payload": ["bytes"], "kubernetes-object-identity-digest": ["desired"],
  "kubernetes-run-suffix": ["runId", "configurationDigest"], "kubernetes-run-id-digest": ["runId"], "recorded-body": ["bytes"],
};

type LeafDerivation = { inputs: string[]; load: () => Promise<(...args: any[]) => unknown>; stringResult: boolean };
const leafDerivations: Record<string, LeafDerivation> = {
  "kubernetes-delivery-sha256": { inputs: ["bytes"], load: async () => (await import("../kubernetes/delivery")).kubernetesDeliverySha256, stringResult: true },
  "kubernetes-delivery-payload": { inputs: ["bytes"], load: async () => (await import("../kubernetes/delivery")).kubernetesDeliveryPayload, stringResult: true },
  "kubernetes-object-identity-digest": { inputs: ["desired"], load: async () => (await import("../kubernetes/lifecycle")).kubernetesObjectIdentityDigest, stringResult: true },
  "kubernetes-run-suffix": { inputs: ["runId", "configurationDigest"], load: async () => (await import("../kubernetes/names")).kubernetesRunSuffix, stringResult: true },
  "kubernetes-run-id-digest": { inputs: ["runId"], load: async () => (await import("../kubernetes/resources")).kubernetesRunIdDigest, stringResult: true },
};

const awsLeafModules: Record<"aws-lambda" | "aws-codebuild" | "aws-ec2", Array<Record<string, unknown>>> = {
  "aws-lambda": [awsLambdaQualification, awsLambdaLifecycle],
  "aws-codebuild": [awsCodeBuildBuildspec, awsCodeBuildLaunch, awsCodeBuildLifecycle, awsCodeBuildQualification, awsCodeBuildRecovery],
  "aws-ec2": [awsEc2Guest, awsEc2Launch, awsEc2Lifecycle, awsEc2Provision],
};

function awsLeafHelper(name: string): { helper: (...args: any[]) => unknown; inputs: string[] } | null {
  const owner = (Object.keys(awsLeafModules) as Array<keyof typeof awsLeafModules>).find((candidate) => name.startsWith(`${candidate}-`));
  if (!owner) return null;
  const exportName = name.slice(owner.length + 1);
  const matches = awsLeafModules[owner].map((module) => module[exportName]).filter((value): value is (...args: any[]) => unknown => typeof value === "function");
  if (matches.length !== 1) return null;
  const source = Function.prototype.toString.call(matches[0]);
  const parameters = source.match(/^[^(]*\(([^)]*)\)/)?.[1]?.split(",").map((parameter) => parameter.trim()).filter(Boolean);
  if (!parameters || parameters.some((parameter) => !/^[A-Za-z_$][\w$]*$/.test(parameter))) return null;
  return { helper: matches[0], inputs: parameters };
}

function validateJoined(joined: Record<string, unknown>, path: string, errors: string[], worldSeed: boolean): void {
  if (!isDeepStrictEqual(Object.keys(joined).sort(), ["kind", "parts"]) || !Array.isArray(joined.parts) || joined.parts.length < 2) {
    errors.push(`${path}: joined form refused`);
    return;
  }
  joined.parts.forEach((part, index) => {
    const partPath = `${path}.parts[${index}]`;
    if (typeof part === "string") return;
    if (!object(part)) { errors.push(`${partPath}: joined part refused`); return; }
    if ("$scenario" in part) {
      validateBinding(part, partPath, errors);
      if (worldSeed && object(part.$scenario) && part.$scenario.source === "account") errors.push(`${partPath}: account resolver refused at world seed`);
      return;
    }
    if (part.kind === "binding" && object(part.binding)) { validateBinding(part.binding, `${partPath}.binding`, errors); return; }
    if (part.kind === "account") {
      if (!isDeepStrictEqual(Object.keys(part).sort(), ["kind", "path", "step"]) || typeof part.step !== "string" || !part.step || typeof part.path !== "string" || !accountRoots.has(part.path.split(".")[0]!)) errors.push(`${partPath}: joined account part refused`);
      if (worldSeed) errors.push(`${partPath}: account resolver refused at world seed`);
      return;
    }
    if (part.kind === "derived") {
      validateDerivedMatcher(part, partPath, errors);
      const leaf = leafDerivations[String(part.name)];
      if (leaf && !leaf.stringResult) errors.push(`${partPath}: joined derived part refused`);
      return;
    }
    errors.push(`${partPath}: joined part refused`);
  });
}

function validateDerivedMatcher(matcher: Record<string, unknown>, path: string, errors: string[]): void {
  const name = String(matcher.name);
  const required = derivedInputs[name] ?? leafDerivations[name]?.inputs ?? awsLeafHelper(name)?.inputs;
  if (!required) { errors.push(`${path}: derived name refused`); return; }
  if (!object(matcher.inputs) || !isDeepStrictEqual(Object.keys(matcher.inputs).sort(), [...required].sort())) { errors.push(`${path}: derived inputs refused`); return; }
  if (name === "recorded-body" && !/^acts\[\d+\]\.expectedWorld\.requests(?:\[\d+\])?(?:\.|$)/.test(path)) errors.push(`${path}: recorded-body matcher location refused`);
  if (name === "aws-delivery-document" && !(/\.inputs\.(?:bytes|delivery)$/.test(path) || /\.\$resolve$/.test(path))) errors.push(`${path}: aws-delivery-document location refused`);
  for (const [inputName, input] of Object.entries(matcher.inputs)) {
    if (!object(input) || !["literal", "binding", "account", "runner-file", "task-archive", "slice", "derived"].includes(String(input.kind))) { errors.push(`${path}.inputs.${inputName}: derived input refused`); continue; }
    if (input.kind === "derived") {
      if (input.name !== "aws-delivery-document" || !((name === "recorded-body" && inputName === "bytes") || (name === "aws-delivery-sha256" && inputName === "delivery"))) errors.push(`${path}.inputs.${inputName}: nested derivation refused`);
      validateDerivedMatcher(input, `${path}.inputs.${inputName}`, errors);
      continue;
    }
    if (input.kind === "slice") {
      const source = input.of;
      if (!isDeepStrictEqual(Object.keys(input).sort(), ["kind", "lengthBytes", "of", "offsetBytes"]) || !Number.isSafeInteger(input.offsetBytes) || Number(input.offsetBytes) < 0 || !Number.isSafeInteger(input.lengthBytes) || Number(input.lengthBytes) < 0 || !object(source) || !["runner-file", "task-archive"].includes(String(source.kind))) { errors.push(`${path}.inputs.${inputName}: slice input refused`); continue; }
      const sourceFields = source.kind === "runner-file" ? ["binding", "kind"] : ["kind"];
      if (!isDeepStrictEqual(Object.keys(source).sort(), sourceFields) || (source.kind === "runner-file" && !["linux-amd64-runner-path", "linux-arm64-runner-path"].includes(String(source.binding)))) errors.push(`${path}.inputs.${inputName}: slice input refused`);
      if (!(name === "recorded-body" || name === "aws-delivery-sha256" || name.startsWith("kubernetes-"))) errors.push(`${path}.inputs.${inputName}: byte input refused`);
      continue;
    }
    const fields = input.kind === "literal" ? ["kind", "value"] : input.kind === "binding" ? ["binding", "kind"] : input.kind === "account" ? ["kind", "path", "step"] : input.kind === "runner-file" ? ["binding", "kind"] : ["kind"];
    if (!isDeepStrictEqual(Object.keys(input).sort(), fields)) errors.push(`${path}.inputs.${inputName}: derived input refused`);
    if (input.kind === "runner-file" && !["linux-amd64-runner-path", "linux-arm64-runner-path"].includes(String(input.binding))) errors.push(`${path}.inputs.${inputName}: derived input refused`);
    if ((input.kind === "runner-file" || input.kind === "task-archive") && !(name === "recorded-body" || name === "aws-delivery-sha256" || name.startsWith("kubernetes-"))) errors.push(`${path}.inputs.${inputName}: byte input refused`);
    if (name === "recorded-body" && inputName === "bytes" && input.kind !== "runner-file" && input.kind !== "task-archive") errors.push(`${path}.inputs.${inputName}: recorded-body bytes input refused`);
  }
}

function getPath(value: unknown, path: string[]): unknown { let cursor = value; for (const part of path) { if (!object(cursor) && !Array.isArray(cursor)) throw new Error(`path-refused:${path.join(".")}`); cursor = (cursor as any)[part]; } return cursor; }
function resolveBinding(binding: ScenarioBinding, bindings: Record<string, unknown>, accounts: Map<string, Account>, currentStep?: string): unknown {
  const spec = binding.$scenario;
  if (spec.source === "account") {
    if (!spec.step || spec.step === currentStep || !accounts.has(spec.step)) throw new Error(`account-binding-forward-or-unknown:${spec.step}`);
    return getPath(accounts.get(spec.step), spec.path);
  }
  const value = bindings[spec.name];
  if (value === undefined) throw new Error(`binding-unresolved:${spec.source}/${spec.name}`);
  return getPath(value, spec.path);
}
function resolveTemplate(value: unknown, bindings: Record<string, unknown>, accounts: Map<string, Account>, step?: string, validation = false): any {
  if (object(value) && "$scenario" in value) return validation ? null : resolveBinding(value as unknown as ScenarioBinding, bindings, accounts, step);
  if (Array.isArray(value)) return value.map((item) => resolveTemplate(item, bindings, accounts, step, validation));
  if (object(value)) return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, resolveTemplate(item, bindings, accounts, step, validation)]));
  return value;
}

function runnerPath(root: string, arch: string): string {
  const env = process.env[arch === "amd64" ? "SDLC_TEST_RUNNER_AMD64" : "SDLC_TEST_RUNNER_ARM64"];
  if (env) return resolve(env);
  const output = join(root, `runner-${arch}`);
  const result = spawnSync("go", ["build", "-buildvcs=false", "-o", output, "./cmd/sdlc-task-runner"], { cwd: resolve("../go"), env: { ...process.env, CGO_ENABLED: "0", GOOS: "linux", GOARCH: arch }, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`runner-build-${arch}-failed:${result.stderr}`);
  return output;
}

export function buildProviderHarness(): Build {
  const root = mkdtempSync(join(tmpdir(), "built-provider-harness-"));
  const repository = resolve("..");
  const build = spawnSync("bun", [join(repository, "js/apps/components-build/dist/index.js"), "--bundle"], { cwd: resolve("."), encoding: "utf8" });
  if (build.status !== 0) { rmSync(root, { recursive: true, force: true }); throw new Error(`infra-build-failed:${build.stderr}`); }
  const bundle = resolve(".js/infra-bundle.tar.gz");
  const sidecar = JSON.parse(readFileSync(resolve(".js/metadata.json"), "utf8"));
  const bundleSha256 = sha256(readFileSync(bundle));
  const realizations: Record<string, TaskProviderRealizationRuntime> = {};
  for (const [provider, member] of Object.entries(members)) {
    const metadata = sidecar.task_provider_realizations?.[member];
    if (!metadata) throw new Error(`built-provider-missing:${member}`);
    realizations[provider] = {
      schemas: {
        configuration: metadata.schemas.configuration,
        credentials: metadata.schemas.credentials,
        allocationState: metadata.schemas.allocation_state,
        runState: metadata.schemas.run_state,
        computeConstraints: metadata.schemas.compute_constraints,
      },
      supportedActs: metadata.supported_acts,
      runtimeEnvelope: { maximumRuntimeSeconds: metadata.runtime_envelope.maximum_runtime_seconds, admitsTimeoutAbsent: metadata.runtime_envelope.admits_timeout_absent },
      address: { bundleIdentity: sha256(readFileSync(bundle)), member },
      bundle: { uri: pathToFileURL(bundle).href, archiveSha256: bundleSha256 },
    };
  }
  const runners = { amd64: runnerPath(root, "amd64"), arm64: runnerPath(root, "arm64") };
  return { root, sidecar, bundle, bundleSha256, host: resolve("../js/apps/task-provider-host/dist/index.js"), runners, realizations, close: () => rmSync(root, { recursive: true, force: true }) };
}

function materializeTaskContent(taskContent: TaskContent, id: string, root: string): { uri: string; archive: Buffer } {
  const source = join(root, "content-source"); const output = join(root, "content-output"); mkdirSync(source, { recursive: true });
  for (const [name, content] of Object.entries(taskContent.files)) { if (name.startsWith("/") || name.split("/").includes("..")) throw new Error("task-content-path-refused"); const path = join(source, name); mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, content); }
  const driver = `import { captureTaskContent } from ${JSON.stringify(pathToFileURL(join(repositoryRoot, "js/apps/components-build/src/lib/taskContent.ts")).href)}; process.stdout.write(JSON.stringify(captureTaskContent(process.argv[1], process.argv[2], process.argv[3])));`;
  const result = spawnSync("bun", ["--target=node", "-e", driver, source, output, id], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`task-content-capture-failed:${result.stderr}`);
  const captured = JSON.parse(result.stdout) as { locator: string; archiveSha256: string; treeSha256: string };
  if (captured.archiveSha256 !== taskContent.archiveSha256 || captured.treeSha256 !== taskContent.treeSha256) throw new Error(`task-content-digest-mismatch:expected=${taskContent.archiveSha256}/${taskContent.treeSha256}:observed=${captured.archiveSha256}/${captured.treeSha256}`);
  const archivePath = join(output, captured.locator);
  return { uri: pathToFileURL(archivePath).href, archive: readFileSync(archivePath) };
}

function invokeHost(host: string, workRoot: string, demand: unknown): Promise<Account> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("node", [host, "enact"], { env: { ...process.env, SDLC_TASK_PROVIDER_HOST_WORK_ROOT: workRoot }, stdio: ["pipe", "pipe", "pipe"] });
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk))); child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    child.on("error", reject); child.on("close", (code) => code === 0 ? resolvePromise(JSON.parse(Buffer.concat(stdout).toString("utf8")) as Account) : reject(new Error(`host-exit-${code}:${Buffer.concat(stderr).toString("utf8")}`)));
    child.stdin.end(JSON.stringify(demand));
  });
}

async function derived(name: string, inputs: Record<string, unknown>): Promise<unknown> {
  const exact = (required: string[]) => { if (!isDeepStrictEqual(Object.keys(inputs).sort(), [...required].sort())) throw new Error(`derived-inputs:${name}`); };
  if (name === "aws-configuration-digest") { exact(["configuration"]); return awsConfigurationDigest(inputs.configuration); }
  if (name === "aws-run-prefix") { exact(["carriage", "configurationDigest", "runDigest"]); return awsRunPrefix(inputs.carriage as any, String(inputs.configurationDigest), String(inputs.runDigest)); }
  if (name === "aws-delivery-sha256") { exact(["delivery"]); return awsDeliverySha256(inputs.delivery as Uint8Array); }
  if (name === "aws-delivery-document") { exact(["runId", "content", "inputDocument", "runnerSha256", "bucket", "runPrefix", "association"]); return awsDeliveryDocument(String(inputs.runId), inputs.content as any, inputs.inputDocument as JSONValue, String(inputs.runnerSha256), String(inputs.bucket), String(inputs.runPrefix), inputs.association as any); }
  if (name === "recorded-body") { exact(["bytes"]); return recordedRequestBody(inputs.bytes as Uint8Array); }
  const leaf = leafDerivations[name];
  if (leaf) { exact(leaf.inputs); return (await leaf.load())(...leaf.inputs.map((input) => inputs[input])); }
  const awsHelper = awsLeafHelper(name);
  if (!awsHelper) throw new Error(`derived-name-refused:${name}`);
  exact(awsHelper.inputs);
  return awsHelper.helper(...awsHelper.inputs.map((input) => inputs[input]));
}

async function joinedValue(joined: ScenarioJoined, bindings: Record<string, unknown>, accounts: Map<string, Account>, current: string, taskArchive: Buffer): Promise<string> {
  const parts = await Promise.all(joined.parts.map(async (part: ScenarioJoinedPart) => {
    if (typeof part === "string") return part;
    if ("$scenario" in part) return resolveBinding(part, bindings, accounts, current);
    if (part.kind === "binding") return resolveBinding(part.binding, bindings, accounts, current);
    if (part.kind === "account") return inputValue(part, bindings, accounts, current, taskArchive);
    const inputs = Object.fromEntries(await Promise.all(Object.entries(part.inputs).map(async ([name, input]) => [name, await inputValue(input, bindings, accounts, current, taskArchive)])));
    return derived(part.name, inputs);
  }));
  if (parts.some((part) => typeof part !== "string")) throw new Error("joined-part-not-string");
  return parts.join("");
}

async function inputValue(input: ScenarioDerivedInput, bindings: Record<string, unknown>, accounts: Map<string, Account>, current: string, taskArchive: Buffer): Promise<unknown> {
  if (input.kind === "derived") {
    const inputs = Object.fromEntries(await Promise.all(Object.entries(input.inputs).map(async ([name, nested]) => [name, await inputValue(nested, bindings, accounts, current, taskArchive)])));
    return derived(input.name, inputs);
  }
  if (input.kind === "literal") return resolveEmbedded(input.value, bindings, accounts, current, taskArchive);
  if (input.kind === "binding") return resolveBinding(input.binding, bindings, accounts, current);
  if (input.kind === "account") { const path = input.path.split(".").filter(Boolean); if (!accounts.has(input.step) || input.step === current || !accountRoots.has(path[0]!)) throw new Error("derived-account-refused"); return getPath(accounts.get(input.step), path); }
  if (input.kind === "task-archive") return taskArchive;
  if (input.kind === "slice") {
    const bytes = await inputValue(input.of, bindings, accounts, current, taskArchive) as Uint8Array;
    const end = input.offsetBytes + input.lengthBytes;
    if (end > bytes.byteLength) throw new Error("slice-out-of-range");
    return bytes.subarray(input.offsetBytes, end);
  }
  const path = String(bindings[input.binding]); return readFileSync(path);
}

async function resolveEmbedded(value: unknown, bindings: Record<string, unknown>, accounts: Map<string, Account>, current: string, taskArchive: Buffer): Promise<any> {
  if (object(value) && "$resolve" in value) {
    if (!isDeepStrictEqual(Object.keys(value), ["$resolve"]) || !object(value.$resolve)) throw new Error("resolver-form-refused");
    const resolver = value.$resolve as unknown as ScenarioBinding | ScenarioDerived | ScenarioJoined;
    if ("$scenario" in resolver) return resolveBinding(resolver, bindings, accounts, current);
    if (resolver.kind === "joined") return joinedValue(resolver, bindings, accounts, current, taskArchive);
    if (resolver.kind !== "derived" || !object(resolver.inputs)) throw new Error("resolver-form-refused");
    const inputs = Object.fromEntries(await Promise.all(Object.entries(resolver.inputs).map(async ([name, input]) => [name, await inputValue(input, bindings, accounts, current, taskArchive)])));
    return derived(resolver.name, inputs);
  }
  if (Array.isArray(value)) return Promise.all(value.map((item) => resolveEmbedded(item, bindings, accounts, current, taskArchive)));
  if (object(value)) return Object.fromEntries(await Promise.all(Object.entries(value).map(async ([name, item]) => [name, await resolveEmbedded(item, bindings, accounts, current, taskArchive)])));
  return value;
}

async function resolveWorldTemplate(value: unknown, bindings: Record<string, unknown>, taskArchive: Buffer): Promise<any> {
  return resolveEmbedded(value, bindings, new Map(), "world-seed", taskArchive);
}

export async function resolveScenarioWorld(world: ScenarioWorld, bindings: Record<string, unknown>, taskArchive: Buffer): Promise<ScenarioWorld> {
  return resolveWorldTemplate(world, bindings, taskArchive);
}

async function compare(expected: unknown, actual: unknown, path: string, anchor: number, bindings: Record<string, unknown>, accounts: Map<string, Account>, step: string, taskArchive: Buffer): Promise<string | null> {
  if (object(expected) && "$expect" in expected) {
    const matcher = expected.$expect as any;
    if (matcher.kind === "binding") return compare(resolveBinding(matcher.binding, bindings, accounts, step), actual, path, anchor, bindings, accounts, step, taskArchive);
    if (matcher.kind === "derived") { const inputs = Object.fromEntries(await Promise.all(Object.entries(matcher.inputs).map(async ([name, input]) => [name, await inputValue(input as ScenarioDerivedInput, bindings, accounts, step, taskArchive)]))); return compare(await derived(matcher.name, inputs), actual, path, anchor, bindings, accounts, step, taskArchive); }
    if (matcher.kind === "joined") return compare(await joinedValue(matcher, bindings, accounts, step, taskArchive), actual, path, anchor, bindings, accounts, step, taskArchive);
    if (typeof actual !== "string") return `${path}: expected timestamp, observed ${JSON.stringify(actual)}`;
    const wanted = anchor + matcher.offsetSeconds * 1000;
    if (matcher.kind === "aws-amz-date" && /(?:^|\.)authorization\.date$/.test(path)) {
      if (!/^\d{8}$/.test(actual)) return `${path}: timestamp outside ${wanted}±${matcher.toleranceMilliseconds}, observed ${actual}`;
      const day = (instant: number) => new Date(instant).toISOString().slice(0, 10).replace(/-/g, "");
      const windowStart = wanted - matcher.toleranceMilliseconds;
      const windowEnd = wanted + matcher.toleranceMilliseconds;
      return actual === day(windowStart) || actual === day(windowEnd) ? null : `${path}: timestamp outside ${wanted}±${matcher.toleranceMilliseconds}, observed ${actual}`;
    }
    const observed = matcher.kind === "aws-amz-date"
      ? /^\d{8}T\d{6}Z$/.test(actual) ? Date.parse(actual.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/, "$1-$2-$3T$4:$5:$6Z")) : Number.NaN
      : Date.parse(actual);
    return Number.isFinite(observed) && Math.abs(observed - wanted) <= matcher.toleranceMilliseconds ? null : `${path}: timestamp outside ${wanted}±${matcher.toleranceMilliseconds}, observed ${actual}`;
  }
  if (Array.isArray(expected)) { if (!Array.isArray(actual) || expected.length !== actual.length) return `${path}: expected ${JSON.stringify(expected)}, observed ${JSON.stringify(actual)}`; for (let index = 0; index < expected.length; index++) { const mismatch = await compare(expected[index], actual[index], `${path}[${index}]`, anchor, bindings, accounts, step, taskArchive); if (mismatch) return mismatch; } return null; }
  if (object(expected)) { if (!object(actual) || !isDeepStrictEqual(Object.keys(expected).sort(), Object.keys(actual).sort())) return `${path}: expected keys ${Object.keys(expected)}, observed ${object(actual) ? Object.keys(actual) : JSON.stringify(actual)}`; for (const name of Object.keys(expected)) { const mismatch = await compare(expected[name], actual[name], `${path}.${name}`, anchor, bindings, accounts, step, taskArchive); if (mismatch) return mismatch; } return null; }
  return isDeepStrictEqual(expected, actual) ? null : `${path}: expected ${JSON.stringify(expected)}, observed ${JSON.stringify(actual)}`;
}

export async function executeDescriptor(build: Build, descriptor: ProviderScenarioDescriptor): Promise<string | null> {
  const root = mkdtempSync(join(build.root, `${descriptor.id}-`));
  const taskContent = materializeTaskContent(descriptor.taskContent, descriptor.id, root);
  const seedBindings: Record<string, unknown> = { "built-realization": build.realizations[descriptor.providerMember], "task-content-uri": taskContent.uri, "linux-amd64-runner-path": build.runners.amd64, "linux-amd64-runner-sha256": sha256(readFileSync(build.runners.amd64)), "linux-arm64-runner-path": build.runners.arm64, "linux-arm64-runner-sha256": sha256(readFileSync(build.runners.arm64)) };
  const worldSeed = structuredClone(descriptor.world);
  const world = worldSeed.kind === "aws-http" ? await startAwsHttpWorld(worldSeed) : await startKubernetesHttpsWorld(worldSeed);
  try {
    const taskContentUri = taskContent.uri;
    const bindings: Record<string, unknown> = { ...seedBindings, ...world.bindings, "task-content-uri": taskContentUri };
    Object.assign(worldSeed, await resolveScenarioWorld(worldSeed, bindings, taskContent.archive));
    const accounts = new Map<string, Account>();
    for (const act of descriptor.acts) {
      const anchor = Date.now();
      let demand: any; try { demand = taskEnactmentDemand(resolveTemplate(act.demand, bindings, accounts, act.step)); } catch (error) { return `${act.step}.demand: ${String((error as Error).message)}`; }
      const account = await invokeHost(build.host, join(root, "host"), demand);
      for (const forbidden of descriptor.forbiddenAccountScalars) if (JSON.stringify(account).includes(forbidden)) return `${act.step}.account: forbidden scalar ${forbidden}`;
      const accountMismatch = await compare(act.expectedAccount, account, `${act.step}.account`, anchor, bindings, accounts, act.step, taskContent.archive); if (accountMismatch) return accountMismatch;
      const observed: WorldObservation = world.observation();
      const requestMismatch = await compare(act.expectedWorld.requests, observed.requests, `${act.step}.requests`, anchor, bindings, accounts, act.step, taskContent.archive); if (requestMismatch) return requestMismatch;
      const effectMismatch = await compare(act.expectedWorld.effects, observed.effects, `${act.step}.effects`, anchor, bindings, accounts, act.step, taskContent.archive); if (effectMismatch) return effectMismatch;
      if (act.expectedWorld.environmentCount !== observed.environmentCount) return `${act.step}.environmentCount: expected ${act.expectedWorld.environmentCount}, observed ${observed.environmentCount}`;
      accounts.set(act.step, account);
    }
    return null;
  } finally { await world.close(); }
}

export function materializeScenarioTaskArchive(build: Build, taskContent: TaskContent): Buffer {
  return materializeTaskContent(taskContent, "plumbing-self-check", mkdtempSync(join(build.root, "matcher-"))).archive;
}

export async function evaluateScenarioExpectation(build: Build, taskContent: TaskContent, expected: unknown, actual: unknown, anchor = Date.now()): Promise<string | null> {
  const archive = materializeScenarioTaskArchive(build, taskContent);
  const bindings: Record<string, unknown> = { "linux-amd64-runner-path": build.runners.amd64, "linux-arm64-runner-path": build.runners.arm64 };
  return compare(expected, actual, "acts[0].expectedWorld.requests[0].body", anchor, bindings, new Map(), "self-check", archive);
}

export async function inspectCatalogues(build: Build, catalogues: ProviderScenarioDescriptor[][]): Promise<CatalogueReport> {
  const failures: DescriptorFailure[] = [];
  for (const catalogue of catalogues) for (const descriptor of catalogue as unknown[]) {
    const shapeErrors = validateScenarioDescriptor(descriptor);
    let firstMismatch: string | null = null;
    if (shapeErrors.length === 0) { try { firstMismatch = await executeDescriptor(build, descriptor as ProviderScenarioDescriptor); } catch (error) { firstMismatch = String((error as Error).message); } }
    failures.push({ provider: object(descriptor) && typeof descriptor.providerMember === "string" ? descriptor.providerMember : "<invalid-provider>", descriptor: object(descriptor) && typeof descriptor.id === "string" ? descriptor.id : "<invalid-id>", shapeErrors, firstMismatch });
  }
  return { failures };
}
