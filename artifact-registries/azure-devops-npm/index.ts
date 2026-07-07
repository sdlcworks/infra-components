import { z } from "zod";
import { execSync } from "node:child_process";
import { writeFileSync, unlinkSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { ArtifactRegistry, DeploymentArtifactType } from "@sdlcworks/components";
import { stampNpmTarball } from "../../_internal/stamp-npm-tarball";

const registry = new ArtifactRegistry({
  acceptedArtifactTypes: [DeploymentArtifactType.file],
  configSchema: z.object({
    /** Azure DevOps Artifacts feed name (e.g., "internal-pkgs") */
    feedName: z.string(),
    /**
     * Azure DevOps project that owns the feed. Omit for organization-scoped feeds;
     * provide for project-scoped feeds.
     */
    project: z.string().optional(),
  }),
  stateSchema: z.object({
    feedName: z.string(),
    project: z.string().optional(),
  }),
  provision: async ({ config, state }) => {
    // No cloud resources to provision — the feed is created in Azure DevOps
    // out-of-band. Persist config to state so publish() can read it.
    state.feedName = config.feedName;
    state.project = config.project;
  },
  publish: async ({ componentName, artifacts, version, publishVersion, state, getCredentials }) => {
    // npm publishes are one tarball per package version — a single registry
    // entry can't accept multiple labelled artifacts in one release. Reject
    // upfront rather than publishing a racy stream of same-version tarballs.
    const labels = Object.keys(artifacts);
    if (labels.length !== 1) {
      throw new Error(
        `azure-devops-npm expects exactly one labelled artifact per publish, got ${labels.length} ` +
          `for component '${componentName}': [${labels.join(", ")}]. ` +
          `Split the extra labels into separate artifact_registries entries.`,
      );
    }
    const [label] = labels;
    const artifact = artifacts[label];

    const creds = getCredentials() as {
      AZURE_DEVOPS_ORG: string;
      AZURE_DEVOPS_PAT: string;
    };
    if (!creds.AZURE_DEVOPS_ORG || !creds.AZURE_DEVOPS_PAT) {
      throw new Error(
        "azure-devops-npm: AZURE_DEVOPS_ORG and AZURE_DEVOPS_PAT not found in cloud_credentials for provider 'azuredevops'. " +
          "Add azuredevops credentials to cloud_credentials in the project config.",
      );
    }

    const { feedName, project } = state;
    const feedPath = project
      ? `${creds.AZURE_DEVOPS_ORG}/${project}/_packaging/${feedName}/npm`
      : `${creds.AZURE_DEVOPS_ORG}/_packaging/${feedName}/npm`;
    const registryURL = `https://pkgs.dev.azure.com/${feedPath}/registry/`;

    // Extract package name from the tarball's package.json so the returned
    // URI points at the canonical Azure DevOps feed page, not just the
    // component name (which may differ from the published package name).
    const pkgJSONRaw = execSync(
      `tar -xzOf ${artifact.uri} package/package.json`,
      { stdio: ["ignore", "pipe", "inherit"] },
    ).toString();
    const packageName = JSON.parse(pkgJSONRaw).name as string;
    if (!packageName) {
      throw new Error(
        `azure-devops-npm: package.json inside ${artifact.uri} has no "name" field (label '${label}')`,
      );
    }

    const effectiveVersion = publishVersion || version;
    let tarballToPublish = artifact.uri;
    let stampedTarball: string | undefined;

    if (publishVersion) {
      stampedTarball = stampNpmTarball(artifact.uri, publishVersion);
      tarballToPublish = stampedTarball;
    }

    // Azure DevOps npm feeds require the PAT to be base64-encoded in
    // _authToken, and require entries for both the registry path and the
    // unscoped feed path so npm can resolve scoped-package metadata.
    const encodedPAT = Buffer.from(creds.AZURE_DEVOPS_PAT).toString("base64");
    const npmrcPath = join(tmpdir(), `.npmrc-sdlc-ado-${Date.now()}`);
    writeFileSync(
      npmrcPath,
      [
        `registry=${registryURL}`,
        `always-auth=true`,
        `//pkgs.dev.azure.com/${feedPath}/registry/:_authToken=${encodedPAT}`,
        `//pkgs.dev.azure.com/${feedPath}/registry/:always-auth=true`,
        `//pkgs.dev.azure.com/${feedPath}/:_authToken=${encodedPAT}`,
        `//pkgs.dev.azure.com/${feedPath}/:always-auth=true`,
        ``,
      ].join("\n"),
    );

    try {
      let tagFlag = "";
      if (publishVersion) {
        const dashIdx = publishVersion.indexOf("-");
        if (dashIdx !== -1) {
          const prereleaseId = publishVersion.slice(dashIdx + 1);
          tagFlag = ` --tag ${prereleaseId}`;
        }
      }

      execSync(
        `npm publish ${tarballToPublish} --registry ${registryURL} --userconfig ${npmrcPath}${tagFlag}`,
        { stdio: ["inherit", process.stderr, "inherit"] },
      );
      console.error(
        `Published ${componentName}:${label} as ${packageName}@${effectiveVersion} to Azure DevOps feed '${feedName}'`,
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

    const feedPageBase = project
      ? `https://dev.azure.com/${creds.AZURE_DEVOPS_ORG}/${project}/_artifacts/feed/${feedName}`
      : `https://dev.azure.com/${creds.AZURE_DEVOPS_ORG}/_artifacts/feed/${feedName}`;
    return {
      artifacts: {
        [label]: {
          uri: `${feedPageBase}/Npm/${encodeURIComponent(packageName)}/${effectiveVersion}`,
        },
      },
    };
  },
});

export default registry;
