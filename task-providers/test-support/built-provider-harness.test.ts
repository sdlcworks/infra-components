import { readFileSync } from "node:fs";
import https from "node:https";
import type { ProviderScenarioDescriptor, ScenarioBinding, ScenarioExpectation } from "../scenario";
import { buildProviderHarness, executeDescriptor, evaluateScenarioExpectation, materializeScenarioTaskArchive, resolveScenarioWorld, validateScenarioDescriptor } from "./built-provider-harness";
import { recordedRequestBody } from "./aws-http-world";
import { awsEc2ScenarioTaskContent } from "../aws-ec2/scenario-task-content";
import { startKubernetesHttpsWorld } from "./kubernetes-https-world";
import { awsConfigurationDigest, sha256, stageAwsDelivery } from "../aws-common";

const binding = (source: "artifact" | "world", name: string): ScenarioBinding => ({ $scenario: { source, name, step: null, path: [] } });
const emptyEnvironment = { deliveryClaimed: null, entryStarted: null, entryExited: null, commandAcknowledgements: [] };

test("plumbing resolves built artifacts, serializes demand, captures content, and records an untouched world", { timeout: 30_000 }, async () => {
  const descriptor = {
    version: 1,
    id: "harness-plumbing-unsupported-pause",
    providerMember: "aws-codebuild",
    traces: ["harness plumbing only"],
    forbiddenAccountScalars: [],
    taskContent: awsEc2ScenarioTaskContent,
    world: { kind: "aws-http", initialState: {}, script: [] },
    acts: [{
      step: "refuse",
      demand: {
        version: 1, actIdentity: "harness-refuse", act: "pause", runId: "harness-run",
        definition: {
          address: { bundleIdentity: "harness-task", member: "scenario" },
          content: { uri: binding("artifact", "task-content-uri"), archiveSha256: awsEc2ScenarioTaskContent.archiveSha256, treeSha256: awsEc2ScenarioTaskContent.treeSha256 },
          entry: { flakeSelector: awsEc2ScenarioTaskContent.entry },
          schemas: { input: { type: "object", properties: {}, required: [], additionalProperties: false }, output: { type: "object", properties: {}, required: [], additionalProperties: false } },
          meta: { timeout: { mode: "absent" }, computeConstraints: {}, confidentialInputPaths: [] },
        },
        realization: binding("artifact", "built-realization"), inputDocument: {}, configuration: {}, credentials: {}, allocationState: null, runState: null,
        environmentStatus: emptyEnvironment,
        runners: {
          linuxAmd64: { path: binding("artifact", "linux-amd64-runner-path"), sha256: binding("artifact", "linux-amd64-runner-sha256") },
          linuxArm64: { path: binding("artifact", "linux-arm64-runner-path"), sha256: binding("artifact", "linux-arm64-runner-sha256") }, maximumOutputBytes: 1024,
        },
      },
      expectedAccount: {
        version: 1, actIdentity: "harness-refuse", runId: "harness-run", outcome: { kind: "refusal", name: "unsupported-act", detail: null },
        providerTestimony: { kind: "silent" }, environmentStatus: emptyEnvironment, allocationState: null, runState: null, retention: null,
      },
      expectedWorld: { requests: [], effects: {}, environmentCount: 0 },
    }],
  } as unknown as ProviderScenarioDescriptor;
  assert.deepEqual(validateScenarioDescriptor(descriptor), []);
  const harness = buildProviderHarness();
  try { assert.equal(await executeDescriptor(harness, descriptor), null); }
  finally { harness.close(); }
});

test("plumbing matches recorded request bodies from runner and task archive bytes", { timeout: 30_000 }, async () => {
  const harness = buildProviderHarness();
  try {
    const runner = readFileSync(harness.runners.amd64);
    const runnerExpectation = { $expect: { kind: "derived", name: "recorded-body", inputs: { bytes: { kind: "runner-file", binding: "linux-amd64-runner-path" } } } } satisfies ScenarioExpectation<unknown>;
    assert.equal(await evaluateScenarioExpectation(harness, awsEc2ScenarioTaskContent, runnerExpectation, recordedRequestBody(runner)), null);

    const archiveExpectation = { $expect: { kind: "derived", name: "recorded-body", inputs: { bytes: { kind: "task-archive" } } } } satisfies ScenarioExpectation<unknown>;
    const archive = materializeScenarioTaskArchive(harness, awsEc2ScenarioTaskContent);
    assert.equal(await evaluateScenarioExpectation(harness, awsEc2ScenarioTaskContent, archiveExpectation, recordedRequestBody(archive)), null);
  } finally { harness.close(); }
});

