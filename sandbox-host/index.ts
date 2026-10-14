import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
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
  sessionInvalid: "sandbox-host-session-invalid",
  readinessUnavailable: "sandbox-host-readiness-unavailable",
  custodyBusy: "sandbox-host-custody-busy",
  custodyInvalid: "sandbox-host-custody-invalid",
  retirementUnproven: "sandbox-host-retirement-unproven",
} as const;

const RETIREMENT_GRACE_MS = 15_000;
const RETIREMENT_KILL_MS = 3_000;
const PROBE_INTERVAL_MS = 100;
const PROBE_TIMEOUT_MS = 250;
const GROUP_POLL_MS = 25;
const LOG_TAIL_BYTES = 4096;
const LISTENER_QUERY_MS = 1000;
const LISTENER_QUERY_BYTES = 65_536;
const LISTENER_TOOL = ["/usr/sbin/lsof", "/usr/bin/lsof", "/sbin/lsof", "/bin/lsof"].find((file) => fs.existsSync(file));
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
export const SERVED_FILE = "served";
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
const SafeIdentifierSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/);
const GenerationSchema = z.string().regex(/^[1-9][0-9]{0,19}$/).refine((value) => BigInt(value) <= BigInt("18446744073709551615"));
const BindingBase = {
  protocol: z.literal(BINDING_PROTOCOL),
  workspace_root: z.string().min(1),
  component: z.string().regex(/^[a-z][a-z0-9-]*$/),
  runtime_path: z.string().min(1).refine((value) => !/[\x00-\x1f\x7f]/.test(value) && value.split(":").every((entry) => entry.startsWith("/"))),
};
const MachineIdentitySchema = z.object({
  machine_id: SafeIdentifierSchema,
  session_id: SafeIdentifierSchema,
  workspace_id: SafeIdentifierSchema,
  generation: GenerationSchema,
  workspace_root: z.string().min(1),
}).strict();
const BindingSchema = z.union([
  z.object({ ...BindingBase, sandbox_id: z.string().min(1) }).strict(),
  z.object({ ...BindingBase, ...MachineIdentitySchema.shape, environment: z.literal("machine") }).strict(),
]);
type ServingRecord = z.infer<typeof ServingRecordSchema>;
type Binding = z.infer<typeof BindingSchema>;
type MachineIdentity = z.infer<typeof MachineIdentitySchema>;
type Session = MachineIdentity & { protocol: string; revision: string; state: string; valid_until: string };
type Context = { kind: "hosted"; identity: string; root: string } | {
  kind: "machine"; identity: string; root: string; sessionRoot: string; tuple: MachineIdentity; file: string; session: Session;
};
const SESSION_ENV = {
  machine_id: "SDLC_WORKSPACE_MACHINE_ID",
  session_id: "SDLC_WORKSPACE_SESSION_ID",
  workspace_id: "SDLC_WORKSPACE_ID",
  generation: "SDLC_WORKSPACE_GENERATION",
  workspace_root: ENV_WORKSPACE_ROOT,
} as const;
const SESSION_FILE_ENV = "SDLC_WORKSPACE_SESSION_FILE";
const TUPLE_FILE = "environment.json";
const CONTROL_FILE = "control.json";
const CONTROL_TIMEOUT_MS = 1500;

