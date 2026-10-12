import { beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  captured,
  loadServerlessFn,
  namingTag,
  resetCaptured,
} from "./load-serverless-fn";

const ENTRY_SOURCE =
  "import { chunk } from './chunks/a.js'; export default { fetch: () => new Response(chunk) };";
const CHUNK_SOURCE = "export const chunk = 'ssr';";
const WASM_BYTES = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
const INDEX_HTML = "<!doctype html><title>x</title>";
const STYLE_CSS = "body{}";
const DATABASE_URL = "postgres://user:pass@db.example/app";
const API_TOKEN = "token";

type Files = Record<string, string | Buffer>;
type Recorded = { url: string; init: RequestInit };

function packArtifact(files: Files, topLevel: string[]): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "worker-assets-src-"));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  const out = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "worker-assets-out-")),
    "dist-worker.tar.gz",
  );
  execFileSync("tar", ["-czf", out, "-C", root, ...topLevel]);
  return out;
}

const FULL_ARTIFACT: Files = {
  "worker/index.js": ENTRY_SOURCE,
  "worker/chunks/a.js": CHUNK_SOURCE,
  "worker/query.wasm": WASM_BYTES,
  "assets/index.html": INDEX_HTML,
  "assets/_next/static/style.css": STYLE_CSS,
};

