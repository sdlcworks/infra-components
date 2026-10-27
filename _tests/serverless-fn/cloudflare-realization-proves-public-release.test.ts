import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import * as https from "node:https";
import * as dns from "node:dns/promises";
import { EventEmitter } from "node:events";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { loadServerlessFn } from "./load-serverless-fn";

const ORIGIN = "https://site.example.com";
const ROUTE = { zoneId: "zone", pattern: "site.example.com/*" };
const RELEASE = "release-123";
const SOURCE = "export const named = 7; export default { value: 'ordinary', fetch() {return new Response(this.value)}, scheduled(){return 'scheduled'} };";
const DIGEST = `sha256:${createHash("sha256").update(SOURCE).digest("hex")}`;
const WITNESS = { version: 1, release_identity: RELEASE, digest: DIGEST };
let root: string;
let originalFetch: typeof fetch;
let requests: {url: string; init: RequestInit}[];
let holder: string | null;
let loseCreate: boolean;
let publicBody: unknown;
let publicStatus: number;
let publicAddresses: {address: string; family: number}[];
let publicCalls: {url: string; options: any}[];
let timeoutPublic: boolean;
let stalePublicCalls: number;
let httpsSpy: ReturnType<typeof spyOn>;
let dnsSpy: ReturnType<typeof spyOn>;
let timerSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "release-proof-"));
  writeFileSync(join(root, "index.js"), SOURCE);
  requests = [];
  holder = "existing-worker";
  loseCreate = false;
  publicBody = WITNESS;
  publicStatus = 200;
  timeoutPublic = false;
  publicAddresses = [{address: "104.16.1.2", family: 4}];
  publicCalls = [];
  stalePublicCalls = 0;
  const originalTimeout = globalThis.setTimeout;
  timerSpy = spyOn(globalThis, "setTimeout").mockImplementation(((callback: any, delay: number, ...args: any[]) =>
    originalTimeout(callback, delay === 2000 ? 1 : delay === 5000 ? 5 : delay, ...args)) as any);
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: any, init: RequestInit = {}) => {
    const url = String(input);
    requests.push({url, init});
    if (url.endsWith("/workers/routes")) {
      if (init.method === "POST") {
        holder = JSON.parse(String(init.body)).script;
        if (loseCreate) throw new Error("lost create acknowledgement");
      }
      return Response.json({success:true, result: holder === null ? [] : [{...ROUTE, script: holder}]});
    }
    if (url.endsWith("/assets-upload-session")) return Response.json({result:{jwt:"assets-jwt",buckets:[]}});
    return Response.json({success:true});
  }) as typeof fetch;
  dnsSpy = spyOn(dns, "lookup").mockImplementation((async () => publicAddresses) as any);
  httpsSpy = spyOn(https, "get").mockImplementation(((url: URL, options: any, callback: any) => {
    publicCalls.push({url:String(url), options});
    const request = new EventEmitter() as any;
    request.destroy = (error: Error) => { request.emit("error", error); request.emit("close"); };
    queueMicrotask(() => options.lookup(url.hostname, {all: true}, (error: Error | null, addresses: any) => {
      if (error) { request.destroy(error); return; }
      expect(addresses).toEqual(publicAddresses);
      if (timeoutPublic) return;
      const response = new EventEmitter() as any;
      response.statusCode = publicStatus;
      response.resume = () => {};
      callback(response);
      const body = publicCalls.length <= stalePublicCalls ? {...WITNESS, release_identity: "previous-release"} : publicBody;
      response.emit("data", Buffer.from(JSON.stringify(body)));
      response.emit("end");
      request.emit("close");
    }));
    return request;
  }) as any);
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  httpsSpy.mockRestore();
  dnsSpy.mockRestore();
  timerSpy.mockRestore();
  rmSync(root, {recursive:true, force:true});
});

function context(): any {
  return {
    buildArtifacts: {app: {artifact: {type:"file", uri: join(root,"index.js"), digest:DIGEST}}},
    releaseIdentities: {app: RELEASE},
    deploymentConfigs: {app: {publicReleaseProof:{url:ORIGIN, route:ROUTE}}},
    state: {scriptName:"existing-worker", accountId:"account", workerUri:ORIGIN,
      publicRoute: ROUTE, scriptSettings:{compatibility_date:"2025-01-01", compatibility_flags:[], bindings:[]}},
    getCredentials: () => ({CLOUDFLARE_API_TOKEN:"protected-token"}),
  };
}
async function deploy(ctx = context()) {
  const provider = (await loadServerlessFn()).default.providers.cloudflare;
  await provider.upsertArtifacts!(ctx);
}

