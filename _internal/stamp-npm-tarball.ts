import { execSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * Rewrite the `version` field inside an npm tarball's `package/package.json`
 * and repack a new `.tgz`. Returns the path to the new tarball -- the caller
 * is responsible for cleaning it up.
 *
 * Only the `version` field is changed; every other field and every other file
 * in the tarball are preserved byte-for-byte (modulo tar metadata such as
 * timestamps on the rewritten package.json).
 *
 * Uses shell `tar` + `gzip` via execSync. No new dependencies.
 */
export function stampNpmTarball(
  tarballPath: string,
  targetVersion: string,
): string {
  const workDir = mkdtempSync(join(tmpdir(), "sdlc-stamp-npm-"));

  try {
    // Extract the entire tarball into the work directory.
    execSync(`tar -xzf ${tarballPath} -C ${workDir}`, {
      stdio: ["ignore", "ignore", "inherit"],
    });

    // Read, patch, and write back package.json.
    const pkgJsonPath = join(workDir, "package", "package.json");
    const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf-8"));
    pkg.version = targetVersion;
    writeFileSync(pkgJsonPath, JSON.stringify(pkg, null, 2) + "\n");

    // Repack into a new tarball in the same work directory.
    const stampedPath = join(workDir, "stamped.tgz");
    execSync(`tar -czf ${stampedPath} -C ${workDir} package`, {
      stdio: ["ignore", "ignore", "inherit"],
    });

    return stampedPath;
  } catch (err) {
    // Clean up on failure so we don't leak temp dirs.
    rmSync(workDir, { recursive: true, force: true });
    throw err;
  }
}
