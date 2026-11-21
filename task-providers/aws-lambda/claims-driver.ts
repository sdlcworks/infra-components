import { buildProviderHarness, inspectCatalogues } from "../test-support/built-provider-harness";
import { awsLambdaScenarioCatalogue, registerAwsLambdaClaims } from "./claims";
async function main() {
  const cases: Array<{ name: string; body: () => void | Promise<void> }> = [];
  registerAwsLambdaClaims({ test: (name, body) => cases.push({ name, body }) });
  for (const claim of cases) { await claim.body(); process.stdout.write(`PASS ${claim.name}\n`); }
  const harness = buildProviderHarness();
  try {
    const selected = process.argv[2] ? awsLambdaScenarioCatalogue.filter((descriptor) => descriptor.id.includes(process.argv[2]!)) : awsLambdaScenarioCatalogue;
    const report = await inspectCatalogues(harness, [selected]);
    for (const result of report.failures) {
      if (result.shapeErrors.length > 0 || result.firstMismatch) { console.error(`FAIL ${result.descriptor}`, result.shapeErrors, result.firstMismatch); process.exitCode = 1; }
      else console.log(`PASS ${result.descriptor}`);
    }
  } finally { harness.close(); }
}
void main();
