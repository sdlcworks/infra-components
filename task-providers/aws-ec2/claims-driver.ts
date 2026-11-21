import {
  buildProviderHarness,
  inspectCatalogues,
} from "../test-support/built-provider-harness";
import { awsEc2ScenarioCatalogue } from "./fixture";

async function main(): Promise<void> {
  const harness = buildProviderHarness();
  try {
    const selected = process.argv[2]
      ? awsEc2ScenarioCatalogue.filter((descriptor) =>
          descriptor.id.includes(process.argv[2]!),
        )
      : awsEc2ScenarioCatalogue;
    const report = await inspectCatalogues(harness, [selected]);
    for (const result of report.failures) {
      if (result.shapeErrors.length > 0 || result.firstMismatch) {
        console.error(
          `FAIL ${result.descriptor}`,
          result.shapeErrors,
          result.firstMismatch,
        );
        process.exitCode = 1;
      } else {
        console.log(`PASS ${result.descriptor}`);
      }
    }
  } finally {
    harness.close();
  }
}

void main();
