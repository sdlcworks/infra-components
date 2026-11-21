import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:https";
import type { ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { JSONValue } from "@sdlcworks/components/task";
import type { ScenarioWorld } from "../scenario";
import type { WorldObservation } from "./aws-http-world";

type JsonObject = Record<string, JSONValue>;
type ScriptStep = ScenarioWorld["script"][number];
type ResourceAddress = { group: string; version: string; kind: string; namespace: string; name: string };
type ResourceRoute = Omit<ResourceAddress, "name"> & { name: string | null };

const resources = new Map([
  ["pods", { group: "", version: "v1", kind: "Pod" }],
  ["secrets", { group: "", version: "v1", kind: "Secret" }],
  ["serviceaccounts", { group: "", version: "v1", kind: "ServiceAccount" }],
  ["roles", { group: "rbac.authorization.k8s.io", version: "v1", kind: "Role" }],
  ["rolebindings", { group: "rbac.authorization.k8s.io", version: "v1", kind: "RoleBinding" }],
]);

function certificates(): { key: string; certificate: string } {
  const root = mkdtempSync(join(tmpdir(), "kubernetes-world-tls-"));
  try {
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1", "-keyout", join(root, "key.pem"), "-out", join(root, "cert.pem")], { stdio: "ignore" });
    return { key: readFileSync(join(root, "key.pem"), "utf8"), certificate: readFileSync(join(root, "cert.pem"), "utf8") };
  } finally { rmSync(root, { recursive: true, force: true }); }
}

function object(value: unknown): value is JsonObject { return value !== null && typeof value === "object" && !Array.isArray(value); }
function merge(current: JSONValue, effect: unknown): JSONValue {
  if (!object(effect)) return structuredClone(effect) as JSONValue;
  return { ...(object(current) ? current : {}), ...structuredClone(effect) };
}
function key(address: ResourceAddress): string { return `${address.group}/${address.version}/${address.kind}/${address.namespace}/${address.name}`; }
function metadata(value: JsonObject): JsonObject | null { return object(value.metadata) ? value.metadata : null; }

function route(path: string): ResourceRoute | null {
  const core = /^\/api\/v1\/namespaces\/([^/]+)\/([^/]+)(?:\/([^/]+))?$/.exec(path);
  const rbac = /^\/apis\/rbac\.authorization\.k8s\.io\/v1\/namespaces\/([^/]+)\/([^/]+)(?:\/([^/]+))?$/.exec(path);
  const match = core ?? rbac;
  if (!match) return null;
  const definition = resources.get(match[2]!);
  if (!definition || (rbac ? definition.group !== "rbac.authorization.k8s.io" : definition.group !== "")) return null;
  return { ...definition, namespace: decodeURIComponent(match[1]!), name: match[3] ? decodeURIComponent(match[3]) : null };
}

function status(response: ServerResponse, code: number, reason: string, message: string): void {
  send(response, code, { apiVersion: "v1", kind: "Status", status: "Failure", reason, message, code });
}
function send(response: ServerResponse, code: number, body: JSONValue, headers: Record<string, string> = {}): void {
  response.statusCode = code;
  for (const [name, value] of Object.entries(headers)) response.setHeader(name, value);
  response.setHeader("content-type", "application/json");
  response.end(typeof body === "string" ? body : JSON.stringify(body));
}
function scripted(response: ServerResponse, step: ScriptStep): void {
  if (step.response.kind === "connection-loss") { response.destroy(); return; }
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(step.response.headers)) {
    if (typeof value !== "string") throw new Error(`unresolved-script-header:${name}`);
    headers[name] = value;
  }
  send(response, step.response.status, step.response.body as JSONValue, headers);
}

