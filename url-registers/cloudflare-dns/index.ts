import * as pulumi from "@pulumi/pulumi";
import * as cloudflare from "@pulumi/cloudflare";
import { URLRegister } from "@sdlcworks/components";
import { PublicCI } from "../../_internal/interfaces";
import { LOG_PREFIX } from "./constants";
import type { CloudCredentialCloudflare } from "@sdlcworks/components";
import { ConfigSchema, type Config, isWorkerRecord } from "./schema";
import {
  buildComponentResultUri,
  buildWorkerResultUri,
  createDnsRecord,
  createWorkerCustomDomain,
  resolveFqdn,
  resolveTtl,
  warnMissingComponents,
  type ComponentEntry,
} from "./provision";

const register = new URLRegister({
  interface: PublicCI,
  configSchema: ConfigSchema,
  provision: async (ctx) => {
    // The framework's InferZodType wraps every top-level config field in
    // PulumiInput<T> (to accept Outputs from upstream resolutions). In practice
    // the orchestrator resolves all $[[kv]] refs before calling provision, so
    // config values are concrete by the time we run. Cast once at the boundary.
    const config = ctx.config as unknown as Config;
    const { components, $ } = ctx;
    const creds = ctx.getCredentials() as CloudCredentialCloudflare;

    const results: Record<string, pulumi.Output<string>> = {};

    const provider = (ctx as any).cloudflare as cloudflare.Provider;
    const opts = { provider };

    const zone = cloudflare.getZoneOutput(
      { filter: { name: config.domain } },
      opts,
    );

    const seenFqdn = new Map<string, string>();

    // Partition records into DNS vs worker entries.
    const dnsRecords: Array<[string, typeof config.records[string]]> = [];
    const workerRecords: Array<
      [string, typeof config.records[string] & { service: string }]
    > = [];

    for (const [key, rcfg] of Object.entries(config.records)) {
      if (isWorkerRecord(rcfg)) {
        workerRecords.push([key, rcfg]);
      } else {
        dnsRecords.push([key, rcfg]);
      }
    }

    // --- DNS records (component-bound) ---
    const dnsRecordsByAppName = new Map(dnsRecords);
    const presentAppNames = new Set(Object.keys(components));
    warnMissingComponents(
      { ...config, records: Object.fromEntries(dnsRecords) },
      presentAppNames,
    );

    for (const [appName, { metadata }] of Object.entries(
      components as Record<string, ComponentEntry>,
    )) {
      const rcfg = dnsRecordsByAppName.get(appName);
      if (!rcfg) {
        console.warn(
          `${LOG_PREFIX} component '${appName}' has no record entry; skipping`,
        );
        continue;
      }

      if (!metadata.host) {
        console.error(
          `${LOG_PREFIX} component '${appName}' missing metadata.host; skipping`,
        );
        continue;
      }

      const fqdn = resolveFqdn(rcfg, config.domain);
      const previouslySeenBy = seenFqdn.get(fqdn);
      if (previouslySeenBy) {
        throw new Error(
          `${LOG_PREFIX} duplicate fqdn '${fqdn}' for '${appName}' and '${previouslySeenBy}'`,
        );
      }
      seenFqdn.set(fqdn, appName);

      const proxied = rcfg.proxied ?? config.defaults.proxied;
      const ttl = resolveTtl(rcfg, config.defaults, proxied);
      const host = pulumi.output(metadata.host) as pulumi.Output<string>;

      createDnsRecord({
        $,
        opts,
        zoneId: zone.zoneId,
        appName,
        rcfg,
        host,
        proxied,
        ttl,
      });

      results[appName] = buildComponentResultUri({
        appName,
        fqdn,
        proxied,
        metadata,
      });
    }

    // --- Worker records (config-driven, not component-bound) ---
    if (workerRecords.length > 0) {
      const accountId = creds.CLOUDFLARE_ACCOUNT_ID;
      if (!accountId) {
        throw new Error(
          `${LOG_PREFIX} CLOUDFLARE_ACCOUNT_ID is required in credentials when worker records are present (found ${workerRecords.length})`,
        );
      }

      for (const [key, rcfg] of workerRecords) {
        const fqdn = resolveFqdn(rcfg, config.domain);
        const previouslySeenBy = seenFqdn.get(fqdn);
        if (previouslySeenBy) {
          throw new Error(
            `${LOG_PREFIX} duplicate fqdn '${fqdn}' for worker record '${key}' and '${previouslySeenBy}'`,
          );
        }
        seenFqdn.set(fqdn, `worker:${key}`);

        createWorkerCustomDomain({
          $,
          opts,
          accountId,
          zoneId: zone.zoneId,
          key,
          rcfg,
          domain: config.domain,
        });

        results[key] = buildWorkerResultUri(fqdn);
      }
    }

    return results;
  },
});

export default register;
