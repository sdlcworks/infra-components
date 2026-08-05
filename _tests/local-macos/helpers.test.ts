import { describe, expect, test } from "bun:test";
import {
  LOCAL_WORLD_LABEL,
  SUBSTRATE_CLUSTER_NAME,
  SUBSTRATE_HTTP_PORT,
  SUBSTRATE_REGISTRY_HOST_PORT,
  toClusterImageRef,
  toNamespaceName,
} from "../../_internal/local-substrate";

describe("local-substrate constants", () => {
  test("world label is the author-chosen open string", () => {
    expect(LOCAL_WORLD_LABEL).toBe("local-macos");
  });

  test("substrate identity constants are stable", () => {
    expect(SUBSTRATE_CLUSTER_NAME).toBe("sdlc-local");
    expect(SUBSTRATE_REGISTRY_HOST_PORT).toBe(5910);
    expect(SUBSTRATE_HTTP_PORT).toBe(5980);
  });
});

describe("toNamespaceName", () => {
  test("derives a deterministic RFC1123 namespace from an engine seed", () => {
    expect(toNamespaceName("MyBranch_seed-01")).toBe("mybranch-seed-01");
    expect(toNamespaceName("MyBranch_seed-01")).toBe(
      toNamespaceName("MyBranch_seed-01"),
    );
  });

  test("truncates to 63 chars and strips edge hyphens", () => {
    const long = "-" + "a".repeat(80) + "_";
    const ns = toNamespaceName(long);
    expect(ns.length).toBeLessThanOrEqual(63);
    expect(ns).toMatch(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/);
  });
});

describe("toClusterImageRef", () => {
  test("rewrites a host-push address to the cluster-visible registry address", () => {
    expect(
      toClusterImageRef(
        "localhost:5910/app-main:1.2.3",
        "localhost:5910",
        "k3d-sdlc-local-registry:5910",
      ),
    ).toBe("k3d-sdlc-local-registry:5910/app-main:1.2.3");
  });

  test("leaves non-local references untouched", () => {
    expect(
      toClusterImageRef(
        "ghcr.io/org/app:1.2.3",
        "localhost:5910",
        "k3d-sdlc-local-registry:5910",
      ),
    ).toBe("ghcr.io/org/app:1.2.3");
  });
});