function stubCloudflareApi(): { requests: Recorded[]; restore: () => void } {
  const requests: Recorded[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    const target = String(url);
    requests.push({ url: target, init });
    if (target.endsWith("/assets-upload-session")) {
      const { manifest } = JSON.parse(String(init.body)) as {
        manifest: Record<string, { hash: string }>;
      };
      return Response.json({
        result: {
          jwt: "upload-jwt",
          buckets: [Object.values(manifest).map((entry) => entry.hash)],
        },
      });
    }
    if (target.includes("/workers/assets/upload")) {
      return Response.json({ result: { jwt: "completion-jwt" } }, { status: 201 });
    }
    return Response.json({ success: true });
  }) as typeof fetch;
  return {
    requests,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

function workerAssetsState(): Record<string, unknown> {
  return {
    scriptName: "worker",
    accountId: "cf-account",
    assetMode: "worker-assets",
    scriptSettings: {
      compatibility_date: "2024-09-23",
      compatibility_flags: ["nodejs_compat"],
      bindings: [
        { type: "plain_text", name: "API_URL", text: "https://api.example" },
        { type: "d1", name: "DB", id: "d1-id" },
      ],
      assets: { html_handling: "auto-trailing-slash", not_found_handling: "none" },
      secret_refs: [{ name: "DATABASE_URL", secret_name: "DATABASE_URL" }],
    },
  };
}

function deployCtx(
  artifactPath: string,
  state: Record<string, unknown>,
  credentials: Record<string, string> = { CLOUDFLARE_API_TOKEN: API_TOKEN, DATABASE_URL },
): any {
  return {
    buildArtifacts: { app: { artifact: { type: "file", uri: artifactPath } } },
    state,
    getCredentials: () => credentials,
  };
}

function provisionCtx(
  inputs: Record<string, unknown>,
  credentials: Record<string, string> = { CLOUDFLARE_API_TOKEN: API_TOKEN, DATABASE_URL },
  buildArtifacts: Record<string, unknown> = {},
): any {
  return {
    $: namingTag,
    inputs: {
      accountId: "cf-account",
      environmentVariables: [],
      logpush: false,
      ...inputs,
    },
    state: {},
    buildArtifacts,
    getCredentials: () => credentials,
  };
}

async function scriptUpload(requests: Recorded[]) {
  const put = requests.find((r) => r.init.method === "PUT");
  expect(put).toBeDefined();
  const form = put!.init.body as FormData;
  const metadata = JSON.parse(await (form.get("metadata") as Blob).text());
  return { put: put!, form, metadata };
}

describe("cloudflare realization: worker-assets provisioning", () => {
  beforeEach(resetCaptured);

  test("records worker-assets with worker-first not-found handling and the compatibility floor", async () => {
    const cloudflare = (await loadServerlessFn()).default.providers.cloudflare;
    const artifact = packArtifact(FULL_ARTIFACT, ["worker", "assets"]);
    const ctx = provisionCtx(
      { assetMode: "worker-assets", compatibilityDate: "2024-01-01", compatibilityFlags: [] },
      undefined,
      { app: { artifact: { type: "file", uri: artifact } } },
    );

    await cloudflare.pulumi(ctx);

    expect(ctx.state.assetMode).toBe("worker-assets");
    expect(ctx.state.scriptSettings.assets).toEqual({
      html_handling: "auto-trailing-slash",
      not_found_handling: "none",
    });
    expect(ctx.state.scriptSettings.compatibility_date).toBe("2024-09-23");
    expect(ctx.state.scriptSettings.compatibility_flags).toEqual(["nodejs_compat"]);
    expect(captured.workersScripts).toHaveLength(1);
    const args = captured.workersScripts[0].args;
    expect(args.contentFile).toBeUndefined();
    expect(String(args.content)).toContain("placeholder");
    expect(args.compatibilityDate).toBe("2024-09-23");
  });

  test("keeps a declared compatibility date later than the floor", async () => {
    const cloudflare = (await loadServerlessFn()).default.providers.cloudflare;
    const ctx = provisionCtx({
      assetMode: "worker-assets",
      compatibilityDate: "2025-01-15",
      compatibilityFlags: ["nodejs_compat"],
    });

    await cloudflare.pulumi(ctx);

    expect(ctx.state.scriptSettings.compatibility_date).toBe("2025-01-15");
  });

  test("binds declared secrets from the bound credential without recording their values", async () => {
    const cloudflare = (await loadServerlessFn()).default.providers.cloudflare;
    const ctx = provisionCtx({
      assetMode: "worker-assets",
      environmentVariables: [{ name: "API_URL", value: "https://api.example" }],
      secretEnvironmentVariables: [
        { name: "DATABASE_URL", secretName: "DATABASE_URL", version: "latest" },
      ],
      cfBindings: { d1: [{ name: "DB", databaseId: "d1-id" }] },
    });

    await cloudflare.pulumi(ctx);

    const bindings = captured.workersScripts[0].args.bindings as Record<string, unknown>[];
    expect(bindings).toContainEqual({
      name: "DATABASE_URL",
      text: DATABASE_URL,
      type: "secret_text",
    });
    expect(ctx.state.scriptSettings.secret_refs).toEqual([
      { name: "DATABASE_URL", secret_name: "DATABASE_URL" },
    ]);
    expect(ctx.state.scriptSettings.bindings).toContainEqual({
      type: "d1",
      name: "DB",
      id: "d1-id",
    });
    expect(JSON.stringify(ctx.state)).not.toContain(DATABASE_URL);
  });

  test("refuses a secret whose credential key the bound credential lacks", async () => {
    const cloudflare = (await loadServerlessFn()).default.providers.cloudflare;
    const ctx = provisionCtx({
      assetMode: "worker-assets",
      secretEnvironmentVariables: [
        { name: "DATABASE_URL", secretName: "MISSING", version: "latest" },
      ],
    });

    await expect(cloudflare.pulumi(ctx)).rejects.toThrow(
      /secret 'DATABASE_URL' names credential key 'MISSING'/,
    );
    expect(captured.workersScripts).toHaveLength(0);
  });
});

describe("cloudflare realization: worker-assets deploy", () => {
  test("uploads worker modules beside the asset manifest with ASSETS, vars, D1 and secrets", async () => {
    const cloudflare = (await loadServerlessFn()).default.providers.cloudflare;
    const artifact = packArtifact(FULL_ARTIFACT, ["worker", "assets"]);
    const api = stubCloudflareApi();
    try {
      await cloudflare.upsertArtifacts!(deployCtx(artifact, workerAssetsState()));

      const session = api.requests[0];
      expect(session.url).toBe(
        "https://api.cloudflare.com/client/v4/accounts/cf-account/workers/scripts/worker/assets-upload-session",
      );
      const manifest = JSON.parse(String(session.init.body)).manifest;
      expect(Object.keys(manifest).sort()).toEqual([
        "/_next/static/style.css",
        "/index.html",
      ]);
      const upload = api.requests[1];
      expect(upload.url).toContain("/workers/assets/upload?base64=true");
      expect((upload.init.headers as Record<string, string>).Authorization).toBe(
        "Bearer upload-jwt",
      );

      const { put, form, metadata } = await scriptUpload(api.requests);
      expect(put.url).toBe(
        "https://api.cloudflare.com/client/v4/accounts/cf-account/workers/scripts/worker",
      );
      expect(metadata.main_module).toBe("index.js");
      expect(metadata.compatibility_date).toBe("2024-09-23");
      expect(metadata.compatibility_flags).toEqual(["nodejs_compat"]);
      expect(metadata.assets).toEqual({
        jwt: "completion-jwt",
        config: { html_handling: "auto-trailing-slash", not_found_handling: "none" },
      });
      expect(metadata.bindings).toEqual([
        { type: "plain_text", name: "API_URL", text: "https://api.example" },
        { type: "d1", name: "DB", id: "d1-id" },
        { type: "secret_text", name: "DATABASE_URL", text: DATABASE_URL },
        { type: "assets", name: "ASSETS" },
      ]);

      const entry = form.get("index.js") as File;
      expect(await entry.text()).toBe(ENTRY_SOURCE);
      expect(entry.type).toBe("application/javascript+module");
      const chunk = form.get("chunks/a.js") as File;
      expect(await chunk.text()).toBe(CHUNK_SOURCE);
      expect(chunk.type).toBe("application/javascript+module");
      const wasm = form.get("query.wasm") as File;
      expect(wasm.type).toBe("application/wasm");
      expect(Buffer.from(await wasm.arrayBuffer()).equals(WASM_BYTES)).toBe(true);
      expect(form.get("index.html")).toBeNull();
    } finally {
      api.restore();
    }
  });

  test("refuses an artifact without worker/index.js before calling the API", async () => {
    const cloudflare = (await loadServerlessFn()).default.providers.cloudflare;
    const artifact = packArtifact(
      { "worker/main.js": ENTRY_SOURCE, "assets/index.html": INDEX_HTML },
      ["worker", "assets"],
    );
    const api = stubCloudflareApi();
    try {
      await expect(
        cloudflare.upsertArtifacts!(deployCtx(artifact, workerAssetsState())),
      ).rejects.toThrow(/worker-assets artifact carries no worker\/index\.js/);
      expect(api.requests).toHaveLength(0);
    } finally {
      api.restore();
    }
  });

  test("refuses an artifact without an assets directory before calling the API", async () => {
    const cloudflare = (await loadServerlessFn()).default.providers.cloudflare;
    const artifact = packArtifact({ "worker/index.js": ENTRY_SOURCE }, ["worker"]);
    const api = stubCloudflareApi();
    try {
      await expect(
        cloudflare.upsertArtifacts!(deployCtx(artifact, workerAssetsState())),
      ).rejects.toThrow(/worker-assets artifact carries no assets\//);
      expect(api.requests).toHaveLength(0);
    } finally {
      api.restore();
    }
  });

  test("refuses a secret the bound credential lacks before calling the API", async () => {
    const cloudflare = (await loadServerlessFn()).default.providers.cloudflare;
    const artifact = packArtifact(FULL_ARTIFACT, ["worker", "assets"]);
    const api = stubCloudflareApi();
    try {
      await expect(
        cloudflare.upsertArtifacts!(
          deployCtx(artifact, workerAssetsState(), { CLOUDFLARE_API_TOKEN: API_TOKEN }),
        ),
      ).rejects.toThrow(/secret 'DATABASE_URL' names credential key 'DATABASE_URL'/);
      expect(api.requests).toHaveLength(0);
    } finally {
      api.restore();
    }
  });
});

describe("cloudflare realization: deploy dispatch for states recorded before worker-assets", () => {
  test("a state with assets and no assetMode keeps the static-site passthrough", async () => {
    const cloudflare = (await loadServerlessFn()).default.providers.cloudflare;
    const artifact = packArtifact({ "index.html": INDEX_HTML }, ["index.html"]);
    const api = stubCloudflareApi();
    try {
      await cloudflare.upsertArtifacts!(
        deployCtx(artifact, {
          scriptName: "worker",
          accountId: "cf-account",
          scriptSettings: {
            compatibility_date: "2024-01-01",
            compatibility_flags: ["nodejs_compat"],
            bindings: [],
            assets: { html_handling: "auto-trailing-slash", not_found_handling: "404-page" },
          },
        }),
      );

      const manifest = JSON.parse(String(api.requests[0].init.body)).manifest;
      expect(Object.keys(manifest)).toEqual(["/index.html"]);
      const { form, metadata } = await scriptUpload(api.requests);
      expect(await (form.get("index.js") as File).text()).toContain("env.ASSETS.fetch");
      expect(metadata.assets.config.not_found_handling).toBe("404-page");
      expect(metadata.bindings).toEqual([{ type: "assets", name: "ASSETS" }]);
    } finally {
      api.restore();
    }
  });

  test("script mode replays declared secrets", async () => {
    const cloudflare = (await loadServerlessFn()).default.providers.cloudflare;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "serverless-fn-script-"));
    const scriptPath = path.join(dir, "index.js");
    fs.writeFileSync(scriptPath, ENTRY_SOURCE);
    const api = stubCloudflareApi();
    try {
      await cloudflare.upsertArtifacts!(
        deployCtx(scriptPath, {
          scriptName: "worker",
          accountId: "cf-account",
          scriptSettings: {
            compatibility_date: "2024-01-01",
            compatibility_flags: ["nodejs_compat"],
            bindings: [],
            secret_refs: [{ name: "DATABASE_URL", secret_name: "DATABASE_URL" }],
          },
        }),
      );

      const { form, metadata } = await scriptUpload(api.requests);
      expect(await (form.get("index.js") as File).text()).toBe(ENTRY_SOURCE);
      expect(metadata.bindings).toEqual([
        { type: "secret_text", name: "DATABASE_URL", text: DATABASE_URL },
      ]);
    } finally {
      api.restore();
    }
  });
});
