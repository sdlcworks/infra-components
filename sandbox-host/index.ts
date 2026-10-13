import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { z } from "zod";
import * as pulumi from "@pulumi/pulumi";
import { DeploymentArtifactType, InfraComponent, defaultAppComponentType } from "@sdlcworks/components";

export const SANDBOX_REALIZATION = "e2b-local";
export const DEFAULT_INGRESS_DOMAIN = "e2b.app";
export const BINDING_PROTOCOL = "sdlc-sandbox-binding";
export const REALIZED_SERVING_ENDPOINTS = "realized_serving_endpoints";
export const PROCESS_CUSTODY_ROOT = path.join(os.tmpdir(), "sdlc-sandbox-host");
export const STARTUP_DEADLINE_MS = 180_000;
export const RESTART_BUDGET = 5;

export interface RestartPolicy {
  budget: number;
  healthySeconds: number;
  backoffSeconds: number;
  backoffCeilingSeconds: number;
}

export const RESTART_POLICY: RestartPolicy = {
  budget: RESTART_BUDGET,
  healthySeconds: 30,
  backoffSeconds: 2,
  backoffCeilingSeconds: 60,
};

export const Refusal = {
  worldNotSandbox: "sandbox-host-world-not-sandbox",
  servingPortUndeclared: "sandbox-host-serving-port-undeclared",
  releaseIdentityAbsent: "sandbox-host-release-identity-absent",
  artifactNotLocal: "sandbox-host-artifact-not-local",
  bindingInvalid: "sandbox-host-binding-invalid",
  portOccupied: "sandbox-host-port-occupied",
  startupFailed: "sandbox-host-startup-failed",
  startupTimeout: "sandbox-host-startup-timeout",
  retirementUnproven: "sandbox-host-retirement-unproven",
} as const;

const RETIREMENT_GRACE_MS = 15_000;
const RETIREMENT_KILL_MS = 3_000;
const PROBE_INTERVAL_MS = 100;
const PROBE_TIMEOUT_MS = 250;
const GROUP_POLL_MS = 25;
const LOG_TAIL_BYTES = 4096;
const LOOPBACK = "127.0.0.1";
const SHELL = "/bin/sh";
const FILE_URI_SCHEME = "file://";
const WORKSPACE_DECLARATION = "sdlc.toml";
const ENV_SANDBOX_ID = "E2B_SANDBOX_ID";
const ENV_PORT = "PORT";
const ENV_WORKSPACE_ROOT = "SDLC_WORKSPACE_ROOT";
const ENV_STATE_DIR = "SDLC_COMPONENT_STATE_DIR";
const PID_FILE = "pid";
const LAUNCH_FILE = "launch";
const RECORD_FILE = "record.json";
const LOG_FILE = "process.log";
const STATE_DIR = "data";
const INHERITED_ENVIRONMENT = [
  "HOME", "TMPDIR", "LANG", "LC_ALL", "TZ",
  "SSL_CERT_FILE", "SSL_CERT_DIR", "NIX_SSL_CERT_FILE",
  "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME",
] as const;

const IngressDomainSchema = z.string().min(1);
const DeploymentSchema = z.object({ command: z.string().min(1) });
const ServingRecordSchema = z.object({
  release_identity: z.string().min(1),
  environment_identity: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  endpoint: z.string().url(),
});
const RealizedServingEndpointsSchema = z.record(z.string(), ServingRecordSchema);
const BindingSchema = z.object({
  protocol: z.literal(BINDING_PROTOCOL),
  workspace_root: z.string().min(1),
  component: z.string().min(1),
  sandbox_id: z.string().min(1),
  runtime_path: z.string().min(1).refine((value) => !/[\x00-\x1f\x7f]/.test(value) && value.split(":").every((entry) => entry.startsWith("/"))),
}).strict();

type ServingRecord = z.infer<typeof ServingRecordSchema>;
type Binding = z.infer<typeof BindingSchema>;

export function sandboxId(): string {
  const id = process.env[ENV_SANDBOX_ID];
  if (!id) throw new Error(`${Refusal.worldNotSandbox}: ${ENV_SANDBOX_ID} is unset`);
  return id;
}

export function servingEndpoint(port: number, sandbox: string, ingressDomain: string): string {
  return `https://${port}-${sandbox}.${ingressDomain}`;
}

