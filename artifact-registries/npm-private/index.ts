import { z } from "zod";
import { execSync } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ArtifactRegistry, DeploymentArtifactType } from "@sdlcworks/components";

const registry = new ArtifactRegistry({
  acceptedArtifactTypes: [DeploymentArtifactType.file],
  configSchema: z.object({
    feed: z.string(),
    project: z.string().optional(),
    scope: z.string(),
  }),
  stateSchema: z.object({
    feed: z.string(),
    project: z.string().optional(),
    scope: z.string(),
  }),
  provision: async ({ config, state }) => {
    state.feed = config.feed;
    state.project = config.project;
    state.scope = config.scope;
  },
  publish: async ({ componentName, artifacts, version, state, getCredentials }) => {
    const labels = Object.keys(artifacts);
    if (labels.length !== 1) {
      throw new Error(
        `npm-private expects exactly one labelled artifact per publish, got ${labels.length} ` +
          `for component '${componentName}': [${labels.join(", ")}]. ` +
          `Split the extra labels into separate artifact_registries entries.`,
      );
    }
    const [label] = labels;
    const artifact = artifacts[label];

    const creds = getCredentials() as {
      AZURE_DEVOPS_ORG?: string;
      AZURE_DEVOPS_PAT?: string;
    };
    if (!creds.AZURE_DEVOPS_ORG || !creds.AZURE_DEVOPS_PAT) {
      throw new Error(
        "npm-private: AZURE_DEVOPS_ORG and AZURE_DEVOPS_PAT not found in cloud_credentials for provider 'azuredevops'. " +
          "Add azuredevops credentials to cloud_credentials in the project config.",
      );
    }

    const { feed, project } = state;
    const feedPath = project
      ? `${creds.AZURE_DEVOPS_ORG}/${project}/_packaging/${feed}/npm`
      : `${creds.AZURE_DEVOPS_ORG}/_packaging/${feed}/npm`;
    const registryURL = `https://pkgs.dev.azure.com/${feedPath}/registry/`;

    const pkgJSONRaw = execSync(
      `tar -xzOf ${artifact.uri} package/package.json`,
      { stdio: ["ignore", "pipe", "inherit"] },
    ).toString();
    const packageName = JSON.parse(pkgJSONRaw).name as string;
    if (!packageName) {
      throw new Error(
        `npm-private: package.json inside ${artifact.uri} has no "name" field (label '${label}')`,
      );
    }

    const encodedPAT = Buffer.from(creds.AZURE_DEVOPS_PAT).toString("base64");
    const npmrcPath = join(tmpdir(), `.npmrc-sdlc-npmprivate-${Date.now()}`);
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
      execSync(
        `npm publish ${artifact.uri} --registry ${registryURL} --userconfig ${npmrcPath}`,
        { stdio: ["inherit", process.stderr, "inherit"] },
      );
      console.error(
        `Published ${componentName}:${label} as ${packageName}@${version} to '${feed}' (${creds.AZURE_DEVOPS_ORG}${project ? "/" + project : ""})`,
      );
    } finally {
      try {
        unlinkSync(npmrcPath);
      } catch {}
    }

    const feedPageBase = project
      ? `https://dev.azure.com/${creds.AZURE_DEVOPS_ORG}/${project}/_artifacts/feed/${feed}`
      : `https://dev.azure.com/${creds.AZURE_DEVOPS_ORG}/_artifacts/feed/${feed}`;
    return {
      artifacts: {
        [label]: {
          uri: `${feedPageBase}/Npm/${encodeURIComponent(packageName)}/${version}`,
        },
      },
    };
  },
});

export default registry;
