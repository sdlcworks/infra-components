import * as pulumi from "@pulumi/pulumi";
import * as cloudflare from "@pulumi/cloudflare";
import * as gcp from "@pulumi/gcp";
import { z } from "zod";
import { URLRegister } from "@sdlcworks/components";
import { PublicCI } from "../../_internal/interfaces";
import {
  createARecord,
  createCnameRecord,
  createWorkerHostRewrite,
  type ProxiedRoute,
} from "./dns-cloudflare";
import { provisionGcpLb } from "./ingress-gcp";

// Single URL register that owns the co-required invariant: a public hostname
// is BOTH published in DNS AND accepted by the backend's ingress. Splitting
// these legs across registers creates silent half-binding bugs (the exact
// failure mode that motivated this register's gcp-lb mode in the first place).
//
// Per-record dispatch by mode:
//   cloudflare-proxy — orange-cloud Cloudflare CNAME + Worker host rewrite
//                      to *.run.app. Lightweight; appropriate when the
//                      backend doesn't construct absolute URLs from
//                      request.url (so Host translation is invisible).
//   gcp-lb           — GCP Global External HTTPS LB + Serverless NEG, with a
//                      DNS-only Cloudflare A record pointing at the LB's
//                      static IP. Preserves the original Host end-to-end.
//                      Required when the backend's server-side code uses
//                      request.url to build absolute URLs (e.g. Astro+Clerk).

const RecordSchema = z.object({
  name: z.string().min(1),
  mode: z.enum(["cloudflare-proxy", "gcp-lb"]).default("cloudflare-proxy"),
});

// gcp-lb mode requires GCP creds. The framework's URL register substrate is
// single-cloud-per-mapping (provider_mapping.url_registers.<key> binds one
// cloud's creds + provider). This register's mapping is "cloudflare", so GCP
// creds cannot ride that channel — they come through config (KV literals).
// Sa key sits with other project secrets (clerk_secret_key, postgres_password,
// paddle_api_key) — same trust class.
const GcpConfigSchema = z.object({
  projectId: z.string().min(1),
  serviceAccountKey: z.string().min(1),
});

const ConfigSchema = z.object({
  domain: z.string().min(1),
  records: z.record(z.string().min(1), RecordSchema),
  gcp: GcpConfigSchema.optional(),
});

type Config = z.infer<typeof ConfigSchema>;

const register = new URLRegister({
  interface: PublicCI,
  configSchema: ConfigSchema,
  provision: async (ctx) => {
    const config = ctx.config as unknown as Config;
    const { components, $ } = ctx;

    const cfProvider = (ctx as any).cloudflare as cloudflare.Provider;
    const cfCreds = ctx.getCredentials() as { CLOUDFLARE_ACCOUNT_ID?: string };
    const accountId = cfCreds.CLOUDFLARE_ACCOUNT_ID;
    if (!accountId) {
      throw new Error(
        "public-url: CLOUDFLARE_ACCOUNT_ID missing in credentials",
      );
    }

    const zone = cloudflare.getZoneOutput(
      { filter: { name: config.domain } },
      { provider: cfProvider },
    );

    // GCP provider needed only if any record is gcp-lb mode. Constructed
    // manually from config (KV-supplied projectId + serviceAccountKey) because
    // the framework's URL register cred bag is single-cloud (cloudflare here).
    const needsGcp = Object.values(config.records).some(
      (r) => r.mode === "gcp-lb",
    );
    let gcpProvider: gcp.Provider | undefined;
    if (needsGcp) {
      if (!config.gcp) {
        throw new Error(
          "public-url: at least one record uses mode=gcp-lb but config.gcp is missing. " +
            "Add `gcp: { projectId, serviceAccountKey }` under urls.public.config in the TSC, " +
            "and ensure `gcp_service_account_key` is set in this branch's KV.",
        );
      }
      gcpProvider = new gcp.Provider(
        $`gcp-prov`,
        {
          project: config.gcp.projectId,
          credentials: config.gcp.serviceAccountKey,
        },
      );
    }

    const results: Record<string, pulumi.Output<string>> = {};
    const proxiedRoutes: ProxiedRoute[] = [];

    for (const [appName, rcfg] of Object.entries(config.records)) {
      const entry = (components as Record<string, any>)[appName];
      if (!entry || !entry.metadata?.host) {
        throw new Error(
          `public-url: record '${appName}' has no matching component with PublicCI.metadata.host (config bug)`,
        );
      }

      const fqdn = `${rcfg.name}.${config.domain}`;
      const originHost = pulumi.output(entry.metadata.host) as pulumi.Output<string>;

      if (rcfg.mode === "cloudflare-proxy") {
        createCnameRecord({
          resourceName: $`dns-${appName}`,
          zoneId: zone.zoneId,
          fqdn,
          target: originHost,
          proxied: true,
          provider: cfProvider,
        });
        proxiedRoutes.push({ appName, fqdn, originHost });
        results[appName] = pulumi.interpolate`https://${fqdn}`;
        continue;
      }

      // gcp-lb mode — needs serviceName + region from PublicCI metadata.
      const serviceName = entry.metadata.serviceName as pulumi.Input<string>;
      const region = entry.metadata.region as string;
      if (!serviceName || !region) {
        throw new Error(
          `public-url: record '${appName}' is mode=gcp-lb but its PublicCI metadata is missing serviceName/region — is the backend a Cloud Run http-service?`,
        );
      }

      const lb = provisionGcpLb($, {
        resourceNamePrefix: appName,
        fqdn,
        serviceName,
        region,
        provider: gcpProvider!,
      });

      createARecord({
        resourceName: $`dns-${appName}`,
        zoneId: zone.zoneId,
        fqdn,
        ipAddress: lb.ipAddress,
        provider: cfProvider,
      });

      results[appName] = lb.publicUrl;
    }

    if (proxiedRoutes.length > 0) {
      createWorkerHostRewrite($, {
        accountId,
        zoneId: zone.zoneId,
        routes: proxiedRoutes,
        provider: cfProvider,
      });
    }

    return results;
  },
});

export default register;
