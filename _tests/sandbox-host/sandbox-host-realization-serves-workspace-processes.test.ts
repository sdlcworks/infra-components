import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { loadSandboxHost } from "./load-sandbox-host";

const SANDBOX = "sbx-sandbox-host-test";
const SERVE = `exec bun -e "Bun.serve({ hostname: '127.0.0.1', port: Number(process.env.PORT), fetch: () => new Response(process.env.SDLC_WORKSPACE_ROOT) })"`;
const RUNTIME_PATH = (process.env.PATH ?? "").split(":").filter((entry) => entry.startsWith("/")).join(":");
const SLOW = 40_000;
const created: string[] = [];
let sequence = 0;

function componentName(): string {
  const name = `web-${process.pid}-${sequence++}`;
  created.push(name);
  return name;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(typeof address === "object" && address ? address.port : 0));
    });
  });
}

function workspace(component: string, sandbox = SANDBOX): { root: string; binding: string } {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sandbox-host-ws-")));
  fs.writeFileSync(path.join(root, "sdlc.toml"), "");
  const binding = path.join(root, `${component}.sandbox.json`);
  fs.writeFileSync(binding, JSON.stringify({ protocol: "sdlc-sandbox-binding", workspace_root: root, component, sandbox_id: sandbox, runtime_path: RUNTIME_PATH }));
  return { root, binding };
}

function deployCtx(component: string, uri: string, port: number | undefined, release: string, command = SERVE) {
  return {
    buildArtifacts: { [component]: { artifact: { uri, type: "file" } } },
    state: { ingress_domain: "e2b.app" },
    envStore: { [component]: {} },
    getCredentials: () => ({}),
    servingPorts: port === undefined ? {} : { [component]: port },
    releaseIdentities: { [component]: release },
    deploymentConfigs: { [component]: { command } },
    currentOutputs: {},
  } as any;
}

async function custodyPid(component: string): Promise<number> {
  const { PROCESS_CUSTODY_ROOT } = await loadSandboxHost();
  return Number(fs.readFileSync(path.join(PROCESS_CUSTODY_ROOT, component, "pid"), "utf8"));
}

function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

beforeEach(() => {
  process.env.E2B_SANDBOX_ID = SANDBOX;
});