test("same-owned route succeeds with exact public witness and preserves application exports/handlers", async () => {
  await deploy();
  expect(requests.filter(r => r.init.method === "POST")).toHaveLength(0);
  expect(publicCalls).toHaveLength(1);
  expect(publicCalls[0]!.url).toBe(ORIGIN+"/.well-known/sdlc-release");
  expect(publicCalls[0]!.options.headers.Authorization).toBeUndefined();
  const form = requests.find(r => r.init.method === "PUT")!.init.body as FormData;
  const metadata = JSON.parse(await (form.get("metadata") as Blob).text());
  const wrapped = await (form.get(metadata.main_module) as Blob).text();
  writeFileSync(join(root, metadata.main_module), wrapped);
  const module = await import(pathToFileURL(join(root,metadata.main_module)).href);
  expect(module.named).toBe(7);
  expect(await (await module.default.fetch(new Request(ORIGIN))).text()).toBe("ordinary");
  expect(module.default.scheduled()).toBe("scheduled");
  const witness = module.default.fetch(new Request(ORIGIN+"/.well-known/sdlc-release"));
  expect(await witness.json()).toEqual(WITNESS);
  expect(witness.headers.get("Cache-Control")).toBe("no-store");
});

test.each([false,true])("absent route is created and exact ownership observed, lost reply=%s", async (lost) => {
  holder = null; loseCreate = lost;
  await deploy();
  const creates = requests.filter(r => r.init.method === "POST");
  expect(creates).toHaveLength(1);
  expect(JSON.parse(String(creates[0]!.init.body))).toEqual({pattern:ROUTE.pattern,script:"existing-worker"});
  expect(holder as string | null).toBe("existing-worker");
});

test("foreign route is refused before upload or route mutation", async () => {
  holder = "foreign-worker";
  await expect(deploy()).rejects.toThrow("public-release-route-conflict");
  expect(requests.every(r => !r.init.method)).toBe(true);
  expect(holder).toBe("foreign-worker");
  expect(publicCalls).toHaveLength(0);
});

test.each([undefined, "sha256:"+"0".repeat(64), "md5:bad"])("missing or wrong admitted digest refuses before upload: %s", async (digest) => {
  const ctx = context();ctx.buildArtifacts.app.artifact.digest = digest;
  await expect(deploy(ctx)).rejects.toThrow("public-release-proof-refused");
  expect(requests).toHaveLength(0);
});

test("release identity and unambiguous application selection are required", async () => {
  const ctx = context();ctx.releaseIdentities = {};
  await expect(deploy(ctx)).rejects.toThrow("release identity required");
  ctx.buildArtifacts.other = ctx.buildArtifacts.app;
  await expect(deploy(ctx)).rejects.toThrow("ambiguous applications");
  expect(requests).toHaveLength(0);
});

test.each(["http://site.example.com", "https://other.example.com", "https://127.0.0.1", "https://user:pass@site.example.com", ORIGIN+"?x=y"])("refuses alternate/unsafe destination %s",async (url) => {
  const ctx=context();ctx.deploymentConfigs.app.publicReleaseProof.url=url;
  await expect(deploy(ctx)).rejects.toThrow("public-release-proof-refused");
  expect(requests).toHaveLength(0);
});

test("retained route identity cannot be changed by a proof election",async () => {
  const ctx=context();ctx.state.publicRoute={...ROUTE,zoneId:"other"};
  await expect(deploy(ctx)).rejects.toThrow("retained route identity disagrees");
  expect(requests).toHaveLength(0);
});

test.each([
  {version:1,release_identity:"old-release",digest:DIGEST},
  {...WITNESS,digest:"sha256:"+"0".repeat(64)},
  {ok:true},
])("rejects successful HTTP with wrong witness %j",async (body) => {
  publicBody=body;
  await expect(deploy()).rejects.toThrow("witness mismatch");
  expect(publicCalls).toHaveLength(30);
});

test.each([302,503])("does not accept HTTP %s or follow redirects",async (status) => {
  publicStatus=status;
  await expect(deploy()).rejects.toThrow(`witness HTTP ${status}`);
  expect(publicCalls.every(call=>call.url===ORIGIN+"/.well-known/sdlc-release")).toBe(true);
});

