import { describe, expect, test } from "bun:test";
import { loadServerlessFn } from "./load-serverless-fn";

type HandlerEntry = {
  interface: { name?: string };
  handler: (ctx: any) => Promise<any>;
};

async function publicHandler(state: Record<string, unknown>, selfComponentName: string) {
  const cloudflare = (await loadServerlessFn()).default.providers.cloudflare;
  const entries: HandlerEntry[] = cloudflare.connect({ state, selfComponentName });
  return entries.find((entry) => entry.interface?.name === "public")?.handler;
}

function stateWithAllocation(workerUri: string) {
  return {
    scriptName: "sw-worker",
    accountId: "cf-account",
    workerUri,
    allocations: {
      edge: { scriptName: "sw-worker", accountId: "cf-account", workerUri },
    },
  };
}

describe("cloudflare realization: public addressing", () => {
  test("declares a handler for the public interface", async () => {
    const handler = await publicHandler(stateWithAllocation("https://gw.simplefs.io"), "edge");
    expect(handler).toBeDefined();
  });

  test("custom-domain worker publishes its hostname as the origin target", async () => {
    const handler = await publicHandler(stateWithAllocation("https://gw.simplefs.io"), "edge");
    const result = await handler!({});
    expect(result.uri).toBe("https://gw.simplefs.io");
    expect(result.metadata.host).toBe("gw.simplefs.io");
    expect(result.metadata.protocol).toBe("https");
    expect(result.metadata.port).toBe(443);
    expect(result.metadata.appComponentType).toBe("http-service");
  });

  test("route-pattern worker strips the wildcard so the origin target resolves", async () => {
    const handler = await publicHandler(stateWithAllocation("https://*.simplefs.io"), "edge");
    const result = await handler!({});
    expect(result.metadata.host).toBe("simplefs.io");
  });

  test("a component without an allocation is refused by name", async () => {
    const handler = await publicHandler(stateWithAllocation("https://gw.simplefs.io"), "unallocated");
    expect(handler!({})).rejects.toThrow("unallocated");
  });
});
