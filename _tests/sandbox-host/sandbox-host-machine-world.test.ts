import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { loadSandboxHost } from "./load-sandbox-host";

const RUNTIME_PATH = (process.env.PATH ?? "").split(":").filter(entry => entry.startsWith("/")).join(":");
const SERVE = `exec bun -e "Bun.serve({hostname:'127.0.0.1',port:Number(process.env.PORT),fetch:()=>new Response(process.env.SDLC_COMPONENT_STATE_DIR)})"`;
const COMPONENT = "machine-test";
const TIMEOUT = 45_000;
const cleanups: (() => void)[] = [];
const originalEnvironment = { ...process.env };
const CONTROL_KEYS = ["E2B_SANDBOX_ID", "SDLC_WORKSPACE_MACHINE_ID", "SDLC_WORKSPACE_SESSION_ID", "SDLC_WORKSPACE_ID", "SDLC_WORKSPACE_GENERATION", "SDLC_WORKSPACE_ROOT", "SDLC_WORKSPACE_SESSION_FILE"];
let sequence = 0;

async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>(resolve => server.close(() => resolve()));
  return port;
}
async function until(predicate: () => Promise<boolean>, timeout = 5000): Promise<boolean> {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await predicate()) return true; await new Promise(resolve => setTimeout(resolve, 50)); }
  return predicate();
}
function fixture(changes: Record<string, string> = {}, lifetime = 60_000) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "machine-workspace-")));
  const owner = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "machine-owner-")));
  fs.chmodSync(owner, 0o700);
  fs.writeFileSync(path.join(root, "sdlc.toml"), "");
  const tuple = { machine_id: "machine-one", session_id: `session-${process.pid}-${sequence++}`, workspace_id: "workspace-one", generation: "9007199254740993", workspace_root: root, ...changes };
  const record = { protocol: "sdlc-workspace-session", ...tuple, revision: "1", state: "ready", valid_until: new Date(Date.now() + lifetime).toISOString() };
  const session = path.join(owner, "session.json");
  const write = () => { fs.writeFileSync(session + ".next", JSON.stringify(record), { mode: 0o600 }); fs.renameSync(session + ".next", session); };
  write();
  const binding = path.join(root, "binding.json");
  const artifact = { protocol: "sdlc-sandbox-binding", environment: "machine", ...tuple, component: COMPONENT, runtime_path: RUNTIME_PATH };
  fs.writeFileSync(binding, JSON.stringify(artifact));
  const digest = createHash("sha256").update(JSON.stringify(["sdlc-machine", tuple.machine_id, tuple.session_id, tuple.workspace_id, tuple.generation, tuple.workspace_root])).digest("hex");
  const namespace = path.join(fs.realpathSync(os.tmpdir()), "sdlc-sandbox-host", "machine", digest);
  const sessionDigest = createHash("sha256").update(JSON.stringify(["sdlc-machine-session", tuple.machine_id, tuple.session_id])).digest("hex");
  const sessionCustody = path.join(fs.realpathSync(os.tmpdir()), "sdlc-sandbox-host", "machine-sessions", sessionDigest);
  const dir = path.join(namespace, COMPONENT);
  const env = { SDLC_WORKSPACE_MACHINE_ID: tuple.machine_id, SDLC_WORKSPACE_SESSION_ID: tuple.session_id, SDLC_WORKSPACE_ID: tuple.workspace_id, SDLC_WORKSPACE_GENERATION: tuple.generation, SDLC_WORKSPACE_ROOT: tuple.workspace_root, SDLC_WORKSPACE_SESSION_FILE: session };
  const activate = () => { for (const key of CONTROL_KEYS) delete process.env[key]; Object.assign(process.env, env); };
  activate();
  const ctx = (port: number, release = "r1", command = SERVE) => ({
    buildArtifacts: { [COMPONENT]: { artifact: { uri: `file://${binding}`, type: "file" } } },
    state: { ingress_domain: "e2b.app" }, envStore: { [COMPONENT]: {} }, getCredentials: () => ({}),
    servingPorts: { [COMPONENT]: port }, releaseIdentities: { [COMPONENT]: release }, deploymentConfigs: { [COMPONENT]: { command } }, currentOutputs: {},
  } as any);
  const pid = () => Number(fs.readFileSync(path.join(dir, "pid"), "utf8"));
  cleanups.push(() => {
    try { process.kill(-pid(), "SIGKILL"); } catch {}
    for (const directory of [namespace, sessionCustody, root, owner]) fs.rmSync(directory, { recursive: true, force: true });
  });
  return { root, owner, tuple, record, session, write, binding, artifact, namespace, sessionCustody, dir, env, activate, ctx, pid };
}
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  for (const key of CONTROL_KEYS) { if (originalEnvironment[key] === undefined) delete process.env[key]; else process.env[key] = originalEnvironment[key]; }
});
async function deploy(f: ReturnType<typeof fixture>, port: number, release = "r1", command = SERVE) {
  const { default: host } = await loadSandboxHost();
  return host.providers["e2b-local"]!.upsertArtifacts!(f.ctx(port, release, command)) as Promise<any>;
}

