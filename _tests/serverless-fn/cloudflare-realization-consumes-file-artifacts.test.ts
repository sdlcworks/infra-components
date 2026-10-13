import { beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";
import {
  captured,
  loadServerlessFn,
  namingTag,
  resetCaptured,
} from "./load-serverless-fn";

const SCRIPT_CONTENT = "export default { fetch: () => new Response('ok') };";

function writeScriptFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "serverless-fn-test-"));
  const filePath = path.join(dir, "index.js");
  fs.writeFileSync(filePath, SCRIPT_CONTENT);
  return filePath;
}

function sha256(content: string): string {
  return crypto.createHash("sha256").update(Buffer.from(content)).digest("hex");
}

function cloudflareInputs(): Record<string, unknown> {
  return {
    accountId: "cf-account",
    environmentVariables: [],
    compatibilityDate: "2024-01-01",
    compatibilityFlags: ["nodejs_compat"],
    logpush: false,
  };
}

// Fabricated provider contexts carry only the fields the realization under
// test reads, so they are deliberately untyped.
function pulumiCtx(buildArtifacts: Record<string, unknown>): any {
  return {
    $: namingTag,
    inputs: cloudflareInputs(),
    state: {},
    buildArtifacts,
    getCredentials: () => ({ CLOUDFLARE_API_TOKEN: "cf-token" }),
  };
}

describe("serverless-fn entity declaration", () => {
  test("accepts both OCI image and file artifacts", async () => {
    const { default: component } = await loadServerlessFn();
    const accepted: string[] = component.opts.acceptedArtifactTypes ?? [];
    expect(accepted).toContain("oci_spec_image");
    expect(accepted).toContain("file");
  });
});

describe("cloudflare realization: provisioning", () => {
  beforeEach(resetCaptured);

  test("places a bare-path file artifact as the worker script", async () => {
    const cloudflare = (await loadServerlessFn()).default.providers.cloudflare;
    const scriptPath = writeScriptFile();

    await cloudflare.pulumi(
      pulumiCtx({
        app: { artifact: { type: "file", uri: scriptPath } },
      }),
    );

    expect(captured.workersScripts).toHaveLength(1);
    const args = captured.workersScripts[0].args;
    expect(args.contentFile).toBe(scriptPath);
    expect(args.contentSha256).toBe(sha256(SCRIPT_CONTENT));
    expect(args.content).toBeUndefined();
  });

  test("resolves file:// artifact URIs to local paths", async () => {
    const cloudflare = (await loadServerlessFn()).default.providers.cloudflare;
    const scriptPath = writeScriptFile();

    await cloudflare.pulumi(
      pulumiCtx({
        app: { artifact: { type: "file", uri: pathToFileURL(scriptPath).href } },
      }),
    );

    expect(captured.workersScripts).toHaveLength(1);
    expect(captured.workersScripts[0].args.contentFile).toBe(scriptPath);
  });

  test("refuses an OCI image artifact with a named error", async () => {
    const cloudflare = (await loadServerlessFn()).default.providers.cloudflare;

    await expect(
      cloudflare.pulumi(
        pulumiCtx({
          app: {
            artifact: {
              type: "oci_spec_image",
              uri: "registry.example/app:latest",
            },
          },
        }),
      ),
    ).rejects.toThrow(/serverless-fn\(cloudflare\).*oci_spec_image/);
    expect(captured.workersScripts).toHaveLength(0);
  });

  test("falls back to the placeholder script only when no artifact exists", async () => {
    const cloudflare = (await loadServerlessFn()).default.providers.cloudflare;

    await cloudflare.pulumi(pulumiCtx({}));

    expect(captured.workersScripts).toHaveLength(1);
    const args = captured.workersScripts[0].args;
    expect(args.contentFile).toBeUndefined();
    expect(String(args.content)).toContain("placeholder");
  });
});

describe("cloudflare realization: artifact updates", () => {
  test("refuses an OCI image artifact without calling the Workers API", async () => {
    const cloudflare = (await loadServerlessFn()).default.providers.cloudflare;
    const fetchCalls: unknown[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (...args: unknown[]) => {
      fetchCalls.push(args);
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    try {
      await expect(
        cloudflare.upsertArtifacts!(({
          buildArtifacts: {
            app: {
              artifact: {
                type: "oci_spec_image",
                uri: "registry.example/app:latest",
              },
            },
          },
          state: { scriptName: "worker", accountId: "cf-account" },
          getCredentials: () => ({ CLOUDFLARE_API_TOKEN: "token" }),
        }) as any),
      ).rejects.toThrow(/serverless-fn\(cloudflare\).*oci_spec_image/);
      expect(fetchCalls).toHaveLength(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("provision records the script settings deploys must replay", async () => {
    const cloudflare = (await loadServerlessFn()).default.providers.cloudflare;
    const ctx = pulumiCtx({});
    await cloudflare.pulumi(ctx);
    expect(ctx.state.scriptSettings).toBeDefined();
    expect(ctx.state.scriptSettings.compatibility_flags).toEqual([
      "nodejs_compat",
    ]);
    expect(ctx.state.scriptSettings.compatibility_date).toBe("2024-01-01");
    expect(Array.isArray(ctx.state.scriptSettings.bindings)).toBe(true);
  });

  test("uploads the script content from a file:// artifact", async () => {
    const cloudflare = (await loadServerlessFn()).default.providers.cloudflare;
    const scriptPath = writeScriptFile();
    const requests: { url: string; body: FormData }[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      requests.push({ url: String(url), body: init.body as FormData });
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    try {
      await cloudflare.upsertArtifacts!(({
        buildArtifacts: {
          app: {
            artifact: { type: "file", uri: pathToFileURL(scriptPath).href },
          },
        },
        state: {
          scriptName: "worker",
          accountId: "cf-account",
          scriptSettings: {
            compatibility_date: "2024-01-01",
            compatibility_flags: ["nodejs_compat"],
            bindings: [{ type: "d1", name: "DB", id: "d1-id" }],
          },
        },
        getCredentials: () => ({ CLOUDFLARE_API_TOKEN: "token" }),
      }) as any);

      expect(requests).toHaveLength(1);
      expect(requests[0].url).toBe(
        "https://api.cloudflare.com/client/v4/accounts/cf-account/workers/scripts/worker",
      );
      const scriptPart = requests[0].body.get("index.js");
      expect(await (scriptPart as Blob).text()).toBe(SCRIPT_CONTENT);
      const metadataPart = requests[0].body.get("metadata");
      const metadata = JSON.parse(await (metadataPart as Blob).text());
      expect(metadata.main_module).toBe("index.js");
      expect(metadata.compatibility_flags).toEqual(["nodejs_compat"]);
      expect(metadata.compatibility_date).toBe("2024-01-01");
      expect(metadata.bindings).toEqual([{ type: "d1", name: "DB", id: "d1-id" }]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
