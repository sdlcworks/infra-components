import { z } from "zod";
import { RECORD_TYPE_VALUES } from "./constants";

export const RecordOverrideSchema = z.object({
  /** Subdomain label, "@" for apex, "*" for wildcard. Prefixed to the root domain. */
  name: z.string().min(1),
  /** Proxy the record through Cloudflare (orange cloud). Falls back to defaults.proxied. */
  proxied: z.boolean().optional(),
  /** Override auto-inferred record type (A/AAAA/CNAME). Auto-inferred from metadata.host otherwise. */
  type: z.enum(RECORD_TYPE_VALUES).optional(),
  /** TTL in seconds. Ignored when proxied (Cloudflare forces automatic). Falls back to defaults.ttl → CF_TTL_AUTO. */
  ttl: z.number().int().positive().optional(),
  /** Optional comment stored on the Cloudflare DNS record. */
  comment: z.string().optional(),
  /** Cloudflare Worker service name. When set, creates a WorkersCustomDomain instead of a DnsRecord. */
  service: z.string().min(1).optional(),
  /** Worker environment. Only meaningful when `service` is set. @deprecated Deprecated by Cloudflare. */
  environment: z.string().optional(),
});

export type RecordOverride = z.infer<typeof RecordOverrideSchema>;

export function isWorkerRecord(
  r: RecordOverride,
): r is RecordOverride & { service: string } {
  return r.service !== undefined;
}

export const DefaultsSchema = z
  .object({
    proxied: z.boolean().default(true),
    ttl: z.number().int().positive().optional(),
  })
  .default({ proxied: true });

export const ConfigSchema = z.object({
  /** Root domain whose Cloudflare zone we're managing (e.g. "gohashira.wtf"). */
  domain: z.string().min(1),
  defaults: DefaultsSchema,
  /**
   * Record config keyed by app component name (DNS records) or logical name (worker records).
   * If a record has `service`, it creates a WorkersCustomDomain; otherwise a DnsRecord.
   */
  records: z.record(z.string().min(1), RecordOverrideSchema),
});

export type Config = z.infer<typeof ConfigSchema>;
export type Defaults = z.infer<typeof DefaultsSchema>;
