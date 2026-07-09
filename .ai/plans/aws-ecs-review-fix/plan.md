# AWS ECS Review Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Correct the reviewed AWS ECS fleet regressions so provisioned identities, scaling ownership, externally owned discovery, Fargate limits, public addressing, and workload-target outputs match the existing subsystem contract.

**Architecture:** Keep the existing single-file ECS component and its provision-time/deploy-time split. Add only small pure helpers where they make policy testable, feed those helpers into the existing Pulumi declarations, and persist/return the new workload-target identity without introducing a live-AWS test harness.

**Tech Stack:** TypeScript, Bun test runner, Zod, Pulumi AWS v7, AWS SDK v3, TypeScript 5.9.

---

## Collapsed plan bundle

The bundle index and its sole sub-plan are intentionally collapsed into this file. All fixes touch the same `aws-ecs/index.ts` subsystem node and the same verification boundary, so there is one execution node and no internal concurrency.

Execution dependency graph:

```text
relation-focused failing tests
  -> minimal aws-ecs implementation and schemas
  -> README catalogue update
  -> focused and repository verification
  -> independent review
  -> commit
```

## Contract and scope

Authoritative contract: `aws-ecs/SUBSYSTEM.md`.

This work corrects the implementation to the already-declared relations `service-fleet-intent`, `target-attachment-point`, `workload-target-identity`, `public-endpoint`, and `internal-service-endpoint`. It does not change subsystem behaviour, create/split/merge a subsystem, or require a `SUBSYSTEM.md` revision.

Non-goals:

- Do not edit any `SUBSYSTEM.md`.
- Do not create or query live AWS resources in tests.
- Do not restructure `aws-ecs/index.ts` into new production modules.
- Do not change image delivery, EFS, IAM, blue/green cutover, allocation, or connection semantics beyond the listed findings.
- Do not repair unrelated repository-wide TypeScript failures; classify them against a recorded baseline.
- Do not update `.js/bun.lock` or dependency versions.

## Files

- Modify: `aws-ecs/index.ts`
- Create: `_tests/aws-ecs/service-fleet-intent-produces-task-definition.test.ts`
- Create: `_tests/aws-ecs/service-fleet-intent-produces-reconciliation.test.ts`
- Create: `_tests/aws-ecs/service-fleet-intent-produces-endpoints.test.ts`
- Create: `_tests/aws-ecs/service-fleet-intent-validates-capacity.test.ts`
- Create: `_tests/aws-ecs/target-attachment-point-produces-workload-target-identity.test.ts`
- Create: `_tests/aws-ecs/load-ecs.ts`
- Create: `_tests/aws-ecs/tsconfig.json`
- Modify: `README.md`
- Do not modify: `aws-ecs/SUBSYSTEM.md`

Repository-specific test-layout rule: use `_tests/aws-ecs/` rather than the generic `tests/aws-ecs/` convention. This repository's component builder treats ordinary top-level directories as components and would require a nonexistent `tests/index.ts`; it deliberately skips underscore-prefixed directories. `_tests/` is therefore the reserved non-component test root. The `aws-ecs/` mirror and relation-named test modules still preserve the subsystem/relation test structure. Do not change the builder to accommodate tests.

### Task 1: Add relation-focused failing tests

- [ ] **Step 1: Export only the pure seams required by the tests**

Keep component registration private. Export the existing config schema and the following pure helpers/types from `aws-ecs/index.ts`; do not export Pulumi resources or provisioning callbacks:

```ts
export { ConfigSchema };

export type WorkloadTarget = {
  targetType: "ip";
  port: number;
  protocol: "HTTP";
  health: {
    protocol: "HTTP";
    path: string;
    gracePeriodSeconds: number;
  };
  deregistrationDelaySeconds: number;
};

export function internalEndpoint(
  serviceKey: string,
  namespaceName: string,
  port: number,
): { dnsName: string; port: number; uri: string } {
  const dnsName = `${serviceKey}.${namespaceName}`;
  return { dnsName, port, uri: `${dnsName}:${port}` };
}

export function desiredCountIgnoreChanges(
  activated: boolean,
  scaling: { min: number; max: number },
): string[] {
  return !activated || scaling.max > scaling.min ? ["desiredCount"] : [];
}

export function publicEndpointHost(
  publicNames: string[],
  albDnsName: string,
): string {
  return publicNames[0] ?? albDnsName;
}

export function assertExternalTargetGroupTargetType(
  serviceKey: string,
  targetType: string,
): void {
  if (targetType !== "ip") {
    throw new Error(
      `aws-ecs: service "${serviceKey}" external-attachment target group must use targetType "ip" for Fargate awsvpc tasks.`,
    );
  }
}

export function workloadTarget(
  service: Pick<ResolvedServiceConfig, "port" | "health">,
): WorkloadTarget {
  return {
    targetType: "ip",
    port: service.port!,
    protocol: "HTTP",
    health: {
      protocol: "HTTP",
      path: service.health.path,
      gracePeriodSeconds: service.health.gracePeriodSeconds,
    },
    deregistrationDelaySeconds: DEFAULT_DEREGISTRATION_DELAY_SECONDS,
  };
}
```

Also export `taskTemplate` and `validateFargateSize` because they are existing pure functions directly exercising the reviewed regressions. If tests can reach equivalent public schema behaviour without another export, do not add one.

- [ ] **Step 2: Add a test-only loader that makes component registration inert**

Create `_tests/aws-ecs/load-ecs.ts`. The production module imports Pulumi, whose `node:v8` startup path is not compatible with this Bun test runtime, so install module mocks before dynamically importing it:

```ts
import { mock } from "bun:test";

mock.module("@pulumi/aws", () => ({}));
mock.module("@pulumi/pulumi", () => ({}));
mock.module("../../_internal/interfaces", () => ({
  InternalServiceCI: {},
  PublicCI: {},
}));
mock.module("@sdlcworks/components", () => {
  class InfraComponent {
    constructor(_definition: unknown) {}

    implement(..._args: unknown[]): void {}
  }

  return {
    CloudProvider: { aws: "aws" },
    DeploymentArtifactType: { oci_spec_image: "oci_spec_image" },
    InfraComponent,
    connectionHandler: (..._args: unknown[]) => ({}),
  };
});

let ecsModule: Promise<typeof import("../../aws-ecs/index")> | undefined;

export function loadEcs(): Promise<typeof import("../../aws-ecs/index")> {
  ecsModule ??= import("../../aws-ecs/index");
  return ecsModule;
}
```

The mocks must remain test-only and deliberately minimal: they make component/interface registration inert but do not imitate AWS or Pulumi behaviour. Every test module below must use `const ecs = await loadEcs()` (or destructure from its result) and must not statically value-import `aws-ecs/index.ts`. Type-only references are acceptable because TypeScript erases them.

If Bun's `mock.module` cannot reliably intercept these imports before Pulumi evaluates, stop implementation and return `BLOCKED`. The only authorized fallback is a parent-approved replan to extract the pure policy helpers/schema into a production module with no Pulumi imports; do not perform that production restructuring under this plan.

- [ ] **Step 3: Test canonical task-definition log identity**

Create `_tests/aws-ecs/service-fleet-intent-produces-task-definition.test.ts` using `bun:test` and `loadEcs` from `./load-ecs`. Dynamically load and destructure `taskTemplate`, build the smallest resolved service fixture, and call `taskTemplate("task-api", "svc-api", ...)`. Assert `family === "task-api"` while the parsed application container has `logConfiguration.options["awslogs-group"] === "/aws/ecs/svc-api"`.

Name the test exactly:

```ts
test("service-fleet-intent produces a task definition using the canonical service log group", () => {
  // arrange a minimal resolved service, call taskTemplate, and assert family/log identities differ as above
});
```

- [ ] **Step 4: Test desired-count ownership by activation and elasticity**

Create `_tests/aws-ecs/service-fleet-intent-produces-reconciliation.test.ts`, dynamically obtain `desiredCountIgnoreChanges` through `loadEcs`, and use this table:

```ts
test.each([
  [false, { min: 1, max: 1 }, ["desiredCount"]],
  [false, { min: 1, max: 4 }, ["desiredCount"]],
  [true, { min: 1, max: 4 }, ["desiredCount"]],
  [true, { min: 2, max: 2 }, []],
])(
  "service-fleet-intent produces desired-count ownership for activated=%p scaling=%o",
  (activated, scaling, expected) => {
    expect(desiredCountIgnoreChanges(activated, scaling)).toEqual(expected);
  },
);
```

This proves preactivation remains protected, elastic services remain autoscaler-owned, and an activated fixed-size service reconciles `desiredCount`.

- [ ] **Step 5: Test discovery and public endpoint meaning**

Create `_tests/aws-ecs/service-fleet-intent-produces-endpoints.test.ts`, dynamically obtain `ConfigSchema`, `internalEndpoint`, and `publicEndpointHost` through `loadEcs`, and assert all of the following with relation-named tests:

```ts
test("service-fleet-intent accepts only a strict external discovery namespace identity", () => {
  // ConfigSchema accepts discoveryNamespace: { name: "apps.internal", arn: "arn:aws:servicediscovery:..." }.
  // It rejects a string and rejects an object with an extra key.
});

test("service-fleet-intent produces one internal endpoint meaning for alias and output", () => {
  expect(internalEndpoint("api", "apps.internal", 8080)).toEqual({
    dnsName: "api.apps.internal",
    port: 8080,
    uri: "api.apps.internal:8080",
  });
});

test("service-fleet-intent requires public names whenever a certificate is supplied", () => {
  // ConfigSchema rejects owned-alb exposure with certificateArn and publicNames: [].
});

test("service-fleet-intent produces the first public name or falls back to ALB DNS", () => {
  expect(publicEndpointHost(["api.example.com", "api-alt.example.com"], "alb.aws"))
    .toBe("api.example.com");
  expect(publicEndpointHost([], "alb.aws")).toBe("alb.aws");
});
```

Use a shared local config factory inside this test file, not a production fixture module. Preserve the existing validation that non-empty `publicNames` requires `certificateArn`; the two fields therefore become paired when TLS is configured.

- [ ] **Step 6: Test reviewed Fargate boundaries**

Create `_tests/aws-ecs/service-fleet-intent-validates-capacity.test.ts` and dynamically obtain `validateFargateSize` and `ConfigSchema` through `loadEcs`:

```ts
test.each([61440, 122880, 249856])(
  "service-fleet-intent accepts the reviewed 32-vCPU memory boundary %i",
  (memoryMb) => expect(() => validateFargateSize("worker", 32768, memoryMb)).not.toThrow(),
);

test("service-fleet-intent caps ephemeral storage at 200 GiB", () => {
  // Parse otherwise-valid configs with ephemeralStorageGb 200 and 201;
  // expect 200 to succeed and 201 to fail.
});
```

The first table intentionally checks the three accepted values requested by review. Do not broaden the matrix beyond correcting the current 32-vCPU row.

- [ ] **Step 7: Test target attachment and workload identity**

Create `_tests/aws-ecs/target-attachment-point-produces-workload-target-identity.test.ts` and dynamically obtain `assertExternalTargetGroupTargetType` and `workloadTarget` through `loadEcs`:

```ts
test("target-attachment-point rejects a non-ip target group", () => {
  expect(() => assertExternalTargetGroupTargetType("api", "instance"))
    .toThrow('external-attachment target group must use targetType "ip"');
  expect(() => assertExternalTargetGroupTargetType("api", "ip")).not.toThrow();
});

test("target-attachment-point produces workload-target-identity with target, health, and drain meaning", () => {
  expect(workloadTarget({
    port: 8080,
    health: { path: "/ready", gracePeriodSeconds: 45 },
  } as any)).toEqual({
    targetType: "ip",
    port: 8080,
    protocol: "HTTP",
    health: { protocol: "HTTP", path: "/ready", gracePeriodSeconds: 45 },
    deregistrationDelaySeconds: 300,
  });
});
```

Prefer a typed fixture over `as any` if the narrow exported helper signature permits it.

- [ ] **Step 8: Add an explicit focused TypeScript project**

