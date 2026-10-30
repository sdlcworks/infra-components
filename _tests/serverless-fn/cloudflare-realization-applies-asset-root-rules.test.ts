import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as https from "node:https";
import * as dns from "node:dns/promises";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { loadServerlessFn } from "./load-serverless-fn";

const INDEX_HTML = "<!doctype html><title>x</title>";
const WORKER_SOURCE = "export default { fetch: () => new Response('ordinary') };";
const HEADERS = "# security\n/*\n  X-Frame-Options: DENY\n  Content-Security-Policy: default-src 'self'\n/assets/*\n  Cache-Control: public, max-age=31536000, immutable\n";
const REDIRECTS = "/old /new 301\n/blog/* https://blog.example.com/:splat 302\n";
const NESTED_HEADERS = "/nested/*\n  X-Nested: yes\n";
const ORIGIN = "https://site.example.com";
const ROUTE = { zoneId: "zone", pattern: "site.example.com/*" };
const RELEASE = "release-123";

type Mode = "static-site" | "worker-assets";
type Files = Record<string, string | Buffer>;
type Recorded = { url: string; init: RequestInit };

let requests: Recorded[];
let originalFetch: typeof fetch;

beforeEach(() => {
  requests = [];
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: any, init: RequestInit = {}) => {
    const url = String(input);
    requests.push({ url, init });
    if (url.endsWith("/workers/routes")) {
      return Response.json({ success: true, result: [{ ...ROUTE, script: "worker" }] });
    }
    if (url.endsWith("/assets-upload-session")) {
      const { manifest } = JSON.parse(String(init.body)) as {
        manifest: Record<string, { hash: string }>;
      };
      return Response.json({
        result: { jwt: "upload-jwt", buckets: [Object.values(manifest).map((e) => e.hash)] },
      });
    }
    if (url.includes("/workers/assets/upload")) {
      return Response.json({ result: { jwt: "completion-jwt" } }, { status: 201 });
    }
    return Response.json({ success: true });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function assetRoot(mode: Mode): string {
  return mode === "worker-assets" ? "assets/" : "";
}

function deployCtx(mode: Mode, artifact: string): any {
  return {
    buildArtifacts: { app: { artifact: { type: "file", uri: artifact } } },
    state: {
      scriptName: "worker",
      accountId: "cf-account",
      assetMode: mode,
      scriptSettings: {
        compatibility_date: "2024-09-23",
        compatibility_flags: ["nodejs_compat"],
        bindings: [],
        assets: { html_handling: "auto-trailing-slash", not_found_handling: "none" },
      },
    },
    getCredentials: () => ({ CLOUDFLARE_API_TOKEN: "token" }),
  };
}

async function deploy(ctx: any): Promise<void> {
  const cloudflare = (await loadServerlessFn()).default.providers.cloudflare;
  await cloudflare.upsertArtifacts!(ctx);
}

function manifestKeys(): string[] {
  const session = requests.find((r) => r.url.endsWith("/assets-upload-session"))!;
  return Object.keys(JSON.parse(String(session.init.body)).manifest).sort();
}

async function scriptMetadata(): Promise<any> {
  const put = requests.find((r) => r.init.method === "PUT")!;
  const form = put.init.body as FormData;
  return JSON.parse(await (form.get("metadata") as Blob).text());
}

const MODES: Mode[] = ["static-site", "worker-assets"];

function artifactFor(mode: Mode, assets: Files): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "asset-rules-src-"));
  const all: Files = { "index.html": INDEX_HTML, ...assets };
  for (const [rel, content] of Object.entries(all)) {
    const full = path.join(root, assetRoot(mode), rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  if (mode === "worker-assets") {
    fs.mkdirSync(path.join(root, "worker"), { recursive: true });
    fs.writeFileSync(path.join(root, "worker", "index.js"), WORKER_SOURCE);
  }
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "asset-rules-out-")), "artifact.tar.gz");
  execFileSync("tar", ["-czf", out, "-C", root, "."]);
  return out;
}