test("machine release serves loopback, reuses custody and preserves data on replacement", async () => {
  const f = fixture(); const port = await freePort();
  const out = await deploy(f, port);
  expect(out.realized_serving_endpoints[COMPONENT].endpoint).toBe(`http://127.0.0.1:${port}`);
  expect(out.realized_serving_endpoints[COMPONENT].environment_identity).toStartWith("machine:");
  const first = f.pid();
  expect(await (await fetch(`http://127.0.0.1:${port}`)).text()).toBe(path.join(f.dir, "data"));
  fs.writeFileSync(path.join(f.dir, "data", "keep"), "retained");
  await deploy(f, port); expect(f.pid()).toBe(first);
  const originalKill = process.kill; const signals: unknown[] = [];
  process.kill = ((pid: number, signal?: NodeJS.Signals | number) => { if (signal !== 0) signals.push([pid, signal]); return originalKill(pid, signal); }) as typeof process.kill;
  try { await deploy(f, port, "r2"); expect(signals).toEqual([]); }
  finally { process.kill = originalKill; }
  expect(f.pid()).not.toBe(first);
  expect(fs.readFileSync(path.join(f.dir, "data", "keep"), "utf8")).toBe("retained");
}, TIMEOUT);

test.each(["machine_id", "session_id", "workspace_id", "generation", "workspace_root"])("artifact mismatch in %s leaves actual namespace untouched", async field => {
  const f = fixture(); const port = await freePort(); await deploy(f, port);
  const first = f.pid(); const before = fs.readFileSync(path.join(f.dir, "record.json"), "utf8");
  (f.artifact as any)[field] = field === "generation" ? "9007199254740994" : "different";
  fs.writeFileSync(f.binding, JSON.stringify(f.artifact));
  await expect(deploy(f, port, "r2")).rejects.toThrow("sandbox-host-binding-invalid");
  expect(f.pid()).toBe(first); expect(fs.readFileSync(path.join(f.dir, "record.json"), "utf8")).toBe(before);
  expect((await fetch(`http://127.0.0.1:${port}`)).ok).toBe(true);
}, TIMEOUT);

test.each(["missing", "closed", "expired", "permissions", "symlink", "identity", "mixed", "root", "generation", "control"])("invalid %s context refuses without custody creation", async reason => {
  const f = fixture();
  if (reason === "missing") delete process.env.SDLC_WORKSPACE_SESSION_FILE;
  if (reason === "closed") { f.record.state = "closed"; f.write(); }
  if (reason === "expired") { f.record.valid_until = new Date(Date.now() - 100).toISOString(); f.write(); }
  if (reason === "permissions") fs.chmodSync(f.session, 0o644);
  if (reason === "symlink") { fs.renameSync(f.session, f.session + ".real"); fs.symlinkSync(f.session + ".real", f.session); }
  if (reason === "identity") { f.record.machine_id = "../bad"; f.write(); }
  if (reason === "mixed") process.env.E2B_SANDBOX_ID = "real-sandbox";
  if (reason === "root") process.env.SDLC_WORKSPACE_ROOT = f.root + "/.";
  if (reason === "generation") process.env.SDLC_WORKSPACE_GENERATION = "18446744073709551616";
  if (reason === "control") {
    const { default: host } = await loadSandboxHost(); const ctx = f.ctx(await freePort());
    ctx.envStore[COMPONENT].SDLC_WORKSPACE_SESSION_FILE = f.session;
    await expect(host.providers["e2b-local"]!.upsertArtifacts!(ctx)).rejects.toThrow("sandbox-host-session-invalid");
  } else await expect(deploy(f, await freePort())).rejects.toThrow("sandbox-host-session-invalid");
  expect(fs.existsSync(f.dir)).toBe(false);
});