function readSession(file: string, expected: MachineIdentity, custody: string, fs: typeof import("node:fs"), path: typeof import("node:path")): Session {
  const invalid = () => { throw new Error("sandbox-host-session-invalid"); };
  const privateRead = (location: string) => {
    if (!path.isAbsolute(location) || fs.realpathSync(location) !== location) return invalid();
    const parent = fs.lstatSync(path.dirname(location));
    if (!parent.isDirectory() || parent.uid !== process.getuid!() || (parent.mode & 0o077) !== 0) return invalid();
    const fd = fs.openSync(location, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.uid !== process.getuid!() || (stat.mode & 0o077) !== 0 || stat.size > 8192) return invalid();
      return JSON.parse(fs.readFileSync(fd, "utf8"));
    } finally { fs.closeSync(fd); }
  };
  const validate = (value: Session): Session => {
    const keys = ["protocol", "machine_id", "session_id", "workspace_id", "generation", "workspace_root", "revision", "state", "valid_until"].sort();
    if (!value || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(keys)) return invalid();
    for (const key of ["machine_id", "session_id", "workspace_id", "generation", "workspace_root"] as const) {
      if (value[key] !== expected[key]) return invalid();
    }
    if (value.protocol !== "sdlc-workspace-session" || !["ready", "closed"].includes(value.state) ||
        typeof value.revision !== "string" || !/^[1-9][0-9]{0,19}$/.test(value.revision) || BigInt(value.revision) > BigInt("18446744073709551615") ||
        typeof value.valid_until !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(value.valid_until) || !Number.isFinite(Date.parse(value.valid_until))) return invalid();
    if (new Date(Date.parse(value.valid_until)).toISOString().slice(0, 19) !== value.valid_until.slice(0, 19)) return invalid();
    return Object.fromEntries(keys.map((key) => [key, value[key as keyof Session]])) as Session;
  };
  validate(privateRead(file));
  for (const directory of [path.dirname(path.dirname(custody)), path.dirname(custody), custody]) {
    try { fs.mkdirSync(directory, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid!() || (stat.mode & (directory === path.dirname(path.dirname(custody)) ? 0o022 : 0o077)) !== 0) return invalid();
  }
  const lock = path.join(custody, "session.lock");
  const deadline = Date.now() + 500;
  while (true) {
    try { fs.closeSync(fs.openSync(lock, "wx", 0o600)); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || Date.now() >= deadline) return invalid();
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  try {
    const value = validate(privateRead(file));
    const retained = path.join(custody, "session.json");
    let previous: { record: Session; terminal: string | null } | undefined;
    if (fs.existsSync(retained)) {
      previous = privateRead(retained);
      if (!previous || Object.keys(previous).sort().join(",") !== "record,terminal" || ![null, "closed", "expired"].includes(previous.terminal)) return invalid();
      validate(previous.record);
      if (previous.terminal || BigInt(value.revision) < BigInt(previous.record.revision)) return invalid();
      if (value.revision === previous.record.revision && JSON.stringify(value) !== JSON.stringify(previous.record)) return invalid();
    }
    const terminal = value.state === "closed" ? "closed" : Date.parse(value.valid_until) <= Date.now() ? "expired" : null;
    if (!previous || previous.record.revision !== value.revision || terminal) {
      const next = retained + ".next";
      fs.writeFileSync(next, JSON.stringify({ record: value, terminal }), { mode: 0o600, flag: "wx" });
      fs.renameSync(next, retained);
    }
    if (terminal) return invalid();
    return value;
  } finally { fs.unlinkSync(lock); }
}

function checkContext(context: Context): void {
  if (context.kind === "machine") {
    try {
      context.session = readSession(context.file, context.tuple, context.sessionRoot, fs, path);
    } catch { throw new Error(Refusal.sessionInvalid); }
  }
}

function currentContext(): Context {
  const sandbox = process.env[ENV_SANDBOX_ID];
  const managed = [SESSION_FILE_ENV, ...Object.values(SESSION_ENV).filter((key) => key !== ENV_WORKSPACE_ROOT)].some((key) => process.env[key] !== undefined);
  if (sandbox && !managed) return { kind: "hosted", identity: sandbox, root: PROCESS_CUSTODY_ROOT };
  if (!managed) throw new Error(Refusal.worldNotSandbox);
  try {
    if (sandbox) throw new Error(Refusal.sessionInvalid);
    const tuple = MachineIdentitySchema.parse(Object.fromEntries(Object.entries(SESSION_ENV).map(([key, variable]) => [key, process.env[variable]])));
    if (!path.isAbsolute(tuple.workspace_root) || fs.realpathSync(tuple.workspace_root) !== tuple.workspace_root || !fs.statSync(path.join(tuple.workspace_root, WORKSPACE_DECLARATION)).isFile()) throw new Error(Refusal.sessionInvalid);
    const file = process.env[SESSION_FILE_ENV]!;
    if (file === tuple.workspace_root || file.startsWith(tuple.workspace_root + path.sep)) throw new Error(Refusal.sessionInvalid);
    const digest = createHash("sha256").update(JSON.stringify(["sdlc-machine", tuple.machine_id, tuple.session_id, tuple.workspace_id, tuple.generation, tuple.workspace_root])).digest("hex");
    const identity = `machine:${digest}`;
    const root = path.join(fs.realpathSync(os.tmpdir()), path.basename(PROCESS_CUSTODY_ROOT), "machine", digest);
    const sessionDigest = createHash("sha256").update(JSON.stringify(["sdlc-machine-session", tuple.machine_id, tuple.session_id])).digest("hex");
    const sessionRoot = path.join(fs.realpathSync(os.tmpdir()), path.basename(PROCESS_CUSTODY_ROOT), "machine-sessions", sessionDigest);
    const session = readSession(file, tuple, sessionRoot, fs, path);
    return { kind: "machine", identity, tuple, file, session, root, sessionRoot };
  } catch { throw new Error(Refusal.sessionInvalid); }
}

function safeDirectory(directory: string, create: boolean): void {
  if (!fs.existsSync(directory) && create) fs.mkdirSync(directory, { mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid!() || (stat.mode & 0o022) !== 0) throw new Error(Refusal.custodyInvalid);
}

function machineCustody(context: Context, component: string, create: boolean): string {
  const dir = path.join(context.root, component);
  if (context.kind === "machine") {
    for (const directory of [PROCESS_CUSTODY_ROOT, path.join(PROCESS_CUSTODY_ROOT, "machine"), context.root, dir]) safeDirectory(directory, create);
    const file = path.join(dir, TUPLE_FILE);
    const tuple = JSON.stringify(context.tuple);
    if (!fs.existsSync(file) && create) fs.writeFileSync(file, tuple, { flag: "wx", mode: 0o600 });
    if (!fs.lstatSync(file).isFile() || fs.lstatSync(file).isSymbolicLink() || fs.readFileSync(file, "utf8") !== tuple) throw new Error(Refusal.custodyInvalid);
    for (const entry of fs.readdirSync(dir)) {
      const stat = fs.lstatSync(path.join(dir, entry));
      if (stat.isSymbolicLink() || stat.uid !== process.getuid!()) throw new Error(Refusal.custodyInvalid);
    }
  }
  return dir;
}

export function sandboxId(): string {
  const id = process.env[ENV_SANDBOX_ID];
  if (!id) throw new Error(`${Refusal.worldNotSandbox}: ${ENV_SANDBOX_ID} is unset`);
  return id;
}

export function servingEndpoint(port: number, sandbox: string, ingressDomain: string): string {
  return `https://${port}-${sandbox}.${ingressDomain}`;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function restartScript(command: string, servedMarker: string, policy: RestartPolicy = RESTART_POLICY): string {
  const served = `[ -e ${shellQuote(servedMarker)} ]`;
  return [
    `attempt=0; delay=${policy.backoffSeconds}`,
    `while ${served} || [ "$attempt" -lt ${policy.budget} ]; do`,
    `began=$(date +%s)`,
    `( ${command} )`,
    `if [ $(( $(date +%s) - began )) -ge ${policy.healthySeconds} ]; then delay=${policy.backoffSeconds}; fi`,
    `if ! ${served}; then attempt=$((attempt + 1)); fi`,
    `sleep "$delay"`,
    `if ${served}; then delay=$((delay * 2)); if [ "$delay" -gt ${policy.backoffCeilingSeconds} ]; then delay=${policy.backoffCeilingSeconds}; fi; fi`,
    `done`,
  ].join("\n");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readCustody(dir: string, file: string): string {
  try {
    return fs.readFileSync(path.join(dir, file), "utf8").trim();
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

export type ListenerOwnership = "owned" | "foreign" | "unavailable";

export function parseListenerOwnership(output: string, port: number, group: number): ListenerOwnership {
  if (!Number.isSafeInteger(group) || group <= 0 || output.length > LISTENER_QUERY_BYTES || !output.endsWith("\n")) return "unavailable";
  let pid = 0;
  let pgid = 0;
  let file = false;
  let named = false;
  let listeners = 0;
  let foreign = false;
  const seen = new Set<number>();
  for (const field of output.slice(0, -1).split("\n")) {
    const value = field.slice(1);
    if (field.startsWith("p")) {
      if (pid && (!file || !named)) return "unavailable";
      if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value)) || seen.has(Number(value))) return "unavailable";
      pid = Number(value); seen.add(pid); pgid = 0; file = false; named = false;
    } else if (field.startsWith("g")) {
      if (!pid || pgid || file || !/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value))) return "unavailable";
      pgid = Number(value);
    } else if (field.startsWith("f")) {
      if (!pid || !pgid || (file && !named) || !/^[0-9]+[a-z]*$/.test(value)) return "unavailable";
      file = true; named = false;
    } else if (field.startsWith("n")) {
      if (!file || named || !/^(?:\*|[0-9.]+|\[[0-9a-fA-F:.%]+\]):[0-9]+$/.test(value) || !value.endsWith(`:${port}`)) return "unavailable";
      named = true; listeners++; foreign ||= pgid !== group;
    } else return "unavailable";
  }
  if (!file || !named || !listeners) return "unavailable";
  return foreign ? "foreign" : "owned";
}

export async function listenerOwnership(port: number, group: number, executable: string | undefined = LISTENER_TOOL): Promise<ListenerOwnership> {
  if (!executable || !Number.isInteger(port) || port < 1 || port > 65535) return "unavailable";
  return new Promise((resolve) => {
    execFile(executable, ["-nP", "-a", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fpgfn"], {
      encoding: "utf8", timeout: LISTENER_QUERY_MS, maxBuffer: LISTENER_QUERY_BYTES, killSignal: "SIGKILL",
      env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LC_ALL: "C" },
    }, (error, stdout, stderr) => {
      resolve(error || stderr.length ? "unavailable" : parseListenerOwnership(stdout, port, group));
    });
  });
}

