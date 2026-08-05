import { execFileSync } from "node:child_process";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

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

const READINESS_DEADLINE_MS = 60_000;
const READINESS_POLL_INTERVAL_MS = 2_000;
const READINESS_PROBE_TIMEOUT_MS = 3_000;

function probeUrl(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    const parsed = new URL(url);
    const transport = parsed.protocol === "https:" ? httpsRequest : httpRequest;
    const req = transport(
      {
        host: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname,
        timeout: READINESS_PROBE_TIMEOUT_MS,
        // Substrate identity is machine possession; the API server's cert is
        // self-signed and readiness only demands an answer, not a verdict.
        rejectUnauthorized: false,
      },
      (res) => {
        res.resume();
        resolve((res.statusCode ?? 500) < 500);
      },
    );
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(false));
    req.end();
  });
}

async function substrateReady(apiServerUrl: string): Promise<boolean> {
  const apiAnswers = await probeUrl(`${apiServerUrl}/readyz`);
  if (!apiAnswers) return false;
  return probeUrl(`http://${REGISTRY_PUSH_ADDRESS}/v2/`);
}

function reviveSubstrate(): void {
  tryRun("k3d", ["cluster", "start", SUBSTRATE_CLUSTER_NAME]);
  const registries = tryRun("k3d", ["registry", "list", "-o", "json"]);
  if (registries !== undefined) {
    const match = (JSON.parse(registries) as Array<{ name: string }>).find(
      (r) => r.name.includes(SUBSTRATE_REGISTRY_NAME),
    );
    if (match) tryRun("docker", ["start", match.name]);
  }
}

async function awaitReadiness(apiServerUrl: string): Promise<boolean> {
  const deadline = Date.now() + READINESS_DEADLINE_MS;
  while (Date.now() < deadline) {
    if (await substrateReady(apiServerUrl)) return true;
    await new Promise((resolve) =>
      setTimeout(resolve, READINESS_POLL_INTERVAL_MS),
    );
  }
  return false;
}

// Idempotent by construction: every step is check-then-act, and nothing here is
// a tracked deployment resource — teardown of any branch can never reach the
// substrate through this module. Standing means demonstrated readiness to
// host, never inventory membership: an inventoried-but-unanswering substrate
// is revived by non-destructive acts alone, and only their failure refuses.
export async function ensureSubstrate(): Promise<SubstrateHandle> {
  ensureDockerDaemon();
  ensureCluster();
  let { kubeconfig, apiServerUrl } = readKubeconfig();
  if (!(await substrateReady(apiServerUrl))) {
    reviveSubstrate();
    ({ kubeconfig, apiServerUrl } = readKubeconfig());
    if (!(await awaitReadiness(apiServerUrl))) {
      throw new Error(
        `${LOCAL_WORLD_LABEL}: substrate ${SUBSTRATE_CLUSTER_NAME} stands in the runtime inventory but did not answer after non-destructive revival; restoring or destroying the substrate is a deliberate act outside any branch's lifecycle`,
      );
    }
  }
  return {
    kubeconfig,
    apiServerUrl,
    registryPushAddress: REGISTRY_PUSH_ADDRESS,
    registryClusterAddress: registryClusterAddress(),
  };
}
