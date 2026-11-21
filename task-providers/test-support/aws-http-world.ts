import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { JSONValue } from "@sdlcworks/components/task";
import type { ScenarioWorld } from "../scenario";

export type WorldObservation = {
  requests: JSONValue[];
  effects: JSONValue;
  environmentCount: number;
};

type ScriptStep = ScenarioWorld["script"][number];

function bodyOf(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

function authorization(value: string | undefined): JSONValue {
  if (!value) return null;
  const match = /^(\S+) Credential=([^/]+)\/(\d{8})\/([^/]+)\/([^/]+)\/aws4_request, SignedHeaders=([^,]+), Signature=(.+)$/.exec(value);
  if (!match) return { malformed: true };
  return {
    algorithm: match[1]!, accessKeyId: match[2]!, date: match[3]!, region: match[4]!,
    service: match[5]!, signedHeaders: match[6]!.split(";"), signaturePresent: match[7]!.length > 0,
  };
}

function queryObject(parameters: URLSearchParams): JSONValue {
  const result: Record<string, JSONValue> = {};
  parameters.forEach((value, name) => {
    const existing = result[name];
    result[name] = existing === undefined ? value : Array.isArray(existing) ? [...existing, value] : [existing, value];
  });
  return result;
}

export function recordedRequestBody(bytes: Uint8Array): JSONValue {
  const buffer = Buffer.from(bytes);
  return { base64: buffer.toString("base64"), utf8: buffer.toString("utf8") };
}

function parseBody(bytes: Buffer, contentType: string): JSONValue {
  const text = bytes.toString("utf8");
  if (!text) return null;
  if (contentType.includes("json")) {
    try { return JSON.parse(text) as JSONValue; } catch { return { malformed: text }; }
  }
  if (contentType.includes("x-www-form-urlencoded")) return queryObject(new URLSearchParams(text));
  return recordedRequestBody(bytes);
}

function operation(request: IncomingMessage, url: URL, body: JSONValue): string {
  const target = request.headers["x-amz-target"];
  if (typeof target === "string") { const parts = target.split("."); return parts[parts.length - 1]!; }
  if (body && typeof body === "object" && !Array.isArray(body) && typeof body.Action === "string") return body.Action;
  if (url.pathname.startsWith("/2015-03-31/functions/")) {
    if (url.pathname.endsWith("/configuration")) return "GetFunctionConfiguration";
    if (url.pathname.endsWith("/event-invoke-config")) return "GetFunctionEventInvokeConfig";
    if (url.pathname.endsWith("/invocations")) return "Invoke";
  }
  if (request.method === "PUT") return "PutObject";
  if (request.method === "GET" && url.searchParams.get("list-type") === "2") return "ListObjectsV2";
  if (request.method === "GET") return "GetObject";
  return `${request.method ?? "UNKNOWN"} ${url.pathname}`;
}

function applyEffect(current: JSONValue, effect: unknown): JSONValue {
  if (effect === null || typeof effect !== "object" || Array.isArray(effect)) return effect as JSONValue;
  if (current === null || typeof current !== "object" || Array.isArray(current)) return structuredClone(effect) as JSONValue;
  return { ...current, ...(structuredClone(effect) as Record<string, JSONValue>) };
}

function send(step: ScriptStep, response: ServerResponse): void {
  const scripted = step.response;
  if (scripted.kind === "connection-loss") { response.destroy(); return; }
  response.statusCode = scripted.status;
  for (const [name, value] of Object.entries(scripted.headers)) {
    if (typeof value !== "string") throw new Error(`unresolved-script-header:${name}`);
    response.setHeader(name, value);
  }
  if (scripted.kind === "service-error") response.setHeader("x-amzn-errortype", scripted.code);
  const body = scripted.body;
  response.end(typeof body === "string" ? body : JSON.stringify(body));
}

export async function startAwsHttpWorld(world: ScenarioWorld): Promise<{
  bindings: Record<string, string>;
  observation(): WorldObservation;
  close(): Promise<void>;
}> {
  if (world.kind !== "aws-http") throw new Error("aws-world-kind-refused");
  let cursor = 0;
  let effects = structuredClone(world.initialState) as JSONValue;
  const requests: JSONValue[] = [];
  const environments = new Set<string>();
  const server = createServer(async (request, response) => {
    const step = world.script[cursor++];
    if (!step) { response.statusCode = 500; response.end("unscripted-request"); return; }
    const url = new URL(request.url ?? "/", "http://localhost");
    const bytes = await bodyOf(request);
    const decoded = parseBody(bytes, String(request.headers["content-type"] ?? ""));
    const op = operation(request, url, decoded);
    const record: Record<string, JSONValue> = {
      operation: op, method: request.method ?? null, path: url.pathname, query: queryObject(url.searchParams), body: decoded,
      authorization: authorization(typeof request.headers.authorization === "string" ? request.headers.authorization : undefined),
      signingDate: String(request.headers["x-amz-date"] ?? ""),
      conditional: { ifNoneMatch: request.headers["if-none-match"] ?? null },
      metadata: Object.fromEntries(Object.entries(request.headers).filter(([name]) => name.startsWith("x-amz-meta-")).map(([name, value]) => [name, String(value)])),
    };
    requests.push(record);
    const id = request.headers["x-amz-client-token"] ?? (decoded && typeof decoded === "object" && !Array.isArray(decoded) ? decoded.idempotencyToken ?? decoded.ClientToken ?? decoded.clientToken : undefined);
    if (typeof id === "string" && ["RunInstances", "Invoke", "StartBuild"].includes(op)) environments.add(id);
    effects = applyEffect(effects, step.externalEffect);
    if (step.response.kind === "connection-loss" && step.response.phase === "after-apply") effects = applyEffect(effects, step.response.appliedEffect);
    send(step, response);
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address() as AddressInfo;
  return {
    bindings: { "aws-http-root": `http://127.0.0.1:${address.port}` },
    observation: () => ({ requests: structuredClone(requests), effects: structuredClone(effects), environmentCount: environments.size }),
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}