test("plumbing matches AWS signing timestamps and credential-scope days at their exact locations", { timeout: 30_000 }, async () => {
  const matcher = { $expect: { kind: "aws-amz-date", anchor: "step-start", offsetSeconds: 0, toleranceMilliseconds: 1_000 } } as const;
  for (const request of [{ signingDate: matcher }, { authorization: { date: matcher } }]) {
    const accepted = structuredClone(baseDescriptor()) as any;
    accepted.acts[0].expectedWorld.requests = [request];
    assert.doesNotMatch(validateScenarioDescriptor(accepted).join("\n"), /aws-amz-date matcher location refused/);
  }

  const refused = structuredClone(baseDescriptor()) as any;
  refused.acts[0].expectedWorld.requests = [{ date: matcher }];
  assert.match(validateScenarioDescriptor(refused).join("\n"), /aws-amz-date matcher location refused/);

  const harness = buildProviderHarness();
  const anchor = Date.UTC(2026, 10, 21, 3, 55, 52);
  try {
    assert.equal(await evaluateScenarioExpectation(harness, awsEc2ScenarioTaskContent, { signingDate: matcher }, { signingDate: "20261121T035552Z" }, anchor), null);
    assert.equal(await evaluateScenarioExpectation(harness, awsEc2ScenarioTaskContent, { authorization: { date: matcher } }, { authorization: { date: "20261121" } }, anchor), null);
    assert.match(String(await evaluateScenarioExpectation(harness, awsEc2ScenarioTaskContent, { signingDate: matcher }, { signingDate: "20261121" }, anchor)), /timestamp outside/);
    assert.match(String(await evaluateScenarioExpectation(harness, awsEc2ScenarioTaskContent, { authorization: { date: matcher } }, { authorization: { date: "20261121T035552Z" } }, anchor)), /timestamp outside/);

    const midnightMatcher = { $expect: { ...matcher.$expect, toleranceMilliseconds: 1_000 } } as const;
    const midnightAnchor = Date.UTC(2026, 10, 22, 0, 0, 0);
    assert.equal(await evaluateScenarioExpectation(harness, awsEc2ScenarioTaskContent, { authorization: { date: midnightMatcher } }, { authorization: { date: "20261121" } }, midnightAnchor), null);
    assert.equal(await evaluateScenarioExpectation(harness, awsEc2ScenarioTaskContent, { authorization: { date: midnightMatcher } }, { authorization: { date: "20261122" } }, midnightAnchor), null);
  } finally { harness.close(); }
});

test("plumbing accepts realization-witnessed run-state instants only at WitnessedAt fields", () => {
  const matcher = { $expect: { kind: "iso-8601", anchor: "step-start", offsetSeconds: 0, toleranceMilliseconds: 1_000 } } as const;
  const accepted = structuredClone(baseDescriptor()) as any;
  accepted.acts[0].expectedAccount.runState = { pauseWitnessedAt: matcher };
  assert.doesNotMatch(validateScenarioDescriptor(accepted).join("\n"), /iso-8601 matcher location refused/);

  const refused = structuredClone(baseDescriptor()) as any;
  refused.acts[0].expectedAccount.runState = { witnessedAt: matcher };
  assert.match(validateScenarioDescriptor(refused).join("\n"), /iso-8601 matcher location refused/);
});

test("plumbing dispatches AWS leaf helpers through the owning realization", { timeout: 30_000 }, async () => {
  const inputs = {
    configurationDigest: { kind: "literal", value: "1".repeat(64) },
    bucket: { kind: "literal", value: "qualification-bucket" },
    prefix: { kind: "literal", value: "qualification-prefix" },
  } as const;
  const expectation = { $expect: { kind: "derived", name: "aws-lambda-lambdaQualificationProbeIdentity", inputs } } satisfies ScenarioExpectation<string>;
  const harness = buildProviderHarness();
  try {
    const { lambdaQualificationProbeIdentity } = await import("../aws-lambda/qualification");
    assert.equal(await evaluateScenarioExpectation(harness, awsEc2ScenarioTaskContent, expectation, lambdaQualificationProbeIdentity("1".repeat(64), "qualification-bucket", "qualification-prefix")), null);
  } finally { harness.close(); }
});

