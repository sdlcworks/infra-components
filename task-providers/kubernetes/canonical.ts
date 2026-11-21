import { createHash } from "node:crypto";

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export function canonicalize(value: unknown): string {
  const visit = (item: unknown): Json => {
    if (item === null || typeof item === "string" || typeof item === "boolean") return item;
    if (typeof item === "number" && Number.isFinite(item)) return item;
    if (Array.isArray(item)) return item.map(visit);
    if (typeof item === "object") {
      const result: Record<string, Json> = {};
      for (const key of Object.keys(item as object).sort()) result[key] = visit((item as Record<string, unknown>)[key]);
      return result;
    }
    throw new Error("kubernetes-non-json-value");
  };
  return JSON.stringify(visit(value));
}

export function digest(value: unknown): string {
  return createHash("sha256").update(canonicalize(value), "utf8").digest("hex");
}

export function bytesDigest(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function clone<T>(value: T): T {
  return JSON.parse(canonicalize(value)) as T;
}