export function restartScript(command: string, policy: RestartPolicy = RESTART_POLICY): string {
  return [
    `attempt=0; proven=0; delay=${policy.backoffSeconds}`,
    `while [ "$proven" -eq 1 ] || [ "$attempt" -lt ${policy.budget} ]; do`,
    `began=$(date +%s)`,
    `( ${command} )`,
    `if [ $(( $(date +%s) - began )) -ge ${policy.healthySeconds} ]; then proven=1; attempt=0; delay=${policy.backoffSeconds}; else attempt=$((attempt + 1)); fi`,
    `sleep "$delay"`,
    `if [ "$proven" -eq 1 ] && [ "$attempt" -gt 0 ]; then delay=$((delay * 2)); if [ "$delay" -gt ${policy.backoffCeilingSeconds} ]; then delay=${policy.backoffCeilingSeconds}; fi; fi`,
    `done`,
  ].join("\n");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function custodyDir(component: string): string {
  return path.join(PROCESS_CUSTODY_ROOT, component);
}

function readCustody(component: string, file: string): string {
  try {
    return fs.readFileSync(path.join(custodyDir(component), file), "utf8").trim();
  } catch {
    return "";
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function listening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: LOOPBACK, port });
    let settled = false;
    const finish = (ready: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ready);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(PROBE_TIMEOUT_MS, () => finish(false));
  });
}

async function groupGone(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      process.kill(-pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
    }
    if (Date.now() >= deadline) return false;
    await sleep(GROUP_POLL_MS);
  }
}

