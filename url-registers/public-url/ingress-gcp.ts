import * as pulumi from "@pulumi/pulumi";
import * as gcp from "@pulumi/gcp";
import { createHash } from "crypto";

// Provisions a Global External HTTPS Application Load Balancer in front of a
// Cloud Run service via a Serverless Network Endpoint Group. This is Google's
// documented production path for custom domains on Cloud Run — Cloud Run's
// native domain mapping is preview-only and not recommended for production
// (see: cloud.google.com/run/docs/mapping-custom-domains).
//
// Why it fixes the dual-identity bug: the LB routes via URL Map, not by Host
// header. The original Host (e.g. app.dezite.com) is preserved end-to-end into
// the Cloud Run container. Astro's request.url then carries the public host,
// and Clerk's server-side redirect_url is constructed correctly.
//
// Provisioned resources, per record:
//   GlobalAddress → ManagedSslCertificate → RegionNetworkEndpointGroup
//   → BackendService → URLMap → TargetHttpsProxy → GlobalForwardingRule
export interface GcpLbInputs {
  resourceNamePrefix: pulumi.Input<string>;
  fqdn: string;
  serviceName: pulumi.Input<string>;
  region: string;
  provider: gcp.Provider;
}

export interface GcpLbOutputs {
  ipAddress: pulumi.Output<string>;
  publicUrl: pulumi.Output<string>;
}

// Sanitize a string for use as a GCP resource name (DNS-1123: lowercase
// alphanumeric + hyphens, max 63 chars).
function sanitize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 63);
}

// Short, deterministic hash of an FQDN. Used to disambiguate GCP resource
// names that would otherwise collide after sanitize() — e.g.
// "app-qa.dezite.com" and "app.qa.dezite.com" both sanitize to
// "app-qa-dezite-com", which causes a 409 when Pulumi tries to replace a
// ManagedSslCertificate (whose `managed.domains` is immutable, forcing
// create-then-delete with the same name). Including this hash in the cert's
// GCP `name` field makes the new cert distinct from the old, so the replace
// completes cleanly.
function fqdnHash(fqdn: string): string {
  return createHash("sha256").update(fqdn).digest("hex").slice(0, 6);
}

export function provisionGcpLb(
  $: (literals: TemplateStringsArray, ...subs: any[]) => string,
  inputs: GcpLbInputs,
): GcpLbOutputs {
  const { fqdn, serviceName, region, provider } = inputs;
  const opts = { provider };
  const baseName = sanitize(fqdn);

  const address = new gcp.compute.GlobalAddress(
    $`lb-address-${baseName}`,
    { name: `${baseName}-ip`, addressType: "EXTERNAL" },
    opts,
  );

  const cert = new gcp.compute.ManagedSslCertificate(
    $`lb-cert-${baseName}`,
    {
      name: `${baseName}-${fqdnHash(fqdn)}-cert`,
      managed: { domains: [fqdn] },
    },
    opts,
  );

  const neg = new gcp.compute.RegionNetworkEndpointGroup(
    $`lb-neg-${baseName}`,
    {
      name: `${baseName}-neg`,
      region,
      networkEndpointType: "SERVERLESS",
      cloudRun: { service: serviceName },
    },
    opts,
  );

  const backendService = new gcp.compute.BackendService(
    $`lb-backend-${baseName}`,
    {
      name: `${baseName}-backend`,
      protocol: "HTTPS",
      loadBalancingScheme: "EXTERNAL_MANAGED",
      backends: [{ group: neg.id }],
    },
    opts,
  );

  const urlMap = new gcp.compute.URLMap(
    $`lb-urlmap-${baseName}`,
    {
      name: `${baseName}-urlmap`,
      defaultService: backendService.id,
    },
    opts,
  );

  const httpsProxy = new gcp.compute.TargetHttpsProxy(
    $`lb-proxy-${baseName}`,
    {
      name: `${baseName}-proxy`,
      urlMap: urlMap.id,
      sslCertificates: [cert.id],
    },
    opts,
  );

  new gcp.compute.GlobalForwardingRule(
    $`lb-fwd-${baseName}`,
    {
      name: `${baseName}-fwd`,
      ipAddress: address.address,
      target: httpsProxy.id,
      portRange: "443",
      loadBalancingScheme: "EXTERNAL_MANAGED",
    },
    opts,
  );

  return {
    ipAddress: address.address,
    publicUrl: pulumi.interpolate`https://${fqdn}`,
  };
}
