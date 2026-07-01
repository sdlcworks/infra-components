import { z } from "zod";
import { execSync } from "node:child_process";
import { writeFileSync, unlinkSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { ArtifactRegistry, DeploymentArtifactType } from "@sdlcworks/components";
import { stampNpmTarball } from "../../_internal/stamp-npm-tarball";

const registry = new ArtifactRegistry({
  acceptedArtifactTypes: [DeploymentArtifactType.file],
  configSchema: z.object({}),
  provision: async () => {
    // No cloud resources needed — npmjs.com is external.
  },
  publish: async ({ componentName, artifacts, version, publishVersion, getCredentials }) => {
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

    // When publishVersion is provided, stamp it into the tarball's
    // package.json. Otherwise publish the tarball untouched (existing
    // behaviour for components without retain_sdlc_version_string_info).
    const effectiveVersion = publishVersion || version;
    let tarballToPublish = artifact.uri;
    let stampedTarball: string | undefined;

    if (publishVersion) {
      stampedTarball = stampNpmTarball(artifact.uri, publishVersion);
      tarballToPublish = stampedTarball;
    }

    const npmrcPath = join(tmpdir(), `.npmrc-sdlc-${Date.now()}`);
    writeFileSync(
      npmrcPath,
      `//registry.npmjs.org/:_authToken=${creds.NPM_TOKEN}\n`,
    );

    try {
      // Derive --tag flag: when the effective version has a prerelease
      // segment (e.g. "0.1.33-qa"), use the prerelease identifier as the
      // dist-tag so branch publishes don't fight over "latest". When there
      // is no prerelease (main branch, bare "0.1.33"), omit --tag so npm
      // defaults to "latest".
      let tagFlag = "";
      if (publishVersion) {
        const dashIdx = publishVersion.indexOf("-");
        if (dashIdx !== -1) {
          const prereleaseId = publishVersion.slice(dashIdx + 1);
          tagFlag = ` --tag ${prereleaseId}`;
        }
      }

      execSync(
        `npm publish ${tarballToPublish} --registry https://registry.npmjs.org --userconfig ${npmrcPath}${tagFlag}`,
        { stdio: ["inherit", process.stderr, "inherit"] },
      );
      console.error(
        `Published ${componentName}:${label} as ${packageName}@${effectiveVersion} to npmjs.com`,
      );
    } finally {
      try {
        unlinkSync(npmrcPath);
      } catch {}
      if (stampedTarball) {
        try {
          rmSync(dirname(stampedTarball), { recursive: true, force: true });
        } catch {}
      }
    }

    return {
      artifacts: {
        [label]: {
          uri: `https://www.npmjs.com/package/${packageName}/v/${effectiveVersion}`,
        },
      },
    };
  },
});

export default registry;
