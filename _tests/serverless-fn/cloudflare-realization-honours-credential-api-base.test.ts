import { beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadServerlessFn, resetCaptured } from "./load-serverless-fn";

const SCRIPT_CONTENT = "export default { fetch: () => new Response('ok') };";
const CREDENTIAL_BASE = "https://platform.example/edge-relay";

function writeScriptFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "serverless-fn-base-test-"));
  const filePath = path.join(dir, "index.js");
  fs.writeFileSync(filePath, SCRIPT_CONTENT);
  return filePath;
}

function deployCtx(credentials: Record<string, string>): any {
  return {
    buildArtifacts: {
      app: {
        artifact: { type: "file", uri: pathToFileURL(writeScriptFile()).href },
      },
    },
    state: {
      scriptName: "worker",
      accountId: "cf-account",
      scriptSettings: {
        compatibility_date: "2024-01-01",
        compatibility_flags: ["nodejs_compat"],
        bindings: [],
      },
    },
    getCredentials: () => credentials,
  };
}

describe("cloudflare realization: credential-supplied API base", () => {
  beforeEach(resetCaptured);

  test("the whole base, version path included, comes from the bound credentials", async () => {
    const cloudflare = (await loadServerlessFn()).default.providers.cloudflare;
    const urls: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: unknown) => {
      urls.push(String(url));
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    try {
      await cloudflare.upsertArtifacts!(deployCtx({
        CLOUDFLARE_API_TOKEN: "token",
        CLOUDFLARE_API_BASE: CREDENTIAL_BASE,
      }) as any);
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(urls).toHaveLength(1);
    expect(urls[0]).toBe(
      `${CREDENTIAL_BASE}/accounts/cf-account/workers/scripts/worker`,
    );
  });

  test("a credential without a base falls back to the provider's own base", async () => {
    const cloudflare = (await loadServerlessFn()).default.providers.cloudflare;
    const urls: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: unknown) => {
      urls.push(String(url));
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    try {
      await cloudflare.upsertArtifacts!(deployCtx({
        CLOUDFLARE_API_TOKEN: "token",
      }) as any);
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(urls).toHaveLength(1);
    expect(urls[0]).toBe(
      "https://api.cloudflare.com/client/v4/accounts/cf-account/workers/scripts/worker",
    );
  });
});
