#!/usr/bin/env bash
set -euo pipefail

bun -e '
import { captureTaskContent } from "./js/apps/components-build/src/lib/taskContent.ts";
import { awsEc2ScenarioTaskContent } from "./infra/task-providers/aws-ec2/scenario-task-content.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "aws-ec2-scenario-content-"));
try {
  const source = path.join(scratch, "source");
  const output = path.join(scratch, "output");
  fs.mkdirSync(source, { recursive: true });
  for (const [name, content] of Object.entries(awsEc2ScenarioTaskContent.files)) {
    const destination = path.join(source, name);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, content);
  }
  const captured = captureTaskContent(source, output, "aws-ec2-scenario");
  const actual = { archiveSha256: captured.archiveSha256, treeSha256: captured.treeSha256 };
  const expected = {
    archiveSha256: awsEc2ScenarioTaskContent.archiveSha256,
    treeSha256: awsEc2ScenarioTaskContent.treeSha256,
  };
  if (process.argv.includes("--check") && JSON.stringify(actual) !== JSON.stringify(expected)) {
    console.error(JSON.stringify({ expected, actual }, null, 2));
    process.exitCode = 1;
  } else console.log(JSON.stringify(actual, null, 2));
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
' -- "$@"