test("same revision cannot extend retained standing, and closure refuses stale artifacts", async () => {
  const f = fixture(); const port = await freePort(); await deploy(f, port);
  f.record.valid_until = new Date(Date.now() + 120_000).toISOString(); f.write();
  await expect(deploy(f, port)).rejects.toThrow("sandbox-host-session-invalid");
  f.record.revision = "2"; f.record.state = "closed"; f.write();
  await expect(deploy(f, port)).rejects.toThrow("sandbox-host-session-invalid");
});

test("a later renewal extends standing only for the same exact identity", async () => {
  const f = fixture(); const port = await freePort(); await deploy(f, port);
  const priorDeadline = Date.now() + 2000;
  f.record.revision = "2"; f.record.valid_until = new Date(priorDeadline).toISOString(); f.write();
  expect(await until(async () => JSON.parse(fs.readFileSync(path.join(f.sessionCustody, "session.json"), "utf8")).record.revision === "2")).toBe(true);
  f.record.revision = "3"; f.record.valid_until = new Date(Date.now() + 10_000).toISOString(); f.write();
  await new Promise(resolve => setTimeout(resolve, Math.max(0, priorDeadline - Date.now() + 50)));
  expect((await fetch(`http://127.0.0.1:${port}`)).ok).toBe(true);
  f.record.revision = "4"; f.record.session_id = "replacement"; f.write();
  await expect(deploy(f, port)).rejects.toThrow("sandbox-host-session-invalid");
});

test("expiry during startup publishes no serving account", async () => {
  const f = fixture({}, 500); const port = await freePort();
  await expect(deploy(f, port, "r1", `sleep 2; ${SERVE}`)).rejects.toThrow("sandbox-host-session-invalid");
  expect(fs.existsSync(path.join(f.dir, "record.json"))).toBe(false);
  const { listening } = await loadSandboxHost();
  await new Promise(resolve => setTimeout(resolve, 2100)); expect(await listening(port)).toBe(false);
});

test("running expiry stops the owned listener and prevents restart", async () => {
  const f = fixture(); const port = await freePort(); await deploy(f, port);
  f.record.revision = "2"; f.record.valid_until = new Date(Date.now() + 250).toISOString(); f.write();
  const { listening } = await loadSandboxHost();
  expect(await until(async () => !(await listening(port)))).toBe(true);
  await expect(deploy(f, port)).rejects.toThrow("sandbox-host-session-invalid");
});

test("a foreign listener is neither readiness nor retirement authority", async () => {
  const f = fixture(); const server = net.createServer();
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => server.close());
  const port = (server.address() as net.AddressInfo).port;
  await expect(deploy(f, port)).rejects.toThrow("sandbox-host-port-occupied");
  expect(server.listening).toBe(true); expect(fs.existsSync(path.join(f.dir, "pid"))).toBe(false);
});

test("custody symlink refuses without touching foreign data", async () => {
  const f = fixture(); fs.mkdirSync(f.namespace, { recursive: true, mode: 0o700 });
  fs.symlinkSync(f.owner, f.dir);
  const before = fs.readdirSync(f.owner);
  await expect(deploy(f, await freePort())).rejects.toThrow("sandbox-host-custody-invalid");
  expect(fs.readdirSync(f.owner)).toEqual(before);
});