async function requireOwnedListener(port: number, pid: number, context: Context, dir: string): Promise<void> {
  if (context.kind !== "machine") return;
  await controlRequest(dir, pid, context, "challenge");
  const ownership = await listenerOwnership(port, pid);
  checkContext(context);
  if (ownership === "foreign") throw new Error(Refusal.portOccupied);
  if (ownership !== "owned" || !alive(pid)) throw new Error(Refusal.readinessUnavailable);
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
      if (await groupGone(pid, RETIREMENT_KILL_MS)) return;
      throw new Error(`${Refusal.retirementUnproven}: ${pid}`);
    }
    if (await groupGone(pid, timeoutMs)) return;
  }
  throw new Error(`${Refusal.retirementUnproven}: ${pid}`);
}

function readBinding(component: string, uri: string, context: Context): Binding {
  if (!uri.startsWith(FILE_URI_SCHEME)) throw new Error(`${Refusal.artifactNotLocal}: ${component}: ${uri}`);
  try {
    const binding = BindingSchema.parse(JSON.parse(fs.readFileSync(uri.slice(FILE_URI_SCHEME.length), "utf8")));
    const root = binding.workspace_root;
    if (
      binding.component !== component ||
      (context.kind === "hosted" ? !("sandbox_id" in binding) || binding.sandbox_id !== context.identity : !("environment" in binding) || Object.entries(context.tuple).some(([key, value]) => (binding as any)[key] !== value)) ||
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

function logTail(dir: string): string {
  try {
    const file = path.join(dir, LOG_FILE);
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

function privateJSON(file: string, fs: typeof import("node:fs"), path: typeof import("node:path")): any {
  const directory = path.dirname(file);
  const parent = fs.lstatSync(directory);
  if (!parent.isDirectory() || fs.realpathSync(directory) !== directory || parent.uid !== process.getuid!() || (parent.mode & 0o077) !== 0) throw new Error("sandbox-host-custody-invalid");
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.getuid!() || (stat.mode & 0o077) !== 0 || stat.size > 8192) throw new Error("sandbox-host-custody-invalid");
    return JSON.parse(fs.readFileSync(fd, "utf8"));
  } finally { fs.closeSync(fd); }
}

async function controlRequest(dir: string, pid: number, context: Extract<Context, { kind: "machine" }>, operation: "challenge" | "stop"): Promise<void> {
  const record = privateJSON(path.join(dir, CONTROL_FILE), fs, path);
  if (!record || Object.keys(record).sort().join(",") !== "control,identity,pid,tuple" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(record.control) ||
      record.pid !== pid || JSON.stringify(record.tuple) !== JSON.stringify(context.tuple) ||
      record.identity !== readCustody(dir, LAUNCH_FILE)) throw new Error(Refusal.custodyInvalid);
  const control = path.join(dir, record.control);
  safeDirectory(control, false);
  if ((fs.statSync(control).mode & 0o077) !== 0) throw new Error(Refusal.custodyInvalid);
  const nonce = randomUUID();
  const request = { operation, nonce, tuple: context.tuple, identity: record.identity, control: record.control };
  const requestFile = path.join(control, `request-${nonce}`);
  fs.writeFileSync(requestFile + ".next", JSON.stringify(request), { flag: "wx", mode: 0o600 });
  fs.renameSync(requestFile + ".next", requestFile);
  const responseFile = path.join(control, `response-${nonce}`);
  const deadline = Date.now() + CONTROL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (fs.existsSync(responseFile)) {
      const response = privateJSON(responseFile, fs, path);
      if (JSON.stringify(response) !== JSON.stringify({ ...request, pid })) throw new Error(Refusal.custodyInvalid);
      fs.unlinkSync(responseFile);
      return;
    }
    await sleep(GROUP_POLL_MS);
  }
  throw new Error(Refusal.readinessUnavailable);
}

async function retireMachine(dir: string, pid: number, context: Extract<Context, { kind: "machine" }>): Promise<void> {
  if (await groupGone(pid, 0)) return;
  try { await controlRequest(dir, pid, context, "stop"); }
  catch {
    if (await groupGone(pid, RETIREMENT_KILL_MS)) return;
    throw new Error(Refusal.retirementUnproven);
  }
  if (!(await groupGone(pid, RETIREMENT_GRACE_MS + RETIREMENT_KILL_MS))) throw new Error(Refusal.retirementUnproven);
}

function managedSupervisor(config: {
  file: string; tuple: MachineIdentity; root: string; command: string; marker: string; control: string; identity: string;
  policy: RestartPolicy; grace: number; interval: number;
}, readCurrent: typeof readSession, readPrivate: typeof privateJSON, load: NodeRequire): void {
  const fs = load("node:fs") as typeof import("node:fs");
  const path = load("node:path") as typeof import("node:path");
  const { spawn } = load("node:child_process") as typeof import("node:child_process");
  let closing = false;
  let attempt = 0;
  let delay = config.policy.backoffSeconds;
  const stop = () => {
    if (closing) return;
    closing = true;
    process.kill(-process.pid, "SIGTERM");
    setTimeout(() => process.kill(-process.pid, "SIGKILL"), config.grace);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  const admitted = () => {
    if (closing) return false;
    try { readCurrent(config.file, config.tuple, config.root, fs, path); return true; }
    catch { stop(); return false; }
  };
  const controls = () => {
    if (closing) return;
    try {
      const requests = fs.readdirSync(config.control).filter((name) => /^request-[0-9a-f-]{36}$/.test(name));
      if (requests.length > 64) { stop(); return; }
      for (const name of requests) {
        const file = path.join(config.control, name);
        const request = readPrivate(file, fs, path);
        if (!request || Object.keys(request).sort().join(",") !== "control,identity,nonce,operation,tuple" ||
            name !== `request-${request.nonce}` || !["challenge", "stop"].includes(request.operation) ||
            request.control !== path.basename(config.control) || request.identity !== config.identity ||
            JSON.stringify(request.tuple) !== JSON.stringify(config.tuple)) { stop(); return; }
        if (request.operation === "challenge" && !admitted()) return;
        const response = path.join(config.control, `response-${request.nonce}`);
        fs.writeFileSync(response + ".next", JSON.stringify({ ...request, pid: process.pid }), { flag: "wx", mode: 0o600 });
        fs.renameSync(response + ".next", response);
        fs.unlinkSync(file);
        if (request.operation === "stop") { stop(); return; }
      }
    } catch { stop(); }
  };
  setInterval(() => { controls(); admitted(); }, config.interval);
  const start = () => {
    if (!admitted()) return;
    if (!fs.existsSync(config.marker) && attempt >= config.policy.budget) { stop(); return; }
    const began = Date.now();
    const child = spawn("/bin/sh", ["-c", config.command], { stdio: "inherit" });
    child.once("error", stop);
    child.once("exit", () => {
      if (closing) return;
      if (Date.now() - began >= config.policy.healthySeconds * 1000) delay = config.policy.backoffSeconds;
      if (!fs.existsSync(config.marker)) attempt++;
      setTimeout(start, delay * 1000);
      if (fs.existsSync(config.marker)) delay = Math.min(delay * 2, config.policy.backoffCeilingSeconds);
    });
  };
  start();
}

function launch(component: string, dir: string, command: string, environment: Record<string, string>, cwd: string, context: Context, identity: string): number {
  const log = fs.openSync(path.join(dir, LOG_FILE), "w");
  try {
    const guarded = context.kind === "machine";
    const control = guarded ? randomUUID() : "";
    if (guarded) fs.mkdirSync(path.join(dir, control), { mode: 0o700 });
    const args = guarded
      ? ["-e", `(${managedSupervisor.toString()})(${JSON.stringify({ file: context.file, tuple: context.tuple, root: context.sessionRoot, control: path.join(dir, control), identity, command, marker: path.join(dir, SERVED_FILE), policy: RESTART_POLICY, grace: RETIREMENT_GRACE_MS, interval: PROBE_INTERVAL_MS })}, ${readSession.toString()}, ${privateJSON.toString()}, require);`]
      : ["-c", restartScript(command, path.join(dir, SERVED_FILE))];
    const child = spawn(guarded ? process.execPath : SHELL, args, { cwd, env: environment, detached: true, stdio: ["ignore", log, log] });
    child.once("error", () => {});
    if (child.pid === undefined) throw new Error(`${Refusal.startupFailed}: ${component}`);
    child.unref();
    if (context.kind === "machine") fs.writeFileSync(path.join(dir, CONTROL_FILE), JSON.stringify({ control, identity, pid: child.pid, tuple: context.tuple }), { mode: 0o600 });
    return child.pid;
  } finally {
    fs.closeSync(log);
  }
}

async function awaitStartup(component: string, dir: string, pid: number, port: number, context: Context): Promise<void> {
  const deadline = Date.now() + STARTUP_DEADLINE_MS;
  while (true) {
    checkContext(context);
    if (!alive(pid)) throw new Error(`${Refusal.startupFailed}: ${component}\n${logTail(dir)}`);
    if (await listening(port)) {
      await requireOwnedListener(port, pid, context, dir);
      return;
    }
    if (Date.now() >= deadline) throw new Error(`${Refusal.startupTimeout}: ${component}\n${logTail(dir)}`);
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
  context: Context;
  ingressDomain: string;
}): Promise<void> {
  const { component, port, releaseIdentity, command, context } = input;
  const binding = readBinding(component, input.uri, context);
  if (Object.keys(input.env).some((key) => key === ENV_SANDBOX_ID || key.startsWith("SDLC_WORKSPACE_"))) throw new Error(Refusal.sessionInvalid);
  checkContext(context);
  const dir = machineCustody(context, component, true);
  const lock = path.join(dir, "lifecycle.lock");
  if (context.kind === "machine") {
    try { fs.closeSync(fs.openSync(lock, "wx", 0o600)); }
    catch { throw new Error(Refusal.custodyBusy); }
  }
  try {
    checkContext(context);
    fs.mkdirSync(path.join(dir, STATE_DIR), { recursive: true });
    const environment: Record<string, string> = {
      ...inheritedEnvironment(),
      ...input.env,
      [ENV_WORKSPACE_ROOT]: binding.workspace_root,
      PATH: binding.runtime_path,
      [ENV_STATE_DIR]: path.join(dir, STATE_DIR),
      [ENV_PORT]: String(port),
    };
    const identity = launchIdentity(releaseIdentity, command, context.kind === "machine" ? { ...environment, resident_identity: context.identity } : environment);
    const predecessor = Number(readCustody(dir, PID_FILE));
    const recorded = Number.isInteger(predecessor) && predecessor > 0;
    const standing = recorded && alive(predecessor);
    if (!standing || readCustody(dir, LAUNCH_FILE) !== identity) {
      if (recorded) {
        if (context.kind === "machine") await retireMachine(dir, predecessor, context);
        else await retire(predecessor);
      }
      fs.rmSync(path.join(dir, RECORD_FILE), { force: true });
      fs.rmSync(path.join(dir, SERVED_FILE), { force: true });
      if (await listening(port)) throw new Error(`${Refusal.portOccupied}: ${component}: ${port}`);
      checkContext(context);
      const pid = launch(component, dir, command, environment, binding.workspace_root, context, identity);
      fs.writeFileSync(path.join(dir, PID_FILE), String(pid));
      fs.writeFileSync(path.join(dir, LAUNCH_FILE), identity);
    }
    await awaitStartup(component, dir, Number(readCustody(dir, PID_FILE)), port, context);
    checkContext(context);
    fs.writeFileSync(path.join(dir, SERVED_FILE), "");
    const record: ServingRecord = {
      release_identity: releaseIdentity,
      environment_identity: context.identity,
      port,
      endpoint: context.kind === "machine" ? `http://${LOOPBACK}:${port}` : servingEndpoint(port, context.identity, input.ingressDomain),
    };
    fs.writeFileSync(path.join(dir, RECORD_FILE), JSON.stringify(record));
  } finally { if (context.kind === "machine") fs.unlinkSync(lock); }
}

async function witnessed(context: Context): Promise<Record<string, ServingRecord>> {
  const out: Record<string, ServingRecord> = {};
  let components: string[];
  checkContext(context);
  try {
    components = fs.readdirSync(context.root).sort();
  } catch {
    return out;
  }
  for (const component of components) {
    try {
      if (!/^[a-z][a-z0-9-]*$/.test(component)) continue;
      const dir = machineCustody(context, component, false);
      const pid = Number(readCustody(dir, PID_FILE));
      const record = ServingRecordSchema.parse(JSON.parse(fs.readFileSync(path.join(dir, RECORD_FILE), "utf8")));
      if (record.environment_identity === context.identity && pid > 0 && alive(pid) && (await listening(record.port))) {
        await requireOwnedListener(record.port, pid, context, dir);
        out[component] = record;
      }
    } catch {
      continue;
    }
  }
  checkContext(context);
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
    const context = currentContext();
    state.ingress_domain = IngressDomainSchema.parse(inputs.ingress_domain);
    return { [REALIZED_SERVING_ENDPOINTS]: pulumi.output(await witnessed(context)) };
  },

  upsertArtifacts: async ({ buildArtifacts, state, envStore, servingPorts, releaseIdentities, deploymentConfigs }) => {
    const context = currentContext();
    const ingressDomain = IngressDomainSchema.parse(state.ingress_domain);
    const outcomes = await Promise.allSettled(
      Object.entries(buildArtifacts).map(async ([name, info]) => {
        const port = servingPorts[name];
        if (port === undefined) throw new Error(`${Refusal.servingPortUndeclared}: ${name}`);
        const releaseIdentity = releaseIdentities[name];
        if (!releaseIdentity) throw new Error(`${Refusal.releaseIdentityAbsent}: ${name}`);
        const { command } = DeploymentSchema.parse(deploymentConfigs[name] ?? {});
        await realize({ component: name, uri: info.artifact.uri, port, releaseIdentity, command, env: envStore[name] ?? {}, context, ingressDomain });
      }),
    );
    const failures = outcomes.flatMap((outcome) =>
      outcome.status === "rejected" ? [outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason)] : [],
    );
    if (failures.length > 0) throw new Error(failures.join("\n"));
    return { [REALIZED_SERVING_ENDPOINTS]: await witnessed(context) };
  },
});

export default component;
