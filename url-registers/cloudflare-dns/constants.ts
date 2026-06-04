export const RECORD_TYPE = {
  A: "A",
  AAAA: "AAAA",
  CNAME: "CNAME",
} as const;

export type RecordType = (typeof RECORD_TYPE)[keyof typeof RECORD_TYPE];

export const RECORD_TYPE_VALUES = [
  RECORD_TYPE.A,
  RECORD_TYPE.AAAA,
  RECORD_TYPE.CNAME,
] as const satisfies readonly RecordType[];

export const PROTOCOL = {
  HTTP: "http",
  HTTPS: "https",
} as const;

export type Protocol = (typeof PROTOCOL)[keyof typeof PROTOCOL];

export const DNS_MODE = {
  PLAIN: "plain",
  TLS: "tls",
  MTLS: "mtls",
} as const;

export type DnsMode = (typeof DNS_MODE)[keyof typeof DNS_MODE];

export const DEFAULT_PORT = {
  [PROTOCOL.HTTP]: 80,
  [PROTOCOL.HTTPS]: 443,
} as const satisfies Record<Protocol, number>;

// Cloudflare requires ttl=1 (automatic) whenever a record is proxied.
export const CF_TTL_AUTO = 1;

export const APEX_NAME = "@";
export const WILDCARD_NAME = "*";

export const LOG_PREFIX = "cloudflare-dns:";

export const RESOURCE_NAMES = {
  PROVIDER: "cf-dns-provider",
  APEX_SUFFIX: "apex",
  WILDCARD_SUFFIX: "wildcard",
  WORKER_DOMAIN: "worker-domain",
} as const;