function addressFor(value: JsonObject, fallback?: ResourceRoute): ResourceAddress | null {
  const meta = metadata(value);
  const apiVersion = typeof value.apiVersion === "string" ? value.apiVersion : null;
  const kind = typeof value.kind === "string" ? value.kind : null;
  const namespace = typeof meta?.namespace === "string" ? meta.namespace : fallback?.namespace;
  const name = typeof meta?.name === "string" ? meta.name : fallback?.name;
  if (!apiVersion || !kind || !namespace || !name) return null;
  const slash = apiVersion.indexOf("/");
  return { group: slash < 0 ? "" : apiVersion.slice(0, slash), version: slash < 0 ? apiVersion : apiVersion.slice(slash + 1), kind, namespace, name };
}

function mergePatch(current: JsonObject, patch: JsonObject): JsonObject {
  const result = structuredClone(current);
  for (const [name, value] of Object.entries(patch)) {
    if (value === null) delete result[name];
    else if (object(value) && object(result[name])) result[name] = mergePatch(result[name] as JsonObject, value);
    else result[name] = structuredClone(value);
  }
  return result;
}

export async function startKubernetesHttpsWorld(world: ScenarioWorld): Promise<{
  bindings: Record<string, string>;
  observation(): WorldObservation;
  close(): Promise<void>;
}> {
  if (world.kind !== "kubernetes-https") throw new Error("kubernetes-world-kind-refused");
  const tls = certificates();
  let cursor = 0;
  let serial = 1;
  let effects = structuredClone(world.initialState) as JSONValue;
  const store = new Map<string, JsonObject>();
  const requests: JSONValue[] = [];
  const environments = new Set<string>();

  const exposeStore = (): void => { effects = merge(effects, { resources: Array.from(store.values(), (value) => structuredClone(value)) }); };
  const loadResources = (): void => {
    if (!object(effects) || !Array.isArray(effects.resources)) return;
    for (const value of effects.resources) {
      if (!object(value)) continue;
      const address = addressFor(value);
      if (address) {
        store.set(key(address), structuredClone(value));
        const resourceVersion = Number(metadata(value)?.resourceVersion);
        if (Number.isSafeInteger(resourceVersion) && resourceVersion >= serial) serial = resourceVersion + 1;
      }
    }
  };
  const applyScenarioEffect = (effect: unknown): void => { effects = merge(effects, effect); loadResources(); exposeStore(); };
  const applyPostBodyCreate = (method: string, resource: ResourceRoute | null, body: JSONValue, url: URL): void => {
    if (method !== "POST" || !resource || resource.name || url.searchParams.get("dryRun") === "All" || !object(body)) return;
    const address = addressFor(body, resource);
    if (!address || store.has(key(address))) return;
    const stored = structuredClone(body);
    const version = String(serial++);
    metadata(stored)!.uid = `uid-${version}`;
    metadata(stored)!.resourceVersion = version;
    store.set(key(address), stored);
    if (address.kind === "Pod") environments.add(`uid-${version}`);
    exposeStore();
  };
  loadResources();
  exposeStore();

  const server = createServer({ key: tls.key, cert: tls.certificate }, (request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      const url = new URL(request.url ?? "/", "https://localhost");
      const text = Buffer.concat(chunks).toString("utf8");
      let body: JSONValue = null;
      let malformed = false;
      if (text) { try { body = JSON.parse(text) as JSONValue; } catch { body = { malformed: text }; malformed = true; } }
      requests.push({ method: request.method ?? null, path: url.pathname, query: Object.fromEntries(url.searchParams), authorization: request.headers.authorization ?? null, contentType: request.headers["content-type"] ?? null, body });

      const next = world.script[cursor];
      const qualification = url.pathname === "/version" || /^\/api\/v1\/namespaces\/[^/]+$/.test(url.pathname);
      const errorInjection = next?.response.kind !== "success";
      const step = next && (qualification || errorInjection) ? world.script[cursor++] : null;
      if (step) {
        applyScenarioEffect(step.externalEffect);
        if (step.response.kind === "connection-loss" && step.response.phase === "after-apply") {
          applyPostBodyCreate(request.method ?? "", route(url.pathname), body, url);
          applyScenarioEffect(step.response.appliedEffect);
        }
        scripted(response, step);
        return;
      }

      if (malformed) { status(response, 400, "BadRequest", "request body is not valid JSON"); return; }
      if (request.method === "GET" && url.pathname === "/version") { send(response, 200, { major: "1", minor: "34", gitVersion: "v1.34.0" }); return; }
      const namespace = /^\/api\/v1\/namespaces\/([^/]+)$/.exec(url.pathname);
      if (request.method === "GET" && namespace) {
        const name = decodeURIComponent(namespace[1]!);
        send(response, 200, { apiVersion: "v1", kind: "Namespace", metadata: { name, uid: "namespace-uid", resourceVersion: "1" }, status: { phase: "Active" } });
        return;
      }

      const resource = route(url.pathname);
      if (!resource) { status(response, 404, "NotFound", "unsupported Kubernetes API path"); return; }
      if (request.method === "POST") {
        if (resource.name || !object(body)) { status(response, 400, "BadRequest", "collection create requires an object"); return; }
        const address = addressFor(body, resource);
        if (!address || address.group !== resource.group || address.version !== resource.version || address.kind !== resource.kind || address.namespace !== resource.namespace) { status(response, 400, "BadRequest", "object identity does not match request path"); return; }
        if (url.searchParams.get("dryRun") === "All") {
          const dry = structuredClone(body);
          const meta = metadata(dry)!;
          meta.uid = `dry-run-${address.kind.toLowerCase()}-${address.name}`;
          meta.resourceVersion = "0";
          send(response, 201, dry);
          return;
        }
        const resourceKey = key(address);
        if (store.has(resourceKey)) { status(response, 409, "AlreadyExists", `${address.kind} ${address.name} already exists`); return; }
        const stored = structuredClone(body);
        const version = String(serial++);
        const meta = metadata(stored)!;
        meta.uid = `uid-${version}`;
        meta.resourceVersion = version;
        store.set(resourceKey, stored);
        if (address.kind === "Pod") environments.add(meta.uid as string);
        exposeStore();
        send(response, 201, stored);
        return;
      }
      if (!resource.name) { status(response, 405, "MethodNotAllowed", "collection operation not supported"); return; }
      const resourceKey = key(resource as ResourceAddress);
      const stored = store.get(resourceKey);
      if (request.method === "GET") {
        if (!stored) { status(response, 404, "NotFound", `${resource.kind} ${resource.name} not found`); return; }
        send(response, 200, stored);
        return;
      }
      if (request.method === "PATCH") {
        if (resource.kind !== "Secret" || !object(body)) { status(response, 405, "MethodNotAllowed", "only Secret merge patch is supported"); return; }
        if (!stored) { status(response, 404, "NotFound", `Secret ${resource.name} not found`); return; }
        const expected = metadata(body)?.resourceVersion;
        if (typeof expected !== "string" || expected !== metadata(stored)?.resourceVersion) { status(response, 409, "Conflict", "resourceVersion precondition failed"); return; }
        const updated = mergePatch(stored, body);
        metadata(updated)!.resourceVersion = String(serial++);
        store.set(resourceKey, updated);
        exposeStore();
        send(response, 200, updated);
        return;
      }
      if (request.method === "DELETE") {
        if (!stored) { status(response, 404, "NotFound", `${resource.kind} ${resource.name} not found`); return; }
        const uid = object(body) && object(body.preconditions) ? body.preconditions.uid : null;
        if (typeof uid !== "string" || uid !== metadata(stored)?.uid) { status(response, 409, "Conflict", "UID precondition failed"); return; }
        store.delete(resourceKey);
        exposeStore();
        send(response, 200, { apiVersion: "v1", kind: "Status", status: "Success", details: { name: resource.name, kind: resource.kind, uid } });
        return;
      }
      status(response, 405, "MethodNotAllowed", "operation not supported");
    });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address() as AddressInfo;
  return {
    bindings: { "kubernetes-https-root": `https://localhost:${address.port}`, "kubernetes-ca-pem": tls.certificate, "kubernetes-client-certificate-pem": tls.certificate, "kubernetes-client-private-key-pem": tls.key },
    observation: () => ({ requests: structuredClone(requests), effects: structuredClone(effects), environmentCount: environments.size }),
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}