afterEach(async () => {
  const { PROCESS_CUSTODY_ROOT } = await loadSandboxHost();
  for (const component of created.splice(0)) {
    const dir = path.join(PROCESS_CUSTODY_ROOT, component);
    try {
      process.kill(-Number(fs.readFileSync(path.join(dir, "pid"), "utf8")), "SIGKILL");
    } catch {}
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("sandbox-host declaration", () => {
  test("registers the e2b-local realization in the enactor-resident world", async () => {
    const { default: host } = await loadSandboxHost();
    expect(host.providers["e2b-local"]?.world).toBe("enactor-resident");
    const accepted: string[] = host.opts.acceptedArtifactTypes ?? [];
    expect(accepted).toEqual(["file"]);
    const bundle = host.getPortableSchemas();
    expect(Object.keys(bundle.schemas.deployment_inputs)).toEqual(["default"]);
    expect(bundle.schemas.config.properties).toHaveProperty("ingress_domain");
    expect(bundle.schemas.output.properties).toHaveProperty("realized_serving_endpoints");
    expect(bundle.connection_types).toEqual({});
  });
});

describe("sandbox-host realization", () => {
  test("serves the released workspace process and records its sandbox endpoint", async () => {
    const { default: host } = await loadSandboxHost();
    const component = componentName();
    const port = await freePort();
    const { root, binding } = workspace(component);
    const outputs = await host.providers["e2b-local"]!.upsertArtifacts!(deployCtx(component, `file://${binding}`, port, "r1"));
    expect((outputs as any).realized_serving_endpoints[component]).toEqual({
      release_identity: "r1",
      environment_identity: SANDBOX,
      port,
      endpoint: `https://${port}-${SANDBOX}.e2b.app`,
    });
    expect(await (await fetch(`http://127.0.0.1:${port}`)).text()).toBe(root);
  }, SLOW);

  test("keeps a current process and replaces it on a new release", async () => {
    const { default: host } = await loadSandboxHost();
    const component = componentName();
    const port = await freePort();
    const { binding } = workspace(component);
    const deploy = host.providers["e2b-local"]!.upsertArtifacts!;
    await deploy(deployCtx(component, `file://${binding}`, port, "r1"));
    const first = await custodyPid(component);
    await deploy(deployCtx(component, `file://${binding}`, port, "r1"));
    expect(await custodyPid(component)).toBe(first);
    await deploy(deployCtx(component, `file://${binding}`, port, "r2"));
    const second = await custodyPid(component);
    expect(second).not.toBe(first);
    expect(groupAlive(first)).toBe(false);
  }, SLOW);

  test("retires a surviving group member when the recorded leader has died", async () => {
    const { default: host } = await loadSandboxHost();
    const component = componentName();
    const port = await freePort();
    const { binding } = workspace(component);
    const deploy = host.providers["e2b-local"]!.upsertArtifacts!;
    await deploy(deployCtx(component, `file://${binding}`, port, "r1"));
    const leader = await custodyPid(component);
    process.kill(leader, "SIGKILL");
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(groupAlive(leader)).toBe(true);
    await deploy(deployCtx(component, `file://${binding}`, port, "r2"));
    expect(groupAlive(leader)).toBe(false);
    expect(await custodyPid(component)).not.toBe(leader);
  }, SLOW);

  test("refuses a binding minted in another sandbox", async () => {
    const { default: host } = await loadSandboxHost();
    const component = componentName();
    const { binding } = workspace(component, "another-sandbox");
    await expect(host.providers["e2b-local"]!.upsertArtifacts!(deployCtx(component, `file://${binding}`, await freePort(), "r1"))).rejects.toThrow("sandbox-host-binding-invalid");
  });

  test("refuses a component without a declared serving port", async () => {
    const { default: host } = await loadSandboxHost();
    const component = componentName();
    const { binding } = workspace(component);
    await expect(host.providers["e2b-local"]!.upsertArtifacts!(deployCtx(component, `file://${binding}`, undefined, "r1"))).rejects.toThrow("sandbox-host-serving-port-undeclared");
  });

  test("refuses an artifact this sandbox cannot open", async () => {
    const { default: host } = await loadSandboxHost();
    const component = componentName();
    await expect(host.providers["e2b-local"]!.upsertArtifacts!(deployCtx(component, "s3://bucket/key.json", await freePort(), "r1"))).rejects.toThrow("sandbox-host-artifact-not-local");
  });

  test("marks a launch served only once it is witnessed listening, and starts every new launch unserved", async () => {
    const { default: host, PROCESS_CUSTODY_ROOT, SERVED_FILE } = await loadSandboxHost();
    const component = componentName();
    const port = await freePort();
    const { binding } = workspace(component);
    const deploy = host.providers["e2b-local"]!.upsertArtifacts!;
    const served = path.join(PROCESS_CUSTODY_ROOT, component, SERVED_FILE);
    await deploy(deployCtx(component, `file://${binding}`, port, "r1"));
    expect(fs.existsSync(served)).toBe(true);
    await expect(deploy(deployCtx(component, `file://${binding}`, port, "r2", "echo never-listens; exit 3"))).rejects.toThrow("sandbox-host-startup-failed");
    expect(fs.existsSync(served)).toBe(false);
  }, SLOW);

  test("names a command that exhausts its restarts without listening", async () => {
    const { default: host } = await loadSandboxHost();
    const component = componentName();
    const { binding } = workspace(component);
    await expect(host.providers["e2b-local"]!.upsertArtifacts!(deployCtx(component, `file://${binding}`, await freePort(), "r1", "echo never-listens; exit 3"))).rejects.toThrow("sandbox-host-startup-failed");
  }, SLOW);

  test("refuses to converge outside a sandbox", async () => {
    const { default: host } = await loadSandboxHost();
    delete process.env.E2B_SANDBOX_ID;
    await expect(host.providers["e2b-local"]!.pulumi({ inputs: { ingress_domain: "e2b.app" }, state: {} } as any)).rejects.toThrow("sandbox-host-world-not-sandbox");
  });
});
