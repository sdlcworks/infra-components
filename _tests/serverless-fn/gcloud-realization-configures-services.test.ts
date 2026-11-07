import { beforeEach, describe, expect, test } from "bun:test";
import { captured, loadServerlessFn, namingTag, resetCaptured } from "./load-serverless-fn";

const image = { artifact: { type: "oci_spec_image", uri: "registry.example/api:1" } };

async function allocate(deploymentConfig: Record<string, unknown>, envStore: Record<string, Record<string, string>> = {}) {
  const gcloud = (await loadServerlessFn()).default.providers.gcloud;
  const state: Record<string, any> = { project: "proj" };
  await gcloud.allocateWithPulumiCtx!(({
    name: "api",
    deploymentConfig,
    state,
    $: namingTag,
    buildArtifact: image,
    envStore,
  }) as any);
  return state;
}

const service = (): any => captured.gcpResources.find((resource) => resource.kind === "Service")!;

beforeEach(resetCaptured);

describe("gcloud realization: per-service configuration", () => {
  test("defaults keep a public service under the project's default identity", async () => {
    await allocate({});
    expect(service().args.ingress).toBe("INGRESS_TRAFFIC_ALL");
    expect(service().args.template.serviceAccount).toBeUndefined();
    expect(service().args.template.timeout).toBe("300s");
    expect(captured.gcpResources.filter((resource) => resource.kind === "ServiceIamMember")).toHaveLength(1);
    expect(captured.gcpResources.some((resource) => resource.kind === "Account")).toBe(false);
  });

  test("a private internal service grants no public invoker", async () => {
    await allocate({ traffic: "internal", public: false });
    expect(service().args.ingress).toBe("INGRESS_TRAFFIC_INTERNAL_ONLY");
    expect(captured.gcpResources.some((resource) => resource.kind === "ServiceIamMember")).toBe(false);
  });

  test("Cloud SQL access mounts the connector socket under a dedicated identity", async () => {
    const state = await allocate({ cloudSqlInstances: ["proj:us-central1:main"] });
    const account: any = captured.gcpResources.find((resource) => resource.kind === "Account")!;
    expect(account.args.accountId).toMatch(/^run-[0-9a-f]{16}$/);
    const grant: any = captured.gcpResources.find((resource) => resource.kind === "IAMMember")!;
    expect(grant.args).toMatchObject({ project: "proj", role: "roles/cloudsql.client" });
    const template = service().args.template;
    expect(template.serviceAccount).toBe("sa@example.iam.gserviceaccount.com");
    expect(template.volumes).toEqual([{ name: "cloudsql", cloudSqlInstance: { instances: ["proj:us-central1:main"] } }]);
    expect(template.containers[0].volumeMounts).toEqual([{ name: "cloudsql", mountPath: "/cloudsql" }]);
    expect(service().opts?.dependsOn).toHaveLength(1);
    expect(state.allocations.api.serviceAccountEmail).toBe("sa@example.iam.gserviceaccount.com");
  });

  test("secret variables come from Secret Manager and replace plain values of the same name", async () => {
    await allocate(
      { identity: { mode: "existing", email: "api@proj.iam.gserviceaccount.com" }, secretEnvironmentVariables: [{ name: "DATABASE_URL", secret: "db-url" }] },
      { api: { DATABASE_URL: "plain", MODE: "prod" } },
    );
    const envs = service().args.template.containers[0].envs;
    expect(envs).toEqual([
      { name: "MODE", value: "prod" },
      { name: "DATABASE_URL", valueSource: { secretKeyRef: { secret: "db-url", version: "latest" } } },
    ]);
    const grant: any = captured.gcpResources.find((resource) => resource.kind === "SecretIamMember")!;
    expect(grant.args).toMatchObject({ secretId: "db-url", role: "roles/secretmanager.secretAccessor" });
  });

  test("grants under the default identity are refused", async () => {
    await expect(allocate({ identity: { mode: "default" }, cloudSqlInstances: ["proj:us-central1:main"] })).rejects.toThrow(
      /identity mode "dedicated" or "existing"/,
    );
  });

  test("direct VPC egress uses the declared subnetwork", async () => {
    await allocate({ vpcAccess: { subnetwork: "projects/proj/regions/us-central1/subnetworks/app", egress: "all-traffic" } });
    expect(service().args.template.vpcAccess).toEqual({
      networkInterfaces: [{ network: undefined, subnetwork: "projects/proj/regions/us-central1/subnetworks/app" }],
      egress: "ALL_TRAFFIC",
    });
  });

  test("a redeploy keeps the deployed template and its secret variables", async () => {
    const { redeployedTemplate } = await loadServerlessFn();
    const template: any = redeployedTemplate(
      {
        timeout: "60s",
        scaling: { minInstanceCount: 1 },
        containers: [{ image: "old", resources: { limits: { cpu: "2" } }, env: [{ name: "DATABASE_URL", valueSource: { secretKeyRef: { secret: "db" } } }, { name: "OLD", value: "x" }] }],
      },
      "new",
      { DATABASE_URL: "plain", MODE: "prod" },
    );
    expect(template.timeout).toBe("60s");
    expect(template.scaling).toEqual({ minInstanceCount: 1 });
    expect(template.containers[0]).toEqual({
      image: "new",
      resources: { limits: { cpu: "2" } },
      env: [{ name: "DATABASE_URL", valueSource: { secretKeyRef: { secret: "db" } } }, { name: "MODE", value: "prod" }],
    });
  });
});

test("a redeploy lets Cloud Run name the new revision", async () => {
  const { redeployedTemplate } = await loadServerlessFn();
  const template: any = redeployedTemplate({ revision: "api-00001-abc", containers: [{ image: "old" }] } as any, "new", {});
  expect(template.revision).toBeUndefined();
  expect(template.containers[0].image).toBe("new");
});