Create `_tests/aws-ecs/tsconfig.json`:

```json
{
  "extends": "../../.js/tsconfig.json",
  "compilerOptions": {
    "noEmit": true,
    "rootDir": "../..",
    "types": ["bun"]
  },
  "include": [
    "../../aws-ecs/index.ts",
    "./*.ts"
  ]
}
```

This explicit project prevents a focused check from silently ignoring repository compiler options.

- [ ] **Step 9: Run the tests and confirm they fail for the intended reasons**

Run from repository root:

```bash
bun test _tests/aws-ecs
```

Expected before implementation: failures identifying the family/service-name log mismatch, unconditional desired-count ignore, old string namespace schema, missing certificate inverse validation, ALB-DNS-only public URI, invalid 32-vCPU memory row, missing 200-GiB cap, missing target-type guard, and missing workload-target identity. Import/export errors are acceptable only until Step 1's seams are in place; eliminate fixture/type errors before implementation.

### Task 2: Implement the minimal contract corrections

- [ ] **Step 1: Make discovery namespace an externally owned strict identity**

In `ConfigSchema`, replace the string with:

```ts
discoveryNamespace: z
  .object({
    name: z.string().min(1),
    arn: z.string().min(1),
  })
  .strict(),
```

Remove `new aws.servicediscovery.HttpNamespace(...)`. Use `config.discoveryNamespace.arn` in both `aws.ecs.Cluster.serviceConnectDefaults.namespace` and every ECS service's `serviceConnectConfiguration.namespace`. Return `namespaceArn: config.discoveryNamespace.arn`.

Change the state schema's optional `discoveryNamespace` to the same strict `{ name, arn }` schema and assign the full object. Build the fleet fingerprint from both parts of the externally owned identity:

```ts
const fleetFingerprint = JSON.stringify({
  discoveryNamespace: config.discoveryNamespace,
});
```

This refuses replacement when either the reachability name or its environment-owned ARN changes; an ARN change under the same name must not bypass the fleet identity guard.

- [ ] **Step 2: Use one internal endpoint helper for Service Connect and output**

For internal services, calculate one local value:

```ts
const endpoint = service.exposure.mode === "internal"
  ? internalEndpoint(
      serviceKey,
      config.discoveryNamespace.name,
      service.port!,
    )
  : undefined;
```

Use `endpoint.dnsName` and `endpoint.port` for the Service Connect client alias. Use `endpoint.uri` for `internalEndpoints[serviceKey]`. Do not construct either address independently elsewhere.

- [ ] **Step 3: Use the canonical ECS service name in both task-definition paths**

Change `taskTemplate` to accept `serviceName` independently of `family` and pass it to `containerDefinitions`:

```ts
function taskTemplate(
  family: string,
  serviceName: string,
  service: ResolvedServiceConfig,
  // existing role, region, and image arguments
): TaskDefinitionTemplate
```

At its call site, pass `family, serviceName, service, ...`. Keep `family` for task-definition family only. The directly provisioned Pulumi task definition already passes `serviceName`; keep that path canonical.

- [ ] **Step 4: Correct desired-count reconciliation ownership**

Keep `desiredCount: serviceActivated ? service.scaling.min : 0`. Replace unconditional `ignoreChanges: ["desiredCount"]` with:

```ts
ignoreChanges: desiredCountIgnoreChanges(
  serviceActivated,
  service.scaling,
),
```

The result must ignore desired count only before activation or for elastic services (`max > min`). Activated fixed services (`min === max`) must have an empty ignore list so infra reconciliation restores the reviewed count.

- [ ] **Step 5: Correct Fargate limits**

In `ServiceConfigSchema.ephemeralStorageGb`, add `.max(200)` between `.min(...)` and `.default(...)`.

Replace only the 32-vCPU matrix row with the exact accepted values:

```ts
32768: [61440, 122880, 249856],
```

Keep all lower CPU rows unchanged.

- [ ] **Step 6: Tighten certificate validation and public addressing**

Retain the current `publicNames.length > 0 && !certificateArn` validation. Add the inverse in `validateResolvedConfig`:

```ts
if (
  service.exposure.mode === "owned-alb" &&
  service.exposure.certificateArn &&
  service.exposure.publicNames.length === 0
) {
  throw new Error(
    `aws-ecs: service "${serviceKey}" certificateArn requires at least one publicName.`,
  );
}
```

For owned ALBs, produce the public URI with the first declared public name, falling back to the ALB DNS name only when no public name exists:

```ts
publicEndpoints[serviceKey] = loadBalancer.dnsName.apply(
  (dnsName) =>
    `${publicProtocol(service)}://${publicEndpointHost(
      service.exposure.publicNames,
      dnsName,
    )}`,
);
```

- [ ] **Step 7: Validate external target-group compatibility**

Immediately after `aws.lb.getTargetGroupOutput`, derive a Pulumi output that calls `assertExternalTargetGroupTargetType(serviceKey, targetType)`. Make the ingress rule and ECS service depend on/consume that validation output so preview/update cannot proceed to attachment when the externally supplied target group is not `ip`.

Use the smallest Pulumi pattern that preserves the validation edge, for example an `apply` used in the load-balancer attachment's target-group ARN:

```ts
const validatedTargetGroupArn = pulumi
  .all([externalTargetGroup.arn, externalTargetGroup.targetType])
  .apply(([arn, targetType]) => {
    assertExternalTargetGroupTargetType(serviceKey, targetType);
    return arn;
  });
```

Use `validatedTargetGroupArn` in `loadBalancers`; retain the declared ARN for the lookup itself.

- [ ] **Step 8: Add workload-target output and state**

Define one `WorkloadTargetSchema` matching the exact `WorkloadTarget` shape from Task 1 and use it in both schemas:

```ts
const WorkloadTargetSchema = z.object({
  targetType: z.literal("ip"),
  port: z.number().int().min(1).max(65535),
  protocol: z.literal("HTTP"),
  health: z.object({
    protocol: z.literal("HTTP"),
    path: z.string(),
    gracePeriodSeconds: z.number().int().min(0),
  }).strict(),
  deregistrationDelaySeconds: z.number().int().min(0).max(3600),
}).strict();
```

Add `workloadTargets: z.record(z.string(), WorkloadTargetSchema)` to component output schema. Add the same record with `.default({})` to provider state schema and `{}` to initial state.

In `pulumi`, declare `const workloadTargets: Record<string, WorkloadTarget> = {};`. For each `external-attachment` service only, assign `workloadTargets[serviceKey] = workloadTarget(service)`. Persist it to `state.workloadTargets` and return `workloadTargets: pulumi.output(workloadTargets)`.

Do not emit entries for `none`, `internal`, or `owned-alb`: this relation describes the address-level attachment contract for an external traffic distributor.

- [ ] **Step 9: Update the component catalogue**

Add this row to the alphabetically appropriate AWS area of `README.md`'s Infrastructure table:

```markdown
| `aws-ecs/` | AWS ECS Fargate service fleet with reviewed scaling, discovery, exposure, and deployment posture |
```

Do not expand README into a full ECS configuration reference.

- [ ] **Step 10: Run focused tests until green**

Run:

```bash
bun test _tests/aws-ecs
```

Expected: all tests in the five relation-focused modules pass; no AWS credentials or network are required.

### Task 3: Verify, review, and commit

- [ ] **Step 1: Run the focused ECS TypeScript project**

Run:

```bash
./.js/node_modules/.bin/tsc --project _tests/aws-ecs/tsconfig.json --pretty false
```

Expected: exit 0 with no diagnostics. Fix ECS/test typing errors; do not weaken strict compiler options.

- [ ] **Step 2: Run the full TypeScript check and classify its baseline**

First record the pre-implementation/full-branch diagnostics if they were not already captured, then run the same command after the patch:

```bash
./.js/node_modules/.bin/tsc --noEmit --project .js/tsconfig.json --pretty false
```

Expected: either exit 0, or only diagnostics demonstrably present on `HEAD` before this patch. Classify every diagnostic touching `aws-ecs/index.ts` or `_tests/aws-ecs`; no new ECS diagnostic is acceptable. Do not repair unrelated components in this change.

