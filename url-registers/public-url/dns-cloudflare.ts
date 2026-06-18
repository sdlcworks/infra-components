import * as pulumi from "@pulumi/pulumi";
import * as cloudflare from "@pulumi/cloudflare";

// Cloudflare DNS surface for the public-url register. Two record kinds:
//
//   createCnameRecord — proxied or DNS-only CNAME pointing at a hostname
//                       (used for cloudflare-proxy mode; CNAME → *.run.app)
//
//   createARecord     — DNS-only A record pointing at a static IPv4
//                       (used for gcp-lb mode; A → GCP LB GlobalAddress IP)
//
// createWorkerHostRewrite — service-worker that rewrites url.hostname so
//   Cloudflare's upstream fetch hits the *.run.app origin with the correct
//   Host header. Required only for cloudflare-proxy mode where the origin
//   is Cloud Run and Google Front End rejects unknown Host values.

export interface CnameInputs {
  resourceName: string;
  zoneId: pulumi.Input<string>;
  fqdn: string;
  target: pulumi.Input<string>;
  proxied: boolean;
  provider: cloudflare.Provider;
}

export function createCnameRecord(inputs: CnameInputs): cloudflare.DnsRecord {
  const { resourceName, zoneId, fqdn, target, proxied, provider } = inputs;
  return new cloudflare.DnsRecord(
    resourceName,
    {
      zoneId,
      name: fqdn,
      type: "CNAME",
      content: target as pulumi.Input<string>,
      proxied,
      ttl: 1,
    },
    // deleteBeforeReplace: when type/proxied changes force a replacement,
    // Cloudflare rejects two records sharing the same hostname (error 81054).
    // Delete the old record first, then create the new one.
    { provider, deleteBeforeReplace: true },
  );
}

export interface ARecordInputs {
  resourceName: string;
  zoneId: pulumi.Input<string>;
  fqdn: string;
  ipAddress: pulumi.Input<string>;
  provider: cloudflare.Provider;
}

export function createARecord(inputs: ARecordInputs): cloudflare.DnsRecord {
  const { resourceName, zoneId, fqdn, ipAddress, provider } = inputs;
  return new cloudflare.DnsRecord(
    resourceName,
    {
      zoneId,
      name: fqdn,
      type: "A",
      content: ipAddress as pulumi.Input<string>,
      proxied: false,
      ttl: 1,
    },
    { provider, deleteBeforeReplace: true },
  );
}

export interface ProxiedRoute {
  appName: string;
  fqdn: string;
  originHost: pulumi.Output<string>;
}

// Cloud Run dispatches by Host at Google's frontend and rejects any name
// other than its assigned *.run.app. Free-tier Cloudflare blocks both
// Transform-Rules `headers.host` rewrite and Origin-Rules `host_header`
// override. Workers ARE free-tier — a tiny script proxies the request to
// the *.run.app URL, which makes Cloudflare's upstream call use the
// origin's expected Host (because we change url.hostname).
export function createWorkerHostRewrite(
  $: (literals: TemplateStringsArray, ...subs: any[]) => string,
  inputs: {
    accountId: string;
    zoneId: pulumi.Input<string>;
    routes: ProxiedRoute[];
    provider: cloudflare.Provider;
  },
): void {
  const { accountId, zoneId, routes, provider } = inputs;
  const opts = { provider };

  const allHosts = pulumi.all(routes.map((r) => r.originHost));
  const scriptContent = allHosts.apply((hosts) => {
    const routeMap: Record<string, string> = {};
    routes.forEach((r, i) => {
      routeMap[r.fqdn] = hosts[i];
    });
    return [
      'addEventListener("fetch", (event) => { event.respondWith(handle(event.request)); });',
      `const ROUTES = ${JSON.stringify(routeMap)};`,
      "async function handle(request) {",
      "  const url = new URL(request.url);",
      "  const target = ROUTES[url.hostname];",
      '  if (!target) return new Response("unknown host: " + url.hostname, { status: 404 });',
      "  url.hostname = target;",
      "  return fetch(new Request(url.toString(), request));",
      "}",
    ].join("\n");
  });

  const scriptName = pulumi.interpolate`url-register-host-rewrite-${zoneId}`;

  const worker = new cloudflare.WorkersScript(
    $`host-rewrite-script`,
    {
      accountId,
      scriptName,
      content: scriptContent,
      bodyPart: "worker.js",
    },
    opts,
  );

  for (const r of routes) {
    new cloudflare.WorkersRoute(
      $`route-${r.appName}`,
      {
        zoneId,
        pattern: `${r.fqdn}/*`,
        script: worker.scriptName,
      },
      opts,
    );
  }
}
