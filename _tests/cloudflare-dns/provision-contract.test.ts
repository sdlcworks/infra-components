import { beforeEach, describe, expect, test } from "bun:test";
import {
  captured,
  loadCloudflareDns,
  namingTag,
  resetCaptured,
} from "./load-cloudflare-dns";

function provisionCtx(overrides: Record<string, unknown> = {}): any {
  return {
    $: namingTag,
    state: {},
    config: {
      domain: "simplefs.io",
      defaults: { proxied: true },
      records: {
        edge: { name: "*" },
        app: { name: "app", service: "sw-worker" },
      },
    },
    components: {
      edge: {
        uri: "https://worker.example",
        metadata: { host: "simplefs.io", protocol: "https", port: 443 },
      },
    },
    getCredentials: () => ({
      CLOUDFLARE_API_TOKEN: "cf-token",
      CLOUDFLARE_ACCOUNT_ID: "cf-account",
    }),
    ...overrides,
  };
}

describe("cloudflare-dns provision contract", () => {
  beforeEach(resetCaptured);

  test("returns results keyed by component names only", async () => {
    const register = (await loadCloudflareDns()).default;
    const provision = register.getProvision("cloudflare")!;
    const results = await provision(provisionCtx());
    expect(Object.keys(results)).toEqual(["edge"]);
    expect(captured.dnsRecords.length).toBe(1);
    expect(captured.workerCustomDomains.length).toBe(1);
  });

  test("authenticates through a provider built from the bound credential", async () => {
    const register = (await loadCloudflareDns()).default;
    const provision = register.getProvision("cloudflare")!;
    await provision(provisionCtx());
    expect(captured.cloudflareProviders.length).toBe(1);
    expect(captured.cloudflareProviders[0]!.args.apiToken).toBe("cf-token");
  });

  test("a binding without an API token is refused by name", async () => {
    const register = (await loadCloudflareDns()).default;
    const provision = register.getProvision("cloudflare")!;
    expect(
      provision(provisionCtx({ getCredentials: () => ({}) })),
    ).rejects.toThrow("CLOUDFLARE_API_TOKEN");
  });
});
