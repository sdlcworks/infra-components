import assert from "node:assert/strict";
import test from "node:test";
import { awsEc2ScenarioCatalogue } from "./aws-ec2/fixture";
import { awsLambdaScenarioCatalogue } from "./aws-lambda/claims";
import { awsCodeBuildScenarioCatalogue } from "./aws-codebuild/claims";
import { kubernetesScenarioCatalogue } from "./kubernetes/claims";
import { buildProviderHarness, inspectCatalogues, validateScenarioDescriptor } from "./test-support/built-provider-harness";

const catalogues = [awsEc2ScenarioCatalogue.filter((descriptor) => validateScenarioDescriptor(descriptor).length === 0), awsLambdaScenarioCatalogue, awsCodeBuildScenarioCatalogue, kubernetesScenarioCatalogue];

test("the authored infra bundle exposes and executes every committed provider scenario", { timeout: 1_800_000 }, async () => {
  const harness = buildProviderHarness();
  try {
    assert.deepEqual(Object.keys(harness.realizations).sort(), ["aws-codebuild", "aws-ec2", "aws-lambda", "kubernetes"]);
    const report = await inspectCatalogues(harness, catalogues);
    assert.deepEqual(report.failures.filter(({ shapeErrors, firstMismatch }) => shapeErrors.length > 0 || firstMismatch !== null), []);
  } finally {
    harness.close();
  }
});