test("plumbing resolves exact byte slices and refuses out-of-range windows", { timeout: 30_000 }, async () => {
  const harness = buildProviderHarness();
  try {
    const archive = materializeScenarioTaskArchive(harness, awsEc2ScenarioTaskContent);
    const offsetBytes = archive.length - 7;
    const expectation = { $expect: { kind: "derived", name: "recorded-body", inputs: { bytes: { kind: "slice", of: { kind: "task-archive" }, offsetBytes, lengthBytes: 7 } } } } satisfies ScenarioExpectation<unknown>;
    assert.equal(await evaluateScenarioExpectation(harness, awsEc2ScenarioTaskContent, expectation, recordedRequestBody(archive.subarray(offsetBytes))), null);

    const invalid = structuredClone(baseDescriptor()) as any;
    invalid.acts[0].expectedWorld.requests = [{ body: { $expect: { kind: "derived", name: "recorded-body", inputs: { bytes: { kind: "slice", of: { kind: "task-archive" }, offsetBytes: -1, lengthBytes: 1 } } } } }];
    assert.match(validateScenarioDescriptor(invalid).join("\n"), /slice input refused/);

    const outOfRange = { $expect: { kind: "derived", name: "recorded-body", inputs: { bytes: { kind: "slice", of: { kind: "task-archive" }, offsetBytes: archive.length - 3, lengthBytes: 4 } } } } satisfies ScenarioExpectation<unknown>;
    await assert.rejects(evaluateScenarioExpectation(harness, awsEc2ScenarioTaskContent, outOfRange, null), /slice-out-of-range/);
  } finally { harness.close(); }
});

test("plumbing derives the staged AWS delivery document body and digest", { timeout: 30_000 }, async () => {
  const archive = Buffer.from("archive");
  const runner = Buffer.from("runner");
  const content = { uri: "file:///task.tar.gz", archiveSha256: sha256(archive), treeSha256: "1".repeat(64) };
  const runnerSha256 = sha256(runner);
  const runId = "delivery-derivation-run";
  const bucket = "delivery-bucket";
  const prefix = "task-provider";
  const configuration = { statusCarriage: { bucket, prefix } };
  const configurationDigest = awsConfigurationDigest(configuration);
  const runDigest = sha256(runId);
  const runPrefix = `${prefix}/relationships/${configurationDigest}/runs/${runDigest}`;
  const association = { runDigest, configurationDigest, archiveSha256: content.archiveSha256, treeSha256: content.treeSha256, runnerSha256 };
  const uploads = new Map<string, Uint8Array>();
  const state = await stageAwsDelivery({
    s3: { send: async (command: any) => { uploads.set(command.input.Key, new Uint8Array(command.input.Body)); return {}; } } as any,
    carriage: { bucket, prefix, maximumObjectBytes: 1024, retention: "retain" }, runId, configuration,
    definition: { content } as any, inputDocument: { input: "value" }, runner: { path: "file:///runner", sha256: runnerSha256 }, guestProgram: new Uint8Array(),
    fetchContent: async (uri) => uri === content.uri ? archive : runner,
  });
  const document = {
    kind: "derived", name: "aws-delivery-document",
    inputs: {
      runId: { kind: "literal", value: runId }, content: { kind: "literal", value: content }, inputDocument: { kind: "literal", value: { input: "value" } },
      runnerSha256: { kind: "literal", value: runnerSha256 }, bucket: { kind: "literal", value: bucket }, runPrefix: { kind: "literal", value: runPrefix }, association: { kind: "literal", value: association },
    },
  } as const;
  const harness = buildProviderHarness();
  try {
    const bodyExpectation = { $expect: { kind: "derived", name: "recorded-body", inputs: { bytes: document } } } satisfies ScenarioExpectation<unknown>;
    assert.equal(await evaluateScenarioExpectation(harness, awsEc2ScenarioTaskContent, bodyExpectation, recordedRequestBody(uploads.get(`${runPrefix}/delivery.json`)!)), null);
    const digestExpectation = { $expect: { kind: "derived", name: "aws-delivery-sha256", inputs: { delivery: document } } } satisfies ScenarioExpectation<unknown>;
    assert.equal(await evaluateScenarioExpectation(harness, awsEc2ScenarioTaskContent, digestExpectation, state.deliverySha256), null);
  } finally { harness.close(); }
});

