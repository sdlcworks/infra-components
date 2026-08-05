import { describe, expect, test } from "bun:test";
import {
  loadLocalIngress,
  loadLocalRegistry,
  loadWorkloadHost,
} from "./load-local-macos";
import { LOCAL_WORLD_LABEL } from "../../_internal/local-substrate";

// DeploymentArtifactType.oci_spec_image's wire value. Not imported statically
// from @sdlcworks/components here: a static import eagerly links that
// package's whole graph (including the real @pulumi/pulumi, which Bun cannot
// evaluate — see load-local-macos.ts) before this file's dynamic-import-gated
// mocks ever run.
const OCI_SPEC_IMAGE = "oci_spec_image";

describe("machine-local workload host declaration", () => {
  test("registers its realization under the open label", async () => {
    const { default: workloadHost } = await loadWorkloadHost();
    expect(Object.keys(workloadHost.providers)).toContain(LOCAL_WORLD_LABEL);
  });

  test("declares the full entity contract once at the entity level", async () => {
    const { default: workloadHost } = await loadWorkloadHost();
    const bundle = workloadHost.getPortableSchemas();
    expect(Object.keys(bundle.schemas.deployment_inputs).sort()).toEqual([
      "http-service",
      "postgres",
      "tcp-service",
    ]);
    expect(bundle.connection_types).toHaveProperty("public");
    expect(bundle.connection_types).toHaveProperty("internal");
    expect(bundle.connection_types).toHaveProperty("postgres");
    expect(bundle.schemas.output.properties).toHaveProperty("apiServerUrl");
  });

  test("accepts intrinsically-remote config fields for schema parity", async () => {
    const { default: workloadHost } = await loadWorkloadHost();
    const bundle = workloadHost.getPortableSchemas();
    expect(bundle.schemas.config.properties).toHaveProperty("machineGroups");
    expect(bundle.schemas.config.properties).toHaveProperty("networkTags");
  });
});

describe("local-ingress endpoint register declaration", () => {
  test("registers its realization under the open label", async () => {
    const { default: localIngress } = await loadLocalIngress();
    expect(Object.keys(localIngress.realizations)).toContain(
      LOCAL_WORLD_LABEL,
    );
  });

  test("collects URIs through the local public HTTP interface", async () => {
    const { default: localIngress } = await loadLocalIngress();
    expect(localIngress.getPortableSchemas().schemas.interface_name).toBe(
      "local-public-http",
    );
  });
});

describe("local-registry artifact registry declaration", () => {
  test("registers its realization under the open label", async () => {
    const { default: localRegistry } = await loadLocalRegistry();
    expect(Object.keys(localRegistry.realizations)).toContain(
      LOCAL_WORLD_LABEL,
    );
  });

  test("accepts only OCI images", async () => {
    const { default: localRegistry } = await loadLocalRegistry();
    expect(
      localRegistry.getPortableSchemas().schemas.accepted_artifact_types as string[],
    ).toEqual([OCI_SPEC_IMAGE]);
  });
});
