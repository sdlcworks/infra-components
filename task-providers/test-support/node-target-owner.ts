import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";

export async function runNodeTargetOwner(entrypoint: string): Promise<void> {
  const outputDirectory = mkdtempSync(path.join(path.dirname(entrypoint), ".node-owner-"));
  const output = path.join(outputDirectory, path.basename(entrypoint).replace(/\.ts$/, ".js"));
  try {
    const build = spawnSync("bun", ["build", entrypoint, "--target=node", "--format=esm", "--splitting", "--external=@pulumi/*", "--external=@aws-sdk/*", "--external=@smithy/*", "--external=@sdlcworks/components", "--external=@sdlcworks/components/*", "--external=zod", "--outdir", outputDirectory], {
      encoding: "utf8",
    });
    if (build.status !== 0) throw new Error(`node-target-owner-build-failed\n${build.stdout}\n${build.stderr}`);
    const result = spawnSync("node", ["--test", output], {
      encoding: "utf8",
      timeout: 1_800_000,
    });
    if (result.status !== 0) throw new Error(`node-target-owner-failed\n${result.stdout}\n${result.stderr}`);
  } finally {
    rmSync(outputDirectory, { recursive: true, force: true });
  }
}
