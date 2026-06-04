import { z } from "zod";

import { CloudProvider, InfraComponent } from "@sdlcworks/components";

import * as gcp from "@pulumi/gcp";

// ---- Zod Enums for Config Options ----

const LoadBalancingScheme = z.enum(["EXTERNAL", "EXTERNAL_MANAGED"]);

const Protocol = z.enum(["HTTP", "HTTPS", "BOTH"]);

const IpVersion = z.enum(["IPV4", "IPV6"]);

const NetworkTier = z.enum(["PREMIUM", "STANDARD"]);

// ---- Reusable Schema Definitions ----

const PathRuleSchema = z.object({
  paths: z.array(z.string()),
  backendServiceId: z.string(),
});

const PathMatcherSchema = z.object({
  name: z.string(),
  defaultBackendServiceId: z.string(),
  pathRules: z.array(PathRuleSchema).optional(),
});

const HostRuleSchema = z.object({
  hosts: z.array(z.string()),
  pathMatcher: z.string(),
});

const SslCertConfigSchema = z.object({
  managed: z.boolean().default(true),
  domains: z.array(z.string()).optional(),
  certificateIds: z.array(z.string()).optional(),
});

// ---- Component Definition ----

const component = new InfraComponent({
  metadata: {
    stateful: false,
    proxiable: false,
  },
  connectionTypes: {},
  configSchema: z.object({
    // Core
    protocol: Protocol.default("HTTPS"),
    loadBalancingScheme: LoadBalancingScheme.default("EXTERNAL_MANAGED"),

    // Backends
    defaultBackendServiceId: z.string(),

    // URL Routing (optional)
    pathMatchers: z.array(PathMatcherSchema).optional(),
    hostRules: z.array(HostRuleSchema).optional(),

    // SSL Configuration
    sslConfig: SslCertConfigSchema.optional(),

    // Network Configuration
    enableHttpToHttpsRedirect: z.boolean().default(false),
    reserveStaticIp: z.boolean().default(true),
    ipVersion: IpVersion.default("IPV4"),
    networkTier: NetworkTier.default("PREMIUM"),

    // Port Configuration
    httpsPort: z.number().default(443),
    httpPort: z.number().default(80),
  }),
  appComponentTypes: {},
  outputSchema: z.object({
    // Load Balancer
    urlMapId: z.string(),
    urlMapSelfLink: z.string(),

    // Proxies
    httpsProxyId: z.string().optional(),
    httpProxyId: z.string().optional(),

    // Forwarding Rules
    httpsForwardingRuleId: z.string().optional(),
    httpForwardingRuleId: z.string().optional(),

    // IP Address
    ipAddress: z.string(),
    ipAddressId: z.string().optional(),

    // SSL Certificates
    managedSslCertIds: z.array(z.string()).optional(),
  }),
});

// ---- GCloud Provider Implementation ----

component.implement(CloudProvider.gcloud, {
  pulumi: async ({ $, inputs }) => {
    const {
      protocol,
      loadBalancingScheme,
      defaultBackendServiceId,
      pathMatchers,
      hostRules,
      sslConfig,
      enableHttpToHttpsRedirect,
      reserveStaticIp,
      ipVersion,
      networkTier,
      httpsPort,
      httpPort,
    } = inputs;

    // 1. Create managed SSL certificates if needed
    const managedCerts: gcp.compute.ManagedSslCertificate[] = [];
    if (protocol !== "HTTP" && sslConfig?.managed && sslConfig.domains) {
      for (const domain of sslConfig.domains) {
        const cert = new gcp.compute.ManagedSslCertificate(
          $`ssl-cert-${domain.replace(/[^a-zA-Z0-9]/g, "-")}`,
          {
            managed: { domains: [domain] },
            description: "Managed SSL certificate by sdlc.works",
          }
        );
        managedCerts.push(cert);
      }
    }

    // 2. Create URL Map with routing rules
    const urlMap = new gcp.compute.URLMap($`url-map`, {
      defaultService: defaultBackendServiceId,
      pathMatchers: pathMatchers?.map((pm) => ({
        name: pm.name,
        defaultService: pm.defaultBackendServiceId,
        pathRules: pm.pathRules?.map((pr) => ({
          paths: pr.paths,
          service: pr.backendServiceId,
        })),
      })),
      hostRules: hostRules?.map((hr) => ({
        hosts: hr.hosts,
        pathMatcher: hr.pathMatcher,
      })),
      description: "URL map managed by sdlc.works",
    });

    // 3. Create target proxies based on protocol
    let httpsProxy: gcp.compute.TargetHttpsProxy | undefined;
    let httpProxy: gcp.compute.TargetHttpProxy | undefined;

    if (protocol === "HTTPS" || protocol === "BOTH") {
      const certRefs =
        managedCerts.length > 0
          ? managedCerts.map((c) => c.id)
          : sslConfig?.certificateIds || [];

      httpsProxy = new gcp.compute.TargetHttpsProxy($`https-proxy`, {
        urlMap: urlMap.id,
        sslCertificates: certRefs,
        description: "HTTPS proxy managed by sdlc.works",
      });
    }

    if (protocol === "HTTP" || protocol === "BOTH") {
      httpProxy = new gcp.compute.TargetHttpProxy($`http-proxy`, {
        urlMap: urlMap.id,
        description: "HTTP proxy managed by sdlc.works",
      });
    }

    // 4. Create static IP if requested
    let staticIp: gcp.compute.GlobalAddress | undefined;
    if (reserveStaticIp) {
      staticIp = new gcp.compute.GlobalAddress($`ip`, {
        ipVersion: ipVersion,
        networkTier: networkTier,
        description: "Static IP managed by sdlc.works",
      });
    }

    // 5. Create forwarding rules
    let httpsForwardingRule: gcp.compute.GlobalForwardingRule | undefined;
    let httpForwardingRule: gcp.compute.GlobalForwardingRule | undefined;

    if (httpsProxy) {
      httpsForwardingRule = new gcp.compute.GlobalForwardingRule(
        $`https-forwarding-rule`,
        {
          target: httpsProxy.id,
          portRange: httpsPort.toString(),
          ipAddress: staticIp?.address,
          loadBalancingScheme: loadBalancingScheme,
          networkTier: networkTier,
        }
      );
    }

    if (httpProxy) {
      httpForwardingRule = new gcp.compute.GlobalForwardingRule(
        $`http-forwarding-rule`,
        {
          target: httpProxy.id,
          portRange: httpPort.toString(),
          ipAddress: staticIp?.address,
          loadBalancingScheme: loadBalancingScheme,
          networkTier: networkTier,
        }
      );
    }

    return {
      urlMapId: urlMap.id,
      urlMapSelfLink: urlMap.selfLink,
      httpsProxyId: httpsProxy?.id,
      httpProxyId: httpProxy?.id,
      httpsForwardingRuleId: httpsForwardingRule?.id,
      httpForwardingRuleId: httpForwardingRule?.id,
      ipAddress:
        staticIp?.address ||
        httpsForwardingRule?.ipAddress ||
        httpForwardingRule?.ipAddress,
      ipAddressId: staticIp?.id,
      managedSslCertIds: managedCerts.map((c) => c.id),
    };
  },
});

export default component;
