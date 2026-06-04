import * as pulumi from "@pulumi/pulumi";
import * as cloudflare from "@pulumi/cloudflare";
import {
  APEX_NAME,
  CF_TTL_AUTO,
  LOG_PREFIX,
  RESOURCE_NAMES,
  WILDCARD_NAME,
} from "./constants";
import type { Config, Defaults, RecordOverride } from "./schema";
import { PROTOCOL } from "./constants";
import { inferRecordType } from "./dns";
import { assembleResultUri, type PublicMetadata } from "./uri";

export type NamingFn = {
  (name: string, ...values: unknown[]): string;
  (strings: TemplateStringsArray, ...values: unknown[]): string;
};

export type RawMetadata = {
  host?: pulumi.Input<string>;
  port?: pulumi.Input<number | undefined>;
  protocol?: pulumi.Input<PublicMetadata["protocol"] | undefined>;
  mode?: pulumi.Input<PublicMetadata["mode"] | undefined>;
  [k: string]: unknown;
};

export type ComponentEntry = {
  uri: string;
  metadata: RawMetadata;
};

export function warnMissingComponents(
  config: Config,
  present: Set<string>,
): void {
  for (const appName of Object.keys(config.records)) {
    if (!present.has(appName)) {
      console.warn(
        `${LOG_PREFIX} records.${appName} has no matching PublicCI component; skipping`,
      );
    }
  }
}

export function resolveFqdn(rcfg: { name: string }, domain: string): string {
  return rcfg.name === APEX_NAME ? domain : `${rcfg.name}.${domain}`;
}

export function sanitizeSubdomainForResourceName(subdomain: string): string {
  if (subdomain === APEX_NAME) return RESOURCE_NAMES.APEX_SUFFIX;
  if (subdomain === WILDCARD_NAME) return RESOURCE_NAMES.WILDCARD_SUFFIX;
  return subdomain.replace(/[^a-z0-9]/gi, "-");
}

export function resolveTtl(
  rcfg: RecordOverride,
  defaults: Defaults,
  proxied: boolean,
): number {
  if (proxied) return CF_TTL_AUTO;
  return rcfg.ttl ?? defaults.ttl ?? CF_TTL_AUTO;
}

export type CreateRecordArgs = {
  $: NamingFn;
  opts: { provider: cloudflare.Provider };
  zoneId: pulumi.Input<string>;
  appName: string;
  rcfg: RecordOverride;
  host: pulumi.Output<string>;
  proxied: boolean;
  ttl: number;
};

export function createDnsRecord({
  $,
  opts,
  zoneId,
  appName,
  rcfg,
  host,
  proxied,
  ttl,
}: CreateRecordArgs): void {
  const recordType: pulumi.Input<string> = rcfg.type
    ? rcfg.type
    : host.apply(inferRecordType);

  const resourceKey = sanitizeSubdomainForResourceName(rcfg.name);

  const args: cloudflare.DnsRecordArgs = {
    zoneId,
    name: rcfg.name,
    type: recordType,
    content: host,
    proxied,
    ttl,
    ...(rcfg.comment !== undefined ? { comment: rcfg.comment } : {}),
  };

  new cloudflare.DnsRecord($`dns-${appName}-${resourceKey}`, args, opts);
}

export type BuildResultArgs = {
  appName: string;
  fqdn: string;
  proxied: boolean;
  metadata: RawMetadata;
};

export function buildComponentResultUri({
  appName,
  fqdn,
  proxied,
  metadata,
}: BuildResultArgs): pulumi.Output<string> {
  return pulumi
    .all([
      pulumi.output(metadata.host) as pulumi.Output<string>,
      pulumi.output(metadata.port) as pulumi.Output<number | undefined>,
      pulumi.output(metadata.protocol) as pulumi.Output<
        PublicMetadata["protocol"]
      >,
      pulumi.output(metadata.mode) as pulumi.Output<PublicMetadata["mode"]>,
    ])
    .apply(([host, port, protocol, mode]) =>
      assembleResultUri({
        appName,
        fqdn,
        proxied,
        metadata: { host, port, protocol, mode },
      }),
    ) as pulumi.Output<string>;
}

export type CreateWorkerDomainArgs = {
  $: NamingFn;
  opts: { provider: cloudflare.Provider };
  accountId: string;
  zoneId: pulumi.Input<string>;
  key: string;
  rcfg: RecordOverride & { service: string };
  domain: string;
};

export function createWorkerCustomDomain({
  $,
  opts,
  accountId,
  zoneId,
  key,
  rcfg,
  domain,
}: CreateWorkerDomainArgs): void {
  const fqdn = resolveFqdn(rcfg, domain);
  const resourceKey = sanitizeSubdomainForResourceName(rcfg.name);

  const args: cloudflare.WorkersCustomDomainArgs = {
    accountId,
    zoneId,
    hostname: fqdn,
    service: rcfg.service,
    ...(rcfg.environment !== undefined
      ? { environment: rcfg.environment }
      : {}),
  };

  new cloudflare.WorkersCustomDomain(
    $`${RESOURCE_NAMES.WORKER_DOMAIN}-${key}-${resourceKey}`,
    args,
    opts,
  );
}

export function buildWorkerResultUri(fqdn: string): pulumi.Output<string> {
  return pulumi.output(`${PROTOCOL.HTTPS}://${fqdn}`);
}
