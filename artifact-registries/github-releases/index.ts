import { z } from "zod";
import { readFileSync } from "node:fs";
import {
  ArtifactRegistry,
  DeploymentArtifactType,
} from "@sdlcworks/components";

const registry = new ArtifactRegistry({
  acceptedArtifactTypes: [DeploymentArtifactType.file],
  configSchema: z.object({
    /** GitHub org or user (e.g., "systemsway-qa") */
    owner: z.string(),
    /** GitHub repo name (e.g., "sdlc") */
    repo: z.string(),
  }),
  stateSchema: z.object({
    /** Persisted from config so publish() can access it */
    owner: z.string(),
    repo: z.string(),
  }),
  provision: async ({ config, state }) => {
    // No cloud resources needed — GitHub Releases is built into GitHub.
    // Persist config values to state so they're available during publish().
    state.owner = config.owner;
    state.repo = config.repo;
  },
  publish: async ({
    componentName,
    artifacts,
    version,
    tag,
    state,
    getCredentials,
  }) => {
    const { owner, repo } = state;

    // Get GH_TOKEN from cloud_credentials (provider: "github")
    const creds = getCredentials() as { GH_TOKEN: string };
    const ghToken = creds.GH_TOKEN;
    if (!ghToken) {
      throw new Error(
        "github-release: GH_TOKEN not found in cloud_credentials for provider 'github'. " +
          "Add github credentials to cloud_credentials in the project config.",
      );
    }

    const tagName = `${componentName}/${tag}`;

    const headers = {
      Authorization: `Bearer ${ghToken}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    };

    // Create the release exactly once per invocation. If a release for the tag
    // already exists (e.g. a retry), reuse it so asset uploads are idempotent
    // against prior partial runs.
    const checkRes = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/releases/tags/${encodeURIComponent(
        tagName,
      )}`,
      { headers },
    );

    let release: { upload_url: string };
    if (checkRes.ok) {
      release = await checkRes.json();
      console.error(
        `GitHub Release '${tagName}' already exists, uploading assets to it`,
      );
    } else {
      const createRes = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/releases`,
        {
          method: "POST",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify({
            tag_name: tagName,
            name: `${componentName} v${version}`,
            draft: false,
            prerelease: false,
            generate_release_notes: true,
          }),
        },
      );

      if (!createRes.ok) {
        const err = await createRes.text();
        throw new Error(
          `Failed to create GitHub Release '${tagName}': ${createRes.status} ${err}`,
        );
      }

      release = await createRes.json();
      console.error(`Created GitHub Release '${tagName}'`);
    }

    const uploadUrl = release.upload_url.replace("{?name,label}", "");

    // Upload each labelled artifact as a release asset. artifact.uri is an
    // absolute local temp file path (downloaded from S3 by the Go CLI). The
    // asset name is keyed by the build label so multi-platform releases
    // (e.g. CLI binaries) don't collide within the shared release tag.
    const uploaded: Record<string, { uri: string }> = {};
    for (const [label, artifact] of Object.entries(artifacts)) {
      const binary = readFileSync(artifact.uri);
      const assetName = `${componentName}-${label}`;

      const uploadRes = await fetch(`${uploadUrl}?name=${assetName}`, {
        method: "POST",
        headers: {
          ...headers,
          "Content-Type": "application/octet-stream",
        },
        body: binary,
      });

      if (!uploadRes.ok) {
        const err = await uploadRes.text();
        throw new Error(
          `Failed to upload release asset '${assetName}': ${uploadRes.status} ${err}`,
        );
      }

      const asset = (await uploadRes.json()) as {
        browser_download_url: string;
      };
      console.error(`Uploaded '${assetName}' to ${asset.browser_download_url}`);
      uploaded[label] = { uri: asset.browser_download_url };
    }

    return { artifacts: uploaded };
  },
});

export default registry;
