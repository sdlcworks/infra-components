import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { KubernetesConfiguration, KubernetesCredentials } from "./schemas";

export type KubernetesFixture = { serverUrl: string; certificateAuthorityPem: string; requests: Array<{ method: string; path: string; body: any }>; close(): Promise<void> };
export async function createKubernetesFixture(scenario: { mutatePod?: (pod: any) => any; token?: string } = {}): Promise<KubernetesFixture> {
  const directory = mkdtempSync(join(tmpdir(), "sdlc-kubernetes-fixture-")); const key = join(directory, "key.pem"), cert = join(directory, "cert.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost"], { stdio: "ignore" });
  const resources = new Map<string, any>(); const requests: KubernetesFixture["requests"] = []; let serial = 1;
  const server: Server = createServer({ key: readFileSync(key), cert: readFileSync(cert) }, (request, response) => {
    const chunks: Buffer[] = []; request.on("data", (chunk) => chunks.push(chunk)); request.on("end", () => {
      const url = new URL(request.url ?? "/", "https://localhost"); let body: any = null; try { body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : null; } catch { body = null; } requests.push({ method: request.method ?? "", path: `${url.pathname}${url.search}`, body });
      response.setHeader("content-type", "application/json"); const send = (code: number, value: any) => { response.statusCode = code; response.end(JSON.stringify(value)); };
      if (scenario.token && request.headers.authorization !== `Bearer ${scenario.token}`) return send(401, { apiVersion: "v1", kind: "Status", reason: "Unauthorized" });
      if (url.pathname === "/version") return send(200, { gitVersion: "v1.34.0" });
      if (url.pathname === "/api/v1/namespaces/tasks") return send(200, { apiVersion: "v1", kind: "Namespace", metadata: { name: "tasks", uid: "namespace-uid", resourceVersion: "1" }, status: { phase: "Active" } });
      const collection = url.pathname.replace(/\/[^/]+$/, ""); const name = body?.metadata?.name ?? decodeURIComponent(url.pathname.split("/").pop() ?? ""); const keyName = `${collection}/${name}`;
      if (request.method === "POST" && url.searchParams.get("dryRun") === "All") return send(201, scenario.mutatePod ? scenario.mutatePod(structuredClone(body)) : { ...body, metadata: { ...body.metadata, uid: "dry-uid", resourceVersion: "1", creationTimestamp: "now", managedFields: [] } });
      if (request.method === "POST") { if (resources.has(keyName)) return send(409, { apiVersion: "v1", kind: "Status", reason: "AlreadyExists" }); const stored = { ...body, metadata: { ...body.metadata, uid: `uid-${serial}`, resourceVersion: String(serial++) } }; if (stored.kind === "Pod" && !stored.status) stored.status = { phase: "Pending" }; resources.set(keyName, stored); return send(201, stored); }
      if (request.method === "GET") { const stored = resources.get(keyName); return stored ? send(200, stored) : send(404, { apiVersion: "v1", kind: "Status", reason: "NotFound" }); }
      if (request.method === "PATCH") { const stored = resources.get(keyName); if (!stored) return send(404, { reason: "NotFound" }); const updated = { ...stored, ...body, metadata: { ...stored.metadata, ...body.metadata, resourceVersion: String(serial++) }, data: { ...stored.data, ...body.data } }; resources.set(keyName, updated); return send(200, updated); }
      if (request.method === "DELETE") { const stored = resources.get(keyName); if (!stored) return send(404, { reason: "NotFound" }); if (body?.preconditions?.uid && body.preconditions.uid !== stored.metadata.uid) return send(409, { reason: "Conflict" }); resources.delete(keyName); return send(200, { apiVersion: "v1", kind: "Status", status: "Success" }); }
      send(404, { reason: "NotFound" });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)); const address = server.address(); if (!address || typeof address === "string") throw new Error("fixture-address");
  return { serverUrl: `https://localhost:${address.port}/`, certificateAuthorityPem: readFileSync(cert, "utf8"), requests, close: async () => { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); rmSync(directory, { recursive: true, force: true }); } };
}

export function validKubernetesRelationship(): { configuration: KubernetesConfiguration; credentials: KubernetesCredentials } {
  return {
    configuration: { apiVersion: "v1", namespace: { mode: "existing", name: "tasks" }, podTemplate: { apiVersion: "v1", kind: "Pod", metadata: { labels: {}, annotations: {} }, spec: { restartPolicy: "Never", automountServiceAccountToken: false, nodeSelector: { "kubernetes.io/os": "linux", "kubernetes.io/arch": "amd64" }, containers: [{ name: "runner", image: "example.invalid/runner@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", resources: { requests: { cpu: "1", memory: "1Gi", "ephemeral-storage": "2Gi" }, limits: { cpu: "1", memory: "1Gi", "ephemeral-storage": "2Gi" } } }] } }, runnerContainerName: "runner", workspaceVolumeName: "workspace", workspace: { sizeLimit: "2Gi" }, delivery: { chunkBytes: 524288, maximumBundleBytes: 16777216 }, statusCarriage: { kind: "secret-chunks", chunkBytes: 524288, maximumOutputBytes: 1048576, commandPollMilliseconds: 100 }, carriage: { nodePath: "/usr/bin/node", shellPath: "/bin/sh", catPath: "/bin/cat", sha256Path: "/usr/bin/sha256sum", tarPath: "/bin/tar", workspaceRoot: "/workspace", inClusterApiUrl: "https://kubernetes.default.svc/", clusterCaConfigMapName: "kube-root-ca.crt", serviceAccountAudience: "kubernetes.default.svc", serviceAccountTokenExpirationSeconds: 3600 }, deletion: { gracePeriodSeconds: 10, propagationPolicy: "Foreground", commandGraceMilliseconds: 1000 }, api: { requestTimeoutMilliseconds: 5000, providerPollMilliseconds: 100, fieldManager: "sdlc-task-provider" } },
    credentials: { serverUrl: "https://localhost/", certificateAuthorityPem: "fixture-ca", tlsServerName: "localhost", authentication: { mode: "bearer-token", token: "fixture-token" } },
  };
}
export function validKubernetesDemand(overrides: Record<string, unknown> = {}): unknown { return { os: "linux", architecture: "amd64", resources: { requests: { cpu: "1", memory: "1Gi", ephemeralStorage: "2Gi" }, limits: { cpu: "1", memory: "1Gi", ephemeralStorage: "2Gi" }, gpu: { mode: "none" } }, ...overrides }; }
