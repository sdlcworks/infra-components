import { z } from "zod";
import { execSync } from "node:child_process";
import { ArtifactRegistry, DeploymentArtifactType } from "@sdlcworks/components";

const registry = new ArtifactRegistry({
  acceptedArtifactTypes: [DeploymentArtifactType.oci_spec_image],
  configSchema: z.object({
    location: z.string(),
    repositoryId: z.string(),
    description: z.string().optional(),
    immutableTags: z.boolean().optional(),
  }),
  stateSchema: z.object({
    location: z.string(),
    repositoryId: z.string(),
  }),
  provision: async ({ config, state, $, gcp }) => {
    if (!gcp) throw new Error("gcp-artifact-registry requires gcloud provider");

    const gcpOpts = gcp ? { provider: gcp } : {};
    new gcp.artifactregistry.Repository($`repo`, {
      location: config.location,
      repositoryId: config.repositoryId,
      format: "DOCKER",
      description: config.description,
      ...(config.immutableTags
        ? { dockerConfig: { immutableTags: true } }
        : {}),
    }, gcpOpts);

    state.location = config.location;
    state.repositoryId = config.repositoryId;
  },
  publish: async ({ componentName, artifacts, version, state, getCredentials }) => {
    const { location, repositoryId } = state;
    const creds = getCredentials() as {
      GCP_PROJECT_ID: string;
      GCP_SERVICE_ACCOUNT_KEY: string;
    };

    const dockerHost = `${location}-docker.pkg.dev`;

    // Authenticate docker to GCP Artifact Registry once per invocation; every
    // labelled image is pushed under the same credentials.
    execSync(
      `echo '${creds.GCP_SERVICE_ACCOUNT_KEY}' | docker login -u _json_key --password-stdin ${dockerHost}`,
      { stdio: ["inherit", process.stderr, "inherit"] },
    );

    // Push each labelled image under a distinct tag so multi-variant publishes
    // (e.g. per-arch images) don't collide within the repository.
    const pushed: Record<string, { uri: string }> = {};
    for (const [label, artifact] of Object.entries(artifacts)) {
      const target = `${dockerHost}/${creds.GCP_PROJECT_ID}/${repositoryId}/${componentName}-${label}:${version}`;

      // Tag the source image (artifact.uri is a remote docker ref, CI is pre-authenticated to source)
      execSync(`docker tag ${artifact.uri} ${target}`, {
        stdio: ["inherit", process.stderr, "inherit"],
      });

      execSync(`docker push ${target}`, {
        stdio: ["inherit", process.stderr, "inherit"],
      });

      console.error(`Pushed ${target}`);
      pushed[label] = { uri: target };
    }

    return { artifacts: pushed };
  },
});

export default registry;
