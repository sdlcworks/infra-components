import { execFileSync } from "node:child_process";

export const LOCAL_WORLD_LABEL = "local-macos";
export const SUBSTRATE_CLUSTER_NAME = "sdlc-local";
export const SUBSTRATE_REGISTRY_NAME = "sdlc-local-registry";
export const SUBSTRATE_REGISTRY_HOST_PORT = 5910;
export const SUBSTRATE_HTTP_PORT = 5980;
export const REGISTRY_PUSH_ADDRESS = `localhost:${SUBSTRATE_REGISTRY_HOST_PORT}`;

const NAMESPACE_MAX_LENGTH = 63;

export type SubstrateHandle = {
  kubeconfig: string;
  apiServerUrl: string;
  registryPushAddress: string;
  registryClusterAddress: string;
};

export function toNamespaceName(seed: string): string {
  return seed
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, NAMESPACE_MAX_LENGTH)
    .replace(/-$/g, "");
}

export function toClusterImageRef(
  imageUri: string,
  pushAddress: string,
  clusterAddress: string,
): string {
  if (imageUri.startsWith(`${pushAddress}/`)) {
    return `${clusterAddress}/${imageUri.slice(pushAddress.length + 1)}`;
  }
  return imageUri;
}

function run(cmd: string, args: string[]): string {
  return execFileSync(cmd, args, { encoding: "utf8" });
}

function tryRun(cmd: string, args: string[]): string | undefined {
  try {
    return run(cmd, args);
  } catch {
    return undefined;
  }
}

function ensureDockerDaemon(): void {
  if (tryRun("docker", ["info"]) !== undefined) return;
  run("colima", ["start"]);
  if (tryRun("docker", ["info"]) === undefined) {
    throw new Error(
      `${LOCAL_WORLD_LABEL}: no container daemon reachable after converging the machine's Linux layer`,
    );
  }
}

function clusterExists(): boolean {
  const listed = tryRun("k3d", ["cluster", "list", "-o", "json"]);
  if (listed === undefined) return false;
  const clusters = JSON.parse(listed) as Array<{ name: string }>;
  return clusters.some((c) => c.name === SUBSTRATE_CLUSTER_NAME);
}

function ensureCluster(): void {
  if (clusterExists()) return;
  run("k3d", [
    "cluster",
    "create",
    SUBSTRATE_CLUSTER_NAME,
    "--registry-create",
    `${SUBSTRATE_REGISTRY_NAME}:0.0.0.0:${SUBSTRATE_REGISTRY_HOST_PORT}`,
    "-p",
    `${SUBSTRATE_HTTP_PORT}:80@loadbalancer`,
    "--wait",
  ]);
}

function registryClusterAddress(): string {
  const listed = run("k3d", ["registry", "list", "-o", "json"]);
  const registries = JSON.parse(listed) as Array<{
    name: string;
    portMappings?: unknown;
  }>;
  const match = registries.find((r) => r.name.includes(SUBSTRATE_REGISTRY_NAME));
  if (!match) {
    throw new Error(
      `${LOCAL_WORLD_LABEL}: substrate registry ${SUBSTRATE_REGISTRY_NAME} not found after convergence`,
    );
  }
  return `${match.name}:${SUBSTRATE_REGISTRY_HOST_PORT}`;
}

function readKubeconfig(): { kubeconfig: string; apiServerUrl: string } {
  const kubeconfig = run("k3d", ["kubeconfig", "get", SUBSTRATE_CLUSTER_NAME]);
  const serverLine = kubeconfig
    .split("\n")
    .find((line) => line.trim().startsWith("server:"));
  if (!serverLine) {
    throw new Error(
      `${LOCAL_WORLD_LABEL}: substrate kubeconfig carries no API server address`,
    );
  }
  return { kubeconfig, apiServerUrl: serverLine.trim().slice("server:".length).trim() };
}

// Idempotent by construction: every step is check-then-act, and nothing here is
// a tracked deployment resource — teardown of any branch can never reach the
// substrate through this module.
export async function ensureSubstrate(): Promise<SubstrateHandle> {
  ensureDockerDaemon();
  ensureCluster();
  const { kubeconfig, apiServerUrl } = readKubeconfig();
  return {
    kubeconfig,
    apiServerUrl,
    registryPushAddress: REGISTRY_PUSH_ADDRESS,
    registryClusterAddress: registryClusterAddress(),
  };
}