describe.each(MODES)("cloudflare realization: asset root rules in %s", (mode) => {
  test("absent rules leave the manifest and assets metadata unchanged", async () => {
    await deploy(deployCtx(mode, artifactFor(mode, {})));

    expect(manifestKeys()).toEqual(["/index.html"]);
    const metadata = await scriptMetadata();
    expect(metadata.assets).toEqual({
      jwt: "completion-jwt",
      config: { html_handling: "auto-trailing-slash", not_found_handling: "none" },
    });
    expect(Object.keys(metadata.assets.config)).toEqual(["html_handling", "not_found_handling"]);
  });

  test("root _headers and _redirects are forwarded verbatim and never uploaded as assets", async () => {
    await deploy(deployCtx(mode, artifactFor(mode, { _headers: HEADERS, _redirects: REDIRECTS })));

    expect(manifestKeys()).toEqual(["/index.html"]);
    const metadata = await scriptMetadata();
    expect(metadata.assets.config).toEqual({
      html_handling: "auto-trailing-slash",
      not_found_handling: "none",
      _headers: HEADERS,
      _redirects: REDIRECTS,
    });
  });

  test("a lone _redirects is forwarded without inventing _headers", async () => {
    await deploy(deployCtx(mode, artifactFor(mode, { _redirects: REDIRECTS })));

    expect(manifestKeys()).toEqual(["/index.html"]);
    const config = (await scriptMetadata()).assets.config;
    expect(config._redirects).toBe(REDIRECTS);
    expect("_headers" in config).toBe(false);
  });

  test("a lone _headers is forwarded without inventing _redirects", async () => {
    await deploy(deployCtx(mode, artifactFor(mode, { _headers: HEADERS })));

    expect(manifestKeys()).toEqual(["/index.html"]);
    const config = (await scriptMetadata()).assets.config;
    expect(config._headers).toBe(HEADERS);
    expect("_redirects" in config).toBe(false);
  });

  test("a nested _headers stays an ordinary asset", async () => {
    await deploy(deployCtx(mode, artifactFor(mode, { "nested/_headers": NESTED_HEADERS })));

    expect(manifestKeys()).toEqual(["/index.html", "/nested/_headers"]);
    const config = (await scriptMetadata()).assets.config;
    expect("_headers" in config).toBe(false);
  });

  test("refuses a non-UTF-8 rule file by name before calling the API", async () => {
    const artifact = artifactFor(mode, { _redirects: Buffer.from([0x2f, 0x61, 0x20, 0xff, 0xfe]) });
    await expect(deploy(deployCtx(mode, artifact))).rejects.toThrow(
      /asset root _redirects is not valid UTF-8/,
    );
    expect(requests).toHaveLength(0);
  });

  test("refuses a _headers whose header precedes any URL line before calling the API", async () => {
    const artifact = artifactFor(mode, { _headers: "# c\n  X-Frame-Options: DENY\n/*\n" });
    await expect(deploy(deployCtx(mode, artifact))).rejects.toThrow(
      /asset root _headers declares a header before any URL line/,
    );
    expect(requests).toHaveLength(0);
  });
});

describe.each(MODES)("cloudflare realization: asset root rules beside public proof in %s", (mode) => {
  let httpsSpy: ReturnType<typeof spyOn>;
  let dnsSpy: ReturnType<typeof spyOn>;
  let witness: Record<string, unknown>;

  beforeEach(() => {
    dnsSpy = spyOn(dns, "lookup").mockImplementation((async () => [{ address: "104.16.1.2", family: 4 }]) as any);
    httpsSpy = spyOn(https, "get").mockImplementation(((url: URL, options: any, callback: any) => {
      const request = new EventEmitter() as any;
      request.destroy = (error: Error) => { request.emit("error", error); request.emit("close"); };
      queueMicrotask(() => options.lookup(url.hostname, { all: true }, () => {
        const response = new EventEmitter() as any;
        response.statusCode = 200;
        callback(response);
        response.emit("data", Buffer.from(JSON.stringify(witness)));
        response.emit("end");
        request.emit("close");
      }));
      return request;
    }) as any);
  });

  afterEach(() => {
    httpsSpy.mockRestore();
    dnsSpy.mockRestore();
  });

  test("witness routing stays the only worker-first path", async () => {
    const artifact = artifactFor(mode, { _headers: HEADERS, _redirects: REDIRECTS });
    const digest = `sha256:${createHash("sha256").update(fs.readFileSync(artifact)).digest("hex")}`;
    witness = { version: 1, release_identity: RELEASE, digest };
    const ctx = deployCtx(mode, artifact);
    ctx.buildArtifacts.app.artifact.digest = digest;
    ctx.releaseIdentities = { app: RELEASE };
    ctx.deploymentConfigs = { app: { publicReleaseProof: { url: ORIGIN, route: ROUTE } } };
    ctx.state.workerUri = ORIGIN;
    ctx.state.publicRoute = ROUTE;

    await deploy(ctx);

    expect(manifestKeys()).toEqual(["/index.html"]);
    expect((await scriptMetadata()).assets.config).toEqual({
      html_handling: "auto-trailing-slash",
      not_found_handling: "none",
      _headers: HEADERS,
      _redirects: REDIRECTS,
      run_worker_first: ["/.well-known/sdlc-release"],
    });
  });
});