async function retire(pid: number): Promise<void> {
  for (const [signal, timeoutMs] of [["SIGTERM", RETIREMENT_GRACE_MS], ["SIGKILL", RETIREMENT_KILL_MS]] as const) {
    try {
      process.kill(-pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
      throw new Error(`${Refusal.retirementUnproven}: ${pid}`);
    }
    if (await groupGone(pid, timeoutMs)) return;
  }
  throw new Error(`${Refusal.retirementUnproven}: ${pid}`);
}

function readBinding(component: string, uri: string, sandbox: string): Binding {
  if (!uri.startsWith(FILE_URI_SCHEME)) throw new Error(`${Refusal.artifactNotLocal}: ${component}: ${uri}`);
  try {
    const binding = BindingSchema.parse(JSON.parse(fs.readFileSync(uri.slice(FILE_URI_SCHEME.length), "utf8")));
    const root = binding.workspace_root;
    if (
      binding.component !== component || binding.sandbox_id !== sandbox ||
      !path.isAbsolute(root) || fs.realpathSync(root) !== root ||
      !fs.statSync(path.join(root, WORKSPACE_DECLARATION)).isFile()
    ) throw new Error(Refusal.bindingInvalid);
    return binding;
  } catch {
    throw new Error(`${Refusal.bindingInvalid}: ${component}`);
  }
}

function inheritedEnvironment(): Record<string, string> {
  const inherited: Record<string, string> = {};
  for (const key of INHERITED_ENVIRONMENT) {
    const value = process.env[key];
    if (value !== undefined) inherited[key] = value;
  }
  return inherited;
}

function launchIdentity(releaseIdentity: string, command: string, environment: Record<string, string>): string {
  const entries = Object.entries(environment).sort(([a], [b]) => a.localeCompare(b));
  return createHash("sha256").update(JSON.stringify([releaseIdentity, command, entries])).digest("hex");
}

function logTail(component: string): string {
  try {
    const file = path.join(custodyDir(component), LOG_FILE);
    const size = fs.statSync(file).size;
    const length = Math.min(size, LOG_TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    const fd = fs.openSync(file, "r");
    try {
      fs.readSync(fd, buffer, 0, length, size - length);
    } finally {
      fs.closeSync(fd);
    }
    return buffer.toString("utf8");
  } catch {
    return "";
  }
}

function launch(component: string, command: string, environment: Record<string, string>, cwd: string): number {
  const log = fs.openSync(path.join(custodyDir(component), LOG_FILE), "w");
  try {
    const child = spawn(SHELL, ["-c", restartScript(command)], { cwd, env: environment, detached: true, stdio: ["ignore", log, log] });
    child.once("error", () => {});
    if (child.pid === undefined) throw new Error(`${Refusal.startupFailed}: ${component}`);
    child.unref();
    return child.pid;
  } finally {
    fs.closeSync(log);
  }
}

async function awaitStartup(component: string, pid: number, port: number): Promise<void> {
  const deadline = Date.now() + STARTUP_DEADLINE_MS;
  while (true) {
    if (!alive(pid)) throw new Error(`${Refusal.startupFailed}: ${component}\n${logTail(component)}`);
    if (await listening(port)) return;
    if (Date.now() >= deadline) throw new Error(`${Refusal.startupTimeout}: ${component}\n${logTail(component)}`);
    await sleep(PROBE_INTERVAL_MS);
  }
}

async function realize(input: {
  component: string;
  uri: string;
  port: number;
  releaseIdentity: string;
  command: string;
  env: Record<string, string>;
  sandbox: string;
  ingressDomain: string;
}): Promise<void> {
  const { component, port, releaseIdentity, command, sandbox } = input;
  const binding = readBinding(component, input.uri, sandbox);
  const dir = custodyDir(component);
  fs.mkdirSync(path.join(dir, STATE_DIR), { recursive: true });
  const environment: Record<string, string> = {
    ...inheritedEnvironment(),
    ...input.env,
    [ENV_WORKSPACE_ROOT]: binding.workspace_root,
    PATH: binding.runtime_path,
    [ENV_STATE_DIR]: path.join(dir, STATE_DIR),
    [ENV_PORT]: String(port),
  };
  const identity = launchIdentity(releaseIdentity, command, environment);
  const predecessor = Number(readCustody(component, PID_FILE));
  const recorded = Number.isInteger(predecessor) && predecessor > 0;
  const standing = recorded && alive(predecessor);
  if (!standing || readCustody(component, LAUNCH_FILE) !== identity) {
    if (recorded) await retire(predecessor);
    fs.rmSync(path.join(dir, RECORD_FILE), { force: true });
    if (await listening(port)) throw new Error(`${Refusal.portOccupied}: ${component}: ${port}`);
    const pid = launch(component, command, environment, binding.workspace_root);
    fs.writeFileSync(path.join(dir, PID_FILE), String(pid));
    fs.writeFileSync(path.join(dir, LAUNCH_FILE), identity);
  }
  await awaitStartup(component, Number(readCustody(component, PID_FILE)), port);
  const record: ServingRecord = {
    release_identity: releaseIdentity,
    environment_identity: sandbox,
    port,
    endpoint: servingEndpoint(port, sandbox, input.ingressDomain),
  };
  fs.writeFileSync(path.join(dir, RECORD_FILE), JSON.stringify(record));
}

async function witnessed(sandbox: string): Promise<Record<string, ServingRecord>> {
  const out: Record<string, ServingRecord> = {};
  let components: string[];
  try {
    components = fs.readdirSync(PROCESS_CUSTODY_ROOT).sort();
  } catch {
    return out;
  }
  for (const component of components) {
    try {
      const pid = Number(readCustody(component, PID_FILE));
      const record = ServingRecordSchema.parse(JSON.parse(fs.readFileSync(path.join(custodyDir(component), RECORD_FILE), "utf8")));
      if (record.environment_identity === sandbox && pid > 0 && alive(pid) && (await listening(record.port))) out[component] = record;
    } catch {
      continue;
    }
  }
  return out;
}

const component = new InfraComponent({
  metadata: { stateful: true, proxiable: false },
  acceptedArtifactTypes: [DeploymentArtifactType.file],
  connectionTypes: {},
  configSchema: z.object({ ingress_domain: IngressDomainSchema.default(DEFAULT_INGRESS_DOMAIN) }),
  appComponentTypes: defaultAppComponentType(DeploymentSchema),
  outputSchema: z.object({ [REALIZED_SERVING_ENDPOINTS]: RealizedServingEndpointsSchema }),
});

component.implement(SANDBOX_REALIZATION, {
  world: "enactor-resident",
  stateSchema: z.object({ ingress_domain: IngressDomainSchema }),
  initialState: { ingress_domain: DEFAULT_INGRESS_DOMAIN },

  pulumi: async ({ inputs, state }) => {
    const sandbox = sandboxId();
    state.ingress_domain = IngressDomainSchema.parse(inputs.ingress_domain);
    return { [REALIZED_SERVING_ENDPOINTS]: pulumi.output(await witnessed(sandbox)) };
  },

  upsertArtifacts: async ({ buildArtifacts, state, envStore, servingPorts, releaseIdentities, deploymentConfigs }) => {
    const sandbox = sandboxId();
    const ingressDomain = IngressDomainSchema.parse(state.ingress_domain);
    const outcomes = await Promise.allSettled(
      Object.entries(buildArtifacts).map(async ([name, info]) => {
        const port = servingPorts[name];
        if (port === undefined) throw new Error(`${Refusal.servingPortUndeclared}: ${name}`);
        const releaseIdentity = releaseIdentities[name];
        if (!releaseIdentity) throw new Error(`${Refusal.releaseIdentityAbsent}: ${name}`);
        const { command } = DeploymentSchema.parse(deploymentConfigs[name] ?? {});
        await realize({ component: name, uri: info.artifact.uri, port, releaseIdentity, command, env: envStore[name] ?? {}, sandbox, ingressDomain });
      }),
    );
    const failures = outcomes.flatMap((outcome) =>
      outcome.status === "rejected" ? [outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason)] : [],
    );
    if (failures.length > 0) throw new Error(failures.join("\n"));
    return { [REALIZED_SERVING_ENDPOINTS]: await witnessed(sandbox) };
  },
});

export default component;
