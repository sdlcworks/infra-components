import { buildProviderHarness, inspectCatalogues } from "../test-support/built-provider-harness";
import { awsCodeBuildScenarioCatalogue, registerAwsCodeBuildClaims } from "./claims";

async function main() {
  const tests: Array<{ name: string; run: () => unknown | Promise<unknown> }> = [];
  registerAwsCodeBuildClaims({ test: (name, run) => tests.push({ name, run }) });
  for (const test of tests) {
    await test.run();
    console.log(`PASS ${test.name}`);
  }
  const filter = process.argv[2];
  const selected = filter
    ? awsCodeBuildScenarioCatalogue.filter((descriptor) => descriptor.id.includes(filter))
    : awsCodeBuildScenarioCatalogue;
  for (let offset = 0; offset < selected.length; offset += 7) {
    const harness = buildProviderHarness();
    try {
      const report = await inspectCatalogues(harness, [selected.slice(offset, offset + 7)]);
      for (const result of report.failures) {
        if (result.shapeErrors.length > 0 || result.firstMismatch) {
          console.error(`FAIL ${result.descriptor}`, result.shapeErrors, result.firstMismatch);
          process.exitCode = 1;
        } else console.log(`PASS ${result.descriptor}`);
      }
    } finally {
      harness.close();
    }
  }
}

void main();
