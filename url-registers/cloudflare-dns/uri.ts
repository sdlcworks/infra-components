import * as pulumi from "@pulumi/pulumi";
import {
  DEFAULT_PORT,
  DNS_MODE,
  LOG_PREFIX,
  PROTOCOL,
  type Protocol,
} from "./constants";

/**
 * Subset of PublicCI result metadata this register actually reads.
 * Kept local to avoid coupling to the full PublicCI zod shape.
 */
export type PublicMetadata = {
  host: string;
  port?: number;
  protocol?: Protocol;
  mode?: "plain" | "tls" | "mtls";
};

export type AssembleResultUriArgs = {
  appName: string;
  fqdn: string;
  proxied: boolean;
  metadata: PublicMetadata;
};

export function pickScheme(metadata: PublicMetadata, proxied: boolean): Protocol {
  if (metadata.protocol) return metadata.protocol;
  if (metadata.mode === DNS_MODE.TLS || metadata.mode === DNS_MODE.MTLS) {
    return PROTOCOL.HTTPS;
  }
  return proxied ? PROTOCOL.HTTPS : PROTOCOL.HTTP;
}

export function pickPort(
  appName: string,
  port: number | undefined,
  scheme: Protocol,
  proxied: boolean,
): number | undefined {
  if (port === undefined) return undefined;
  const defaultForScheme = DEFAULT_PORT[scheme];

  if (proxied) {
    // Cloudflare proxy only exposes standard ports; a non-standard port on a
    // proxied record would advertise a URL clients can't actually reach.
    if (port !== defaultForScheme) {
      console.warn(
        `${LOG_PREFIX} component '${appName}' has metadata.port=${port} but record is proxied; dropping port from result URI (Cloudflare proxy only exposes ${defaultForScheme} for ${scheme}).`,
      );
    }
    return undefined;
  }

  return port === defaultForScheme ? undefined : port;
}

export function assembleResultUri({
  appName,
  fqdn,
  proxied,
  metadata,
}: AssembleResultUriArgs): pulumi.Output<string> {
  const scheme = pickScheme(metadata, proxied);
  const port = pickPort(appName, metadata.port, scheme, proxied);
  const uri = port === undefined ? `${scheme}://${fqdn}` : `${scheme}://${fqdn}:${port}`;
  return pulumi.output(uri);
}
