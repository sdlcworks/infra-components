import https from "node:https";
import { taskProviderLostAnswer, taskProviderRefusal, type TaskProviderLostAnswer, type TaskProviderRefusal } from "@sdlcworks/components/task";
import type { KubernetesConfiguration, KubernetesCredentials } from "./schemas";

export type KubernetesResponse<T> = { statusCode: number; headers: Record<string, string>; body: T };
export class KubernetesClientError extends Error {
  constructor(readonly result: TaskProviderRefusal | TaskProviderLostAnswer) { super(result.kind); }
}

export class KubernetesApiClient {
  constructor(private credentials: KubernetesCredentials, private configuration: KubernetesConfiguration) {}
  request<T>(input: { method: "GET" | "POST" | "PATCH" | "DELETE"; path: string; query: Record<string, string>; body: unknown | null; contentType: string | null; expectedStatusCodes: number[] }): Promise<KubernetesResponse<T>> {
    const base = new URL(this.credentials.serverUrl);
    const query = new URLSearchParams(input.query).toString();
    const payload = input.body === null ? null : Buffer.from(JSON.stringify(input.body));
    return new Promise((resolve, reject) => {
      let wrote = false;
      const request = https.request({
        protocol: "https:", hostname: base.hostname, port: base.port || 443, path: `${input.path}${query ? `?${query}` : ""}`,
        method: input.method, ca: this.credentials.certificateAuthorityPem, servername: this.credentials.tlsServerName,
        cert: this.credentials.authentication.mode === "client-certificate" ? this.credentials.authentication.certificatePem : undefined,
        key: this.credentials.authentication.mode === "client-certificate" ? this.credentials.authentication.privateKeyPem : undefined,
        headers: { accept: "application/json", ...(input.contentType ? { "content-type": input.contentType } : {}), ...(payload ? { "content-length": String(payload.length) } : {}), ...(this.credentials.authentication.mode === "bearer-token" ? { authorization: `Bearer ${this.credentials.authentication.token}` } : {}) },
        agent: false, timeout: this.configuration.api.requestTimeoutMilliseconds,
      }, (response) => {
        const chunks: Buffer[] = []; let size = 0;
        response.on("data", (chunk: Buffer) => { size += chunk.length; if (size > 4 * 1024 * 1024) request.destroy(new Error("response-too-large")); else chunks.push(chunk); });
        response.on("end", () => {
          const code = response.statusCode ?? 0;
          let body: any;
          try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return reject(new KubernetesClientError(taskProviderRefusal("kubernetes-malformed-json", { operation: input.method, statusCode: code }))); }
          if (code >= 300 && code < 400) return reject(new KubernetesClientError(taskProviderRefusal("kubernetes-redirect-refused", { operation: input.method, statusCode: code })));
          if (!input.expectedStatusCodes.includes(code)) {
            const reason = typeof body?.reason === "string" ? body.reason : null;
            const name = code === 401 || code === 403 ? "kubernetes-access-denied" : code === 404 ? "kubernetes-not-found" : code === 409 ? "kubernetes-conflict" : code === 429 ? "kubernetes-throttled" : code >= 500 ? "kubernetes-server-error" : "kubernetes-unexpected-response";
            return reject(new KubernetesClientError(taskProviderRefusal(name, { operation: input.method, statusCode: code, reason })));
          }
          const headers: Record<string, string> = {};
          for (const [key, value] of Object.entries(response.headers)) if (typeof value === "string") headers[key] = value;
          resolve({ statusCode: code, headers, body });
        });
      });
      request.on("timeout", () => request.destroy(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" })));
      request.on("error", (error: NodeJS.ErrnoException) => reject(new KubernetesClientError(taskProviderLostAnswer(`${input.method} ${input.path}`, { reason: error.code === "ETIMEDOUT" ? "timeout" : "connection-reset", requestBodyWritten: wrote }))));
      if (payload) { wrote = true; request.write(payload); }
      request.end();
    });
  }
}
