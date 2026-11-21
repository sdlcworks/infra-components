import assert from "node:assert/strict";
import test from "node:test";
import { awsEc2ScenarioCatalogue } from "./aws-ec2/fixture";
import { awsLambdaScenarioCatalogue } from "./aws-lambda/claims";
import { awsCodeBuildScenarioCatalogue } from "./aws-codebuild/claims";
import { kubernetesScenarioCatalogue } from "./kubernetes/claims";
import { buildProviderHarness, inspectCatalogues, validateScenarioDescriptor } from "./test-support/built-provider-harness";

const catalogues = [awsEc2ScenarioCatalogue.filter((descriptor) => validateScenarioDescriptor(descriptor).length === 0), awsLambdaScenarioCatalogue, awsCodeBuildScenarioCatalogue, kubernetesScenarioCatalogue];

test("the built host produces each provider world's declared effects", { timeout: 1_800_000 }, async () => {
  const harness = buildProviderHarness();
  try {
    const report = await inspectCatalogues(harness, catalogues);
    assert.deepEqual(report.failures.filter(({ shapeErrors, firstMismatch }) => shapeErrors.length > 0 || firstMismatch !== null), []);
  } finally {
    harness.close();
  }
});