test.each(["127.0.0.1","10.1.2.3","169.254.1.1","::1","::ffff:127.0.0.1","fc00::1"])("refuses DNS resolution to private address %s",async (address) => {
  publicAddresses=[{address,family:address.includes(":")?6:4}];
  await expect(deploy()).rejects.toThrow("private or alternate destination");
});

test("timed out witness cannot acknowledge deployment",async () => {
  timeoutPublic=true;
  await expect(deploy()).rejects.toThrow("witness timeout");
  expect(publicCalls).toHaveLength(30);
});

test("a release still propagating to the edge is acknowledged once its witness is served",async () => {
  stalePublicCalls=6;
  await deploy();
  expect(publicCalls).toHaveLength(7);
});

test.each(["static-site", "worker-assets"])("proof reserves only witness routing for %s",async (mode) => {
  const ctx = context();
  const content = join(root,"content");mkdirSync(content);
  if(mode === "worker-assets") {
    mkdirSync(join(content,"worker"));mkdirSync(join(content,"assets"));
    writeFileSync(join(content,"worker/index.js"),SOURCE);
    writeFileSync(join(content,"assets/index.html"),"<h1>ordinary</h1>");
  } else writeFileSync(join(content,"index.html"),"<h1>ordinary</h1>");
  const archive = join(root,"artifact.tar.gz");
  execFileSync("tar",["-czf",archive,"-C",content,"."]);
  const digest = `sha256:${createHash("sha256").update(readFileSync(archive)).digest("hex")}`;
  ctx.buildArtifacts.app.artifact={type:"file",uri:archive,digest};
  ctx.state.assetMode=mode;
  ctx.state.scriptSettings.assets={html_handling:"auto-trailing-slash",not_found_handling:"single-page-application"};
  publicBody={...WITNESS,digest};
  await deploy(ctx);
  const form=requests.find(r=>r.init.method==="PUT")!.init.body as FormData;
  const metadata=JSON.parse(await (form.get("metadata") as Blob).text());
  expect(metadata.assets.config).toEqual({html_handling:"auto-trailing-slash",not_found_handling:"single-page-application",run_worker_first:["/.well-known/sdlc-release"]});
  expect(await (form.get("index.js") as Blob).text()).toContain(mode === "worker-assets" ? "ordinary" : "env.ASSETS.fetch");
  expect(metadata.bindings).toContainEqual({type:"assets",name:"ASSETS"});
});

test("ordinary release enables proof on a retained legacy Worker without reprovision",async () => {
  const ctx=context();delete ctx.state.publicRoute;
  await deploy(ctx);
  expect(requests.filter(r=>r.init.method==="PUT")[0]!.url).toEndWith("/workers/scripts/existing-worker");
});


test("unsupported provider refuses elected public proof before deployment", async () => {
  const provider = (await loadServerlessFn()).default.providers.gcloud;
  await expect(provider.upsertArtifacts!(context())).rejects.toThrow("public-release-proof-unsupported");
  expect(requests).toHaveLength(0);
});

test.each(["md5", "sha256"])("preserves admitted %s identity across bare/tagged/mixed-case representations", async (algorithm) => {
  const digest = createHash(algorithm).update(SOURCE).digest("hex");
  for (const admitted of [digest, `${algorithm}:${digest}`, digest.toUpperCase(), `${algorithm}:${digest}`.toUpperCase()]) {
    const ctx=context();ctx.buildArtifacts.app.artifact.digest=admitted;
    publicBody={...WITNESS,digest:`${algorithm}:${digest}`};
    await deploy(ctx);
    const form=requests.filter(r=>r.init.method==="PUT").at(-1)!.init.body as FormData;
    const metadata=JSON.parse(await (form.get("metadata") as Blob).text());
    expect(await (form.get(metadata.main_module) as Blob).text()).toContain(`"digest":"${algorithm}:${digest}"`);
  }
});

test.each(["0".repeat(32), "md5:"+"0".repeat(32), "sha256:"+"0".repeat(32), "md5:"+"0".repeat(64), "sha1:"+"0".repeat(40), "a".repeat(32)+"-2"])("refuses mismatching, unsupported or malformed digest before upload: %s", async (digest) => {
  const ctx=context();ctx.buildArtifacts.app.artifact.digest=digest;
  await expect(deploy(ctx)).rejects.toThrow("public-release-proof-refused");
  expect(requests).toHaveLength(0);
});
