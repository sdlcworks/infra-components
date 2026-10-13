import { describe, expect, test } from "bun:test";
import { loadServerlessFn, namingTag } from "./load-serverless-fn";

describe("gcloud realization: artifact type pairing", () => {
  test("allocation refuses a file artifact with a named error", async () => {
    const gcloud = (await loadServerlessFn()).default.providers.gcloud;

    await expect(
      gcloud.allocateWithPulumiCtx!(({
        name: "app",
        deploymentConfig: {},
        state: {},
        $: namingTag,
        buildArtifact: {
          artifact: { type: "file", uri: "/tmp/bundle.js" },
        },
        envStore: {},
        gcp: undefined,
      }) as any),
    ).rejects.toThrow(/serverless-fn\(gcloud\).*file/);
  });

  test("artifact update refuses a file artifact before calling Cloud Run", async () => {
    const gcloud = (await loadServerlessFn()).default.providers.gcloud;
    const fetchCalls: unknown[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (...args: unknown[]) => {
      fetchCalls.push(args);
      return new Response(JSON.stringify({ done: true }), { status: 200 });
    }) as typeof fetch;

    try {
      await expect(
        gcloud.upsertArtifacts!(({
          buildArtifacts: {
            app: { artifact: { type: "file", uri: "/tmp/bundle.js" } },
          },
          state: {
            allocations: {
              app: { serviceName: "svc", region: "us-central1" },
            },
          },
          envStore: {},
          getCredentials: () => ({
            GCP_PROJECT_ID: "project",
            GCP_SERVICE_ACCOUNT_KEY: "key",
          }),
        }) as any),
      ).rejects.toThrow(/serverless-fn\(gcloud\).*file/);
      expect(fetchCalls).toHaveLength(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("artifact update deploys an OCI image artifact", async () => {
    const gcloud = (await loadServerlessFn()).default.providers.gcloud;
    const requests: { url: string; body: string }[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      requests.push({ url: String(url), body: String(init.body) });
      return new Response(JSON.stringify({ done: true }), { status: 200 });
    }) as typeof fetch;

    try {
      await gcloud.upsertArtifacts!(({
        buildArtifacts: {
          app: {
            artifact: {
              type: "oci_spec_image",
              uri: "registry.example/app:latest",
            },
          },
        },
        state: {
          allocations: {
            app: { serviceName: "svc", region: "us-central1" },
          },
        },
        envStore: {},
        getCredentials: () => ({
          GCP_PROJECT_ID: "project",
          GCP_SERVICE_ACCOUNT_KEY: "key",
        }),
      }) as any);

      expect(requests).toHaveLength(1);
      expect(requests[0].url).toContain(
        "/projects/project/locations/us-central1/services/svc",
      );
      expect(requests[0].body).toContain("registry.example/app:latest");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