test("plumbing rejects recorded-body outside request expectations and unknown inputs", () => {
  const outsideRequests = structuredClone(baseDescriptor());
  outsideRequests.acts[0]!.expectedWorld.effects = { $expect: { kind: "derived", name: "recorded-body", inputs: { bytes: { kind: "task-archive" } } } } as never;
  assert.match(validateScenarioDescriptor(outsideRequests).join("\n"), /recorded-body matcher location refused/);

  const unknownInput = structuredClone(baseDescriptor());
  unknownInput.acts[0]!.expectedWorld.requests = [{ body: { $expect: { kind: "derived", name: "recorded-body", inputs: { bytes: { kind: "unknown" } } } } }] as never;
  assert.match(validateScenarioDescriptor(unknownInput).join("\n"), /derived input refused/);

  const extraInput = structuredClone(baseDescriptor());
  extraInput.acts[0]!.expectedWorld.requests = [{ body: { $expect: { kind: "derived", name: "recorded-body", inputs: { bytes: { kind: "task-archive" }, surprise: { kind: "literal", value: null } } } } }] as never;
  assert.match(validateScenarioDescriptor(extraInput).join("\n"), /derived inputs refused/);

  const documentOutsidePermittedInputs = structuredClone(baseDescriptor());
  documentOutsidePermittedInputs.acts[0]!.expectedWorld.effects = { $expect: deliveryDocumentDerivation() } as never;
  assert.match(validateScenarioDescriptor(documentOutsidePermittedInputs).join("\n"), /aws-delivery-document location refused/);
});

test("plumbing recursively resolves scripted derived responses and rejects seed-time account forms", async () => {
  const descriptor = baseDescriptor();
  descriptor.world.script = [{
    request: {},
    response: { kind: "success", status: 200, headers: {}, body: {
      digest: { $resolve: { kind: "derived", name: "aws-configuration-digest", inputs: { configuration: { kind: "literal", value: { client: { endpoint: { mode: "custom", url: { $resolve: binding("world", "aws-http-root") } } } } } } } },
      echoed: { $resolve: binding("world", "aws-http-root") },
    } },
    externalEffect: {},
  }];
  assert.deepEqual(validateScenarioDescriptor(descriptor).filter((error) => /resolver|derived/.test(error)), []);
  const resolved = await resolveScenarioWorld(descriptor.world, { "task-content-uri": "bound-delivery", "aws-http-root": "http://127.0.0.1:1234" }, Buffer.alloc(0));
  assert.deepEqual((resolved.script[0]!.response as { body: unknown }).body, {
    digest: awsConfigurationDigest({ client: { endpoint: { mode: "custom", url: "http://127.0.0.1:1234" } } }),
    echoed: "http://127.0.0.1:1234",
  });

  const unknown = structuredClone(descriptor) as any;
  unknown.world.script[0].response.body.digest = { $resolve: { kind: "derived", name: "unknown-digest", inputs: {} } };
  assert.match(validateScenarioDescriptor(unknown).join("\n"), /derived name refused/);

  const accountAtSeed = structuredClone(descriptor) as any;
  accountAtSeed.world.script[0].response.body.echoed = { $resolve: { $scenario: { source: "account", name: "account", step: "prior", path: ["runState"] } } };
  assert.match(validateScenarioDescriptor(accountAtSeed).join("\n"), /account resolver refused at world seed/);
});

test("plumbing joins ordered string parts and rejects invalid joined forms", { timeout: 30_000 }, async () => {
  const carriage = { bucket: "bucket", prefix: "prefix", maximumObjectBytes: 1024, retention: "retain" } as const;
  const configurationDigest = "1".repeat(64);
  const runDigest = "2".repeat(64);
  const prefix = `prefix/relationships/${configurationDigest}/runs/${runDigest}`;
  const expectation = { $expect: { kind: "joined", parts: ["s3://bucket/", { kind: "derived", name: "aws-run-prefix", inputs: { carriage: { kind: "literal", value: carriage }, configurationDigest: { kind: "literal", value: configurationDigest }, runDigest: { kind: "literal", value: runDigest } } }, "/delivery.json"] } } satisfies ScenarioExpectation<string>;
  const harness = buildProviderHarness();
  try { assert.equal(await evaluateScenarioExpectation(harness, awsEc2ScenarioTaskContent, expectation, `s3://bucket/${prefix}/delivery.json`), null); }
  finally { harness.close(); }

  for (const joined of [
    { kind: "joined", parts: ["only-one"] },
    { kind: "joined", parts: ["prefix", 1] },
    { kind: "joined", parts: ["prefix", { kind: "derived", name: "unknown", inputs: {} }] },
  ]) {
    const descriptor = baseDescriptor() as any;
    descriptor.world.script = [{ request: {}, response: { kind: "success", status: 200, headers: {}, body: { value: { $resolve: joined } } }, externalEffect: {} }];
    assert.match(validateScenarioDescriptor(descriptor).join("\n"), /joined|derived name refused/);
  }
});