test("detached guard remains effective after the invoking worker exits", async () => {
  const f = fixture(); const port = await freePort();
  const loader = path.resolve(import.meta.dir, "load-sandbox-host.ts");
  const code = `const {loadSandboxHost}=await import(${JSON.stringify(loader)});const {default:host}=await loadSandboxHost();await host.providers['e2b-local'].upsertArtifacts(${JSON.stringify(f.ctx(port))});process.exit(0);`;
  const child = spawn(process.execPath, ["-e", code], { env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"] });
  let error = ""; child.stderr.on("data", data => error += data);
  const status = await new Promise(resolve => child.once("exit", resolve));
  expect({ status, error }).toEqual({ status: 0, error: "" });
  const { listening } = await loadSandboxHost();
  expect(await listening(port)).toBe(true);
  f.record.revision = "2"; f.record.valid_until = new Date(Date.now() + 250).toISOString(); f.write();
  expect(await until(async () => !(await listening(port)), 5000)).toBe(true);
}, TIMEOUT);

test("distinct admitted namespaces never enumerate or retire each other's components", async () => {
  const first = fixture(); const firstPort = await freePort(); await deploy(first, firstPort);
  const firstPid = first.pid();
  fs.writeFileSync(path.join(first.dir, "data", "keep"), "first namespace");
  const second = fixture({ machine_id: "machine-two", workspace_id: "workspace-two", generation: "9007199254740994" });
  const secondPort = await freePort(); const out = await deploy(second, secondPort);
  expect(first.namespace).not.toBe(second.namespace);
  expect(second.pid()).not.toBe(firstPid);
  expect(out.realized_serving_endpoints[COMPONENT].port).toBe(secondPort);
  expect(fs.existsSync(path.join(second.dir, "data", "keep"))).toBe(false);
  expect(fs.readFileSync(path.join(first.dir, "data", "keep"), "utf8")).toBe("first namespace");
  first.activate();
  const { default: host } = await loadSandboxHost();
  const firstOut = await host.providers["e2b-local"]!.pulumi({ inputs: { ingress_domain: "e2b.app" }, state: {} } as any);
  const witnessed = await (firstOut as any).realized_serving_endpoints.apply((value: unknown) => value);
  expect(witnessed[COMPONENT].port).toBe(firstPort);
  expect(first.pid()).toBe(firstPid);
  expect((await fetch(`http://127.0.0.1:${secondPort}`)).ok).toBe(true);
});

test("a regressing revision closes the running guard", async () => {
  const f = fixture(); const port = await freePort();
  f.record.revision = "2"; f.write(); await deploy(f, port);
  f.record.revision = "1"; f.write();
  await expect(deploy(f, port)).rejects.toThrow("sandbox-host-session-invalid");
  const { listening } = await loadSandboxHost();
  expect(await until(async () => !(await listening(port)))).toBe(true);
});

test("session closure stops a previously served process without deleting source or data", async () => {
  const f = fixture(); const port = await freePort(); await deploy(f, port);
  fs.writeFileSync(path.join(f.dir, "data", "retained"), "data");
  f.record.revision = "2"; f.record.state = "closed"; f.write();
  const { listening } = await loadSandboxHost();
  expect(await until(async () => !(await listening(port)))).toBe(true);
  await expect(deploy(f, port)).rejects.toThrow("sandbox-host-session-invalid");
  expect(fs.existsSync(path.join(f.root, "sdlc.toml"))).toBe(true);
  expect(fs.readFileSync(path.join(f.dir, "data", "retained"), "utf8")).toBe("data");
});

test("unproven retirement refuses a replacement and retains its serving record", async () => {
  const f = fixture(); const port = await freePort(); await deploy(f, port);
  const pid = f.pid(); const record = fs.readFileSync(path.join(f.dir, "record.json"), "utf8");
  fs.rmSync(path.join(f.dir, "control.json"));
  await expect(deploy(f, port, "replacement")).rejects.toThrow("sandbox-host-retirement-unproven");
  expect(f.pid()).toBe(pid);
  expect(fs.readFileSync(path.join(f.dir, "record.json"), "utf8")).toBe(record);
  expect((await fetch(`http://127.0.0.1:${port}`)).ok).toBe(true);
});

test("a foreign listener racing startup cannot become the served release", async () => {
  const f = fixture(); const port = await freePort();
  const started = path.join(f.root, "started");
  const pending = deploy(f, port, "r1", `touch '${started}'; exec sleep 30`);
  const outcome = pending.then(value => ({ value }), error => ({ error }));
  expect(await until(async () => fs.existsSync(started))).toBe(true);
  const foreign = net.createServer();
  await new Promise<void>(resolve => foreign.listen(port, "127.0.0.1", resolve));
  cleanups.push(() => foreign.close());
  expect((await outcome as any).error.message).toContain("sandbox-host-port-occupied");
  expect(fs.existsSync(path.join(f.dir, "served"))).toBe(false);
  expect(fs.existsSync(path.join(f.dir, "record.json"))).toBe(false);
  expect(foreign.listening).toBe(true);
});

test("witnessed enumeration excludes foreign takeover while its supervisor lives", async () => {
  const f = fixture(); const port = await freePort();
  const app = path.join(f.root, "app.pid");
  await deploy(f, port, "r1", `echo $$ > '${app}'; ${SERVE}`);
  process.kill(Number(fs.readFileSync(app, "utf8")), "SIGKILL");
  const { listening, default: host } = await loadSandboxHost();
  expect(await until(async () => !(await listening(port)))).toBe(true);
  const foreign = net.createServer();
  await new Promise<void>(resolve => foreign.listen(port, "127.0.0.1", resolve));
  cleanups.push(() => foreign.close());
  const output = await host.providers["e2b-local"]!.pulumi({ inputs: { ingress_domain: "e2b.app" }, state: {} } as any);
  expect((output as any).realized_serving_endpoints.apply((value: unknown) => value)).toEqual({});
  expect(foreign.listening).toBe(true);
});

test("listener fields require complete process and file sets without concealing competing groups", async () => {
  const { parseListenerOwnership } = await loadSandboxHost();
  expect(parseListenerOwnership("p21\ng20\nf10\nn127.0.0.1:1234\n", 1234, 20)).toBe("owned");
  expect(parseListenerOwnership("p21\ng20\nf10\nn127.0.0.1:1234\nf11\nn[::1]:1234\np22\ng20\nf12\nn*:1234\n", 1234, 20)).toBe("owned");
  expect(parseListenerOwnership("p21\ng20\nf10\nn127.0.0.1:1234\np22\ng22\nf12\nn[::1]:1234\n", 1234, 20)).toBe("foreign");
  for (const fields of ["", "p21\nf10\nn127.0.0.1:1234\n", "p21\ng20\nf10\n", "p21\ng20\nf10\nn127.0.0.1:1235\n", "p21\ng20\nf10\nn127.0.0.1:1234", "p21\ng20\nf10\nn127.0.0.1:1234\nxunknown\n"]) {
    expect(parseListenerOwnership(fields, 1234, 20)).toBe("unavailable");
  }
});

test("missing, diagnostic, excessive and timed-out listener testimony never falls back to TCP", async () => {
  const f = fixture(); const { listenerOwnership } = await loadSandboxHost();
  expect(await listenerOwnership(1234, 20, path.join(f.owner, "missing"))).toBe("unavailable");
  for (const [name, body] of [
    ["diagnostic", "echo warning >&2; printf 'p21\\ng20\\nf10\\nn127.0.0.1:1234\\n'"],
    ["excessive", "exec yes p21"],
    ["timeout", "exec sleep 5"],
    ["nonzero", "exit 1"],
  ]) {
    const executable = path.join(f.owner, name!);
    fs.writeFileSync(executable, `#!/bin/sh\n${body}\n`, { mode: 0o700 });
    expect(await listenerOwnership(1234, 20, executable)).toBe("unavailable");
  }
});

test.each(["2100-02-29T12:00:00Z", "2099-04-31T12:00:00Z", "2099-01-01T24:00:00Z", "2099-01-01T12:00:00+00:00", "2099-01-01T12:00:00z"])("impossible or non-UTC validity %s refuses", async timestamp => {
  const f = fixture(); f.record.valid_until = timestamp; f.write();
  await expect(deploy(f, await freePort())).rejects.toThrow("sandbox-host-session-invalid");
  expect(fs.existsSync(f.dir)).toBe(false);
});

test.each(["0", "01", "1.0", "1e2", "18446744073709551616"])("noncanonical revision %s refuses", async revision => {
  const f = fixture(); f.record.revision = revision; f.write();
  await expect(deploy(f, await freePort())).rejects.toThrow("sandbox-host-session-invalid");
  expect(fs.existsSync(f.dir)).toBe(false);
});

async function freshObservation(f: ReturnType<typeof fixture>): Promise<string> {
  const loader = path.resolve(import.meta.dir, "load-sandbox-host.ts");
  const code = `const {loadSandboxHost}=await import(${JSON.stringify(loader)});try{const {default:host}=await loadSandboxHost();await host.providers['e2b-local'].pulumi({inputs:{ingress_domain:'e2b.app'},state:{}});console.log('accepted')}catch(error){console.log(error.message)}process.exit(0)`;
  const environment: NodeJS.ProcessEnv = { ...process.env, ...f.env }; delete environment.E2B_SANDBOX_ID;
  const child = spawn(process.execPath, ["-e", code], { env: environment, stdio: ["ignore", "pipe", "pipe"] });
  let output = ""; let error = "";
  child.stdout.on("data", data => output += data); child.stderr.on("data", data => error += data);
  const status = await new Promise(resolve => child.once("exit", resolve));
  expect({ status, error }).toEqual({ status: 0, error: "" });
  return output.trim();
}

test("fresh workers cannot change a retained revision's meaning or regress it", async () => {
  const f = fixture(); f.record.revision = "3"; f.write();
  expect(await freshObservation(f)).toBe("accepted");
  f.record.valid_until = new Date(Date.now() + 120_000).toISOString(); f.write();
  expect(await freshObservation(f)).toBe("sandbox-host-session-invalid");
  f.record.revision = "2"; f.write();
  expect(await freshObservation(f)).toBe("sandbox-host-session-invalid");
  expect(JSON.parse(fs.readFileSync(path.join(f.sessionCustody, "session.json"), "utf8")).record.revision).toBe("3");
});

test.each(["closed", "expired"])("fresh workers cannot revive observed %s standing", async disposition => {
  const f = fixture();
  expect(await freshObservation(f)).toBe("accepted");
  f.record.revision = "2";
  if (disposition === "closed") f.record.state = "closed";
  else f.record.valid_until = new Date(Date.now() - 100).toISOString();
  f.write();
  expect(await freshObservation(f)).toBe("sandbox-host-session-invalid");
  f.record.revision = "3"; f.record.state = "ready"; f.record.valid_until = new Date(Date.now() + 60_000).toISOString(); f.write();
  expect(await freshObservation(f)).toBe("sandbox-host-session-invalid");
  const retained = JSON.parse(fs.readFileSync(path.join(f.sessionCustody, "session.json"), "utf8"));
  expect(retained.terminal).toBe(disposition); expect(retained.record.revision).toBe("2");
});

test("a genuine later renewal need not have every intermediate revision observed", async () => {
  const f = fixture({}, 1500);
  expect(await freshObservation(f)).toBe("accepted");
  const priorDeadline = Date.parse(f.record.valid_until);
  expect(Date.now()).toBeLessThan(priorDeadline);
  f.record.revision = "4"; f.record.valid_until = new Date(Date.now() + 10_000).toISOString(); f.write();
  await new Promise(resolve => setTimeout(resolve, Math.max(0, priorDeadline - Date.now() + 50)));
  expect(await freshObservation(f)).toBe("accepted");
});

test("concurrent workers and a guard retain highest revision and terminal observation", async () => {
  const f = fixture(); const port = await freePort(); await deploy(f, port);
  f.record.revision = "5"; f.write();
  expect(await Promise.all([freshObservation(f), freshObservation(f), freshObservation(f)])).toEqual(["accepted", "accepted", "accepted"]);
  f.record.revision = "6"; f.record.state = "closed"; f.write();
  expect(await Promise.all([freshObservation(f), freshObservation(f)])).toEqual(["sandbox-host-session-invalid", "sandbox-host-session-invalid"]);
  f.record.revision = "7"; f.record.state = "ready"; f.write();
  expect(await freshObservation(f)).toBe("sandbox-host-session-invalid");
  const retained = JSON.parse(fs.readFileSync(path.join(f.sessionCustody, "session.json"), "utf8"));
  expect(retained.record.revision).toBe("6"); expect(retained.terminal).toBe("closed");
});

test("lost session serialization remains unavailable without lock takeover", async () => {
  const f = fixture(); expect(await freshObservation(f)).toBe("accepted");
  const lock = path.join(f.sessionCustody, "session.lock"); fs.writeFileSync(lock, "retained", { mode: 0o600 });
  expect(await freshObservation(f)).toBe("sandbox-host-session-invalid");
  expect(fs.readFileSync(lock, "utf8")).toBe("retained");
});

test("a replayed challenge cannot prove a paused supervisor's current incarnation", async () => {
  const f = fixture(); const port = await freePort(); await deploy(f, port);
  process.kill(f.pid(), "SIGSTOP");
  const control = JSON.parse(fs.readFileSync(path.join(f.dir, "control.json"), "utf8"));
  const nonce = "11111111-1111-4111-8111-111111111111";
  fs.writeFileSync(path.join(f.dir, control.control, `response-${nonce}`), JSON.stringify({ operation: "challenge", nonce, tuple: f.tuple, identity: control.identity, control: control.control, pid: f.pid() }), { mode: 0o600 });
  await expect(deploy(f, port)).rejects.toThrow("sandbox-host-readiness-unavailable");
});

test("stale numerical custody cannot signal a foreign group or prove readiness", async () => {
  const f = fixture(); const port = await freePort(); await deploy(f, port);
  const oldPid = f.pid(); process.kill(-oldPid, "SIGKILL");
  const { listening } = await loadSandboxHost();
  expect(await until(async () => !(await listening(port)))).toBe(true);
  const foreign = spawn("/bin/sh", ["-c", SERVE], { env: { PATH: RUNTIME_PATH, PORT: String(port) }, detached: true, stdio: "ignore" });
  cleanups.push(() => { try { process.kill(-foreign.pid!, "SIGKILL"); } catch {} });
  expect(await until(() => listening(port))).toBe(true);
  const controlFile = path.join(f.dir, "control.json");
  const control = JSON.parse(fs.readFileSync(controlFile, "utf8")); control.pid = foreign.pid;
  fs.writeFileSync(controlFile, JSON.stringify(control)); fs.writeFileSync(path.join(f.dir, "pid"), String(foreign.pid));
  const originalKill = process.kill; const signals: unknown[] = [];
  process.kill = ((pid: number, signal?: NodeJS.Signals | number) => { if (signal !== 0) signals.push([pid, signal]); return originalKill(pid, signal); }) as typeof process.kill;
  try {
    await expect(deploy(f, port)).rejects.toThrow("sandbox-host-readiness-unavailable");
    await expect(deploy(f, port, "replacement")).rejects.toThrow("sandbox-host-retirement-unproven");
    expect(signals).toEqual([]);
  } finally { process.kill = originalKill; }
  expect(await listening(port)).toBe(true);
}, 15_000);

test("overlapping workers cannot orphan a second component launch", async () => {
  const f = fixture(); const port = await freePort();
  const started = path.join(f.root, "started"); const release = path.join(f.root, "release");
  const command = `echo $$ >> '${started}'; while [ ! -f '${release}' ]; do sleep 0.05; done; ${SERVE}`;
  const first = deploy(f, port, "r1", command);
  expect(await until(async () => fs.existsSync(started))).toBe(true);
  await expect(deploy(f, port, "r1", command)).rejects.toThrow("sandbox-host-custody-busy");
  const loader = path.resolve(import.meta.dir, "load-sandbox-host.ts");
  const code = `const {loadSandboxHost}=await import(${JSON.stringify(loader)});try{const {default:host}=await loadSandboxHost();await host.providers['e2b-local'].upsertArtifacts(${JSON.stringify(f.ctx(port, "r1", command))});console.log('accepted')}catch(error){console.log(error.message)}process.exit(0)`;
  const child = spawn(process.execPath, ["-e", code], { env: { ...process.env, ...f.env }, stdio: ["ignore", "pipe", "pipe"] });
  let output = ""; child.stdout.on("data", data => output += data);
  expect(await new Promise<number | null>(resolve => child.once("exit", code => resolve(code)))).toBe(0);
  expect(output.trim()).toBe("sandbox-host-custody-busy");
  fs.writeFileSync(release, ""); await first;
  const pid = f.pid(); await deploy(f, port, "r1", command);
  expect(f.pid()).toBe(pid);
  expect(fs.readFileSync(started, "utf8").trim().split("\n")).toHaveLength(1);
});

test("an abandoned component lifecycle lock is never taken over by PID inference", async () => {
  const f = fixture(); const port = await freePort(); await deploy(f, port);
  const lock = path.join(f.dir, "lifecycle.lock"); fs.writeFileSync(lock, "abandoned", { mode: 0o600 });
  await expect(deploy(f, port, "replacement")).rejects.toThrow("sandbox-host-custody-busy");
  expect(fs.readFileSync(lock, "utf8")).toBe("abandoned");
  expect((await fetch(`http://127.0.0.1:${port}`)).ok).toBe(true);
});

test("fresh workers cannot replace immutable session identity by changing all public inputs", async () => {
  const first = fixture(); expect(await freshObservation(first)).toBe("accepted");
  const second = fixture({ machine_id: first.tuple.machine_id, session_id: first.tuple.session_id, generation: "9007199254740994" });
  second.record.revision = "2"; second.write();
  expect(second.sessionCustody).toBe(first.sessionCustody);
  expect(second.namespace).not.toBe(first.namespace);
  expect(await freshObservation(second)).toBe("sandbox-host-session-invalid");
  expect(JSON.parse(fs.readFileSync(path.join(first.sessionCustody, "session.json"), "utf8")).record.workspace_root).toBe(first.root);
});
