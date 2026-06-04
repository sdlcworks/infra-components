import { z } from "zod";
import { execSync } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ArtifactRegistry, DeploymentArtifactType } from "@sdlcworks/components";

const registry = new ArtifactRegistry({
  acceptedArtifactTypes: [DeploymentArtifactType.file],
  configSchema: z.object({}),
  provision: async () => {
    // No cloud resources needed — npmjs.com is external.
  },
  publish: async ({ componentName, artifacts, version, getCredentials }) => {
    // npm publishes are one tarball per package version — a single registry
    // entry can't accept multiple labelled artifacts in one release. Reject
    // upfront rather than publishing a racy stream of same-version tarballs.
    const labels = Object.keys(artifacts);
    if (labels.length !== 1) {
      throw new Error(
        `npm-public expects exactly one labelled artifact per publish, got ${labels.length} ` +
          `for component '${componentName}': [${labels.join(", ")}]. ` +
          `Split the extra labels into separate artifact_registries entries.`,
      );
    }
    const [label] = labels;
    const artifact = artifacts[label];

    const creds = getCredentials() as { NPM_TOKEN: string };
    if (!creds.NPM_TOKEN) {
      throw new Error(
        "npm-public: NPM_TOKEN not found in cloud_credentials for provider 'npm'. " +
          "Add npm credentials to cloud_credentials in the project config.",
      );
    }

    // Extract package name from the tarball's package.json so the returned
    // URI points at the canonical npmjs.com page, not just the component
    // name (which may differ from the published package name).
    const pkgJSONRaw = execSync(
      `tar -xzOf ${artifact.uri} package/package.json`,
      { stdio: ["ignore", "pipe", "inherit"] },
    ).toString();
    const packageName = JSON.parse(pkgJSONRaw).name as string;
    if (!packageName) {
      throw new Error(
        `npm-public: package.json inside ${artifact.uri} has no "name" field (label '${label}')`,
      );
    }

    const npmrcPath = join(tmpdir(), `.npmrc-sdlc-${Date.now()}`);
    writeFileSync(
      npmrcPath,
      `//registry.npmjs.org/:_authToken=${creds.NPM_TOKEN}\n`,
    );

    try {
      execSync(
        `npm publish ${artifact.uri} --registry https://registry.npmjs.org --userconfig ${npmrcPath}`,
        { stdio: ["inherit", process.stderr, "inherit"] },
      );
      console.error(
        `Published ${componentName}:${label} as ${packageName}@${version} to npmjs.com`,
      );
    } finally {
      try {
        unlinkSync(npmrcPath);
      } catch {}
    }

    return {
      artifacts: {
        [label]: {
          uri: `https://www.npmjs.com/package/${packageName}/v/${version}`,
        },
      },
    };
  },
});

export default registry;