test("plumbing Kubernetes world persists creates, excludes dry-runs, patches, and deletes", async () => {
  const world = await startKubernetesHttpsWorld({ kind: "kubernetes-https", initialState: { resources: [] }, script: [] });
  const request = (method: string, path: string, body: unknown = null) => new Promise<{ status: number; body: any }>((resolve, reject) => {
    const payload = body === null ? null : Buffer.from(JSON.stringify(body));
    const target = new URL(path, world.bindings["kubernetes-https-root"]);
    const call = https.request({ hostname: target.hostname, port: target.port, path: `${target.pathname}${target.search}`, method, ca: world.bindings["kubernetes-ca-pem"], headers: payload ? { "content-type": "application/json", "content-length": String(payload.length) } : {} }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) }));
    });
    call.on("error", reject);
    if (payload) call.write(payload);
    call.end();
  });
  const secret = { apiVersion: "v1", kind: "Secret", metadata: { namespace: "tasks", name: "command" }, type: "Opaque", data: { payload: "" } };
  try {
    const dry = await request("POST", "/api/v1/namespaces/tasks/secrets?dryRun=All", { ...secret, metadata: { ...secret.metadata, name: "preview" } });
    assert.equal(dry.status, 201);
    assert.equal((await request("GET", "/api/v1/namespaces/tasks/secrets/preview")).status, 404);

    const created = await request("POST", "/api/v1/namespaces/tasks/secrets", secret);
    assert.equal(created.status, 201);
    assert.equal(created.body.metadata.uid, "uid-1");
    assert.equal(created.body.metadata.resourceVersion, "1");
    assert.deepEqual((await request("GET", "/api/v1/namespaces/tasks/secrets/command")).body, created.body);

    const patched = await request("PATCH", "/api/v1/namespaces/tasks/secrets/command", { metadata: { resourceVersion: "1" }, data: { payload: "Y2FuY2Vs" } });
    assert.equal(patched.status, 200);
    assert.equal(patched.body.metadata.resourceVersion, "2");
    assert.equal((await request("GET", "/api/v1/namespaces/tasks/secrets/command")).body.data.payload, "Y2FuY2Vs");

    assert.equal((await request("DELETE", "/api/v1/namespaces/tasks/secrets/command", { apiVersion: "v1", kind: "DeleteOptions", preconditions: { uid: "uid-1" } })).status, 200);
    assert.equal((await request("GET", "/api/v1/namespaces/tasks/secrets/command")).status, 404);
    assert.equal((world.observation().effects as any).resources.length, 0);
    assert.equal(world.observation().requests.length, 8);
  } finally { await world.close(); }
});

function baseDescriptor(): ProviderScenarioDescriptor {
  return {
    version: 1, id: "validation", providerMember: "aws-codebuild", traces: ["validation"], forbiddenAccountScalars: [],
    taskContent: awsEc2ScenarioTaskContent, world: { kind: "aws-http", initialState: {}, script: [] },
    acts: [{
      step: "refuse",
      demand: {} as never,
      expectedAccount: {} as never,
      expectedWorld: { requests: [], effects: {}, environmentCount: 0 },
    }],
  };
}

function deliveryDocumentDerivation() {
  return {
    kind: "derived", name: "aws-delivery-document",
    inputs: {
      runId: { kind: "literal", value: "run" }, content: { kind: "literal", value: { uri: "file:///task", archiveSha256: "0".repeat(64), treeSha256: "1".repeat(64) } },
      inputDocument: { kind: "literal", value: {} }, runnerSha256: { kind: "literal", value: "2".repeat(64) }, bucket: { kind: "literal", value: "bucket" },
      runPrefix: { kind: "literal", value: "prefix" }, association: { kind: "literal", value: { runDigest: "3".repeat(64), configurationDigest: "4".repeat(64), archiveSha256: "0".repeat(64), treeSha256: "1".repeat(64), runnerSha256: "2".repeat(64) } },
    },
  } as const;
}
import assert from "node:assert/strict";
import test from "node:test";