- [ ] **Step 3: Verify the frozen dependency graph**

Run with working directory `.js`:

```bash
bun install --frozen-lockfile
```

Expected: exit 0 and `.js/bun.lock` remains unchanged.

- [ ] **Step 4: Run the complete test suite**

Run from repository root:

```bash
bun test
```

Expected: exit 0. If unrelated tests already fail on `HEAD`, record the exact baseline comparison and do not conceal it.

- [ ] **Step 5: Build the full component bundle**

Run from repository root:

```bash
sdlc-components-build --bundle
```

Expected: exit 0 and `.js/infra-bundle.tar.gz` is produced. Treat a toolchain failure as a reported verification blocker only after confirming the same failure on `HEAD`; do not commit generated bundle output unless it is already tracked and intentionally changed.

- [ ] **Step 6: Check whitespace, contract scope, and unrelated diffs**

Run:

```bash
git diff --check
git status --short
git diff -- aws-ecs/index.ts _tests/aws-ecs README.md
git diff -- aws-ecs/SUBSYSTEM.md
git diff -- .js/bun.lock
```

Expected:

- `git diff --check` is silent.
- Implementation changes are limited to `aws-ecs/index.ts`, `_tests/aws-ecs/**`, and the single README catalogue row, plus this plan artifact if it is being committed.
- `aws-ecs/SUBSYSTEM.md` has no diff.
- `.js/bun.lock` has no diff.
- Existing unrelated user changes, if any, are preserved and excluded from this commit.

- [ ] **Step 7: Obtain independent review**

Give an independent reviewer the contract `aws-ecs/SUBSYSTEM.md`, this plan, and the final diff. Ask them to verify these exact points:

1. externally owned discovery uses ARN for AWS bindings, name for endpoints, and both name and ARN in the replacement fingerprint;
2. the canonical service name drives both log-group creation and every task template;
3. desired count is ignored exactly for preactivation or elasticity;
4. 32-vCPU and ephemeral limits are exact;
5. certificate/name validation and public URI addressing agree;
6. external target groups must be `ip`;
7. `workloadTargets` is schema/state/output complete and emitted only for external attachment;
8. tests are pure and no unrelated subsystem behaviour changed.

Address every accepted finding, rerun the affected focused tests and TypeScript project, and repeat `git diff --check`.

- [ ] **Step 8: Commit the reviewed change**

Stage only the intended paths:

```bash
git add aws-ecs/index.ts _tests/aws-ecs README.md .ai/plans/aws-ecs-review-fix/plan.md
git diff --cached --check
git diff --cached --stat
git commit -m "fix: align aws ecs component contract"
```

Expected: the cached diff contains only the intended ECS fix, tests, README row, and plan; the commit succeeds. Pushing is performed by the parent orchestration after final branch/status verification.

## Acceptance criteria

- Both task-definition creation paths log to `/aws/ecs/<canonical serviceName>`.
- One helper defines Service Connect alias and internal endpoint output.
- Preactivation and elastic desired counts are ignored; activated fixed desired counts reconcile.
- The discovery namespace is a strict external `{ name, arn }` input; no namespace resource is created.
- Namespace ARN is used in AWS resources, namespace name in endpoints, and both name and ARN in the fleet fingerprint so either identity change is refused.
- 32-vCPU memory accepts exactly the reviewed values and ephemeral storage rejects values over 200 GiB.
- Certificate ARN and public names are mutually required for TLS; public URI selects the first public name, otherwise ALB DNS.
- External target groups reject any target type other than `ip`.
- `workloadTargets` exists in output schema, state schema/initial state, persisted state, and returned output with target, port/protocol, health, and deregistration meaning.
- Pure Bun regression tests pass without a live AWS harness; they load the production module only through the test-only pre-mocking loader, leaving component registration inert.
- If pre-mocking cannot isolate Pulumi under Bun, implementation stops for parent replanning before any pure-policy production-module extraction.
- README includes the AWS ECS component.
- No `SUBSYSTEM.md`, lockfile, or unrelated implementation changes are present.
