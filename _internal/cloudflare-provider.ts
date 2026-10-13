import * as cloudflare from "@pulumi/cloudflare";
import type * as pulumi from "@pulumi/pulumi";

export function cloudflareProviderFromCredentials(
  name: string,
  getCredentials: () => unknown,
  opts?: pulumi.CustomResourceOptions,
): cloudflare.Provider {
  const creds = (getCredentials() ?? {}) as { CLOUDFLARE_API_TOKEN?: string };
  if (!creds.CLOUDFLARE_API_TOKEN) {
    throw new Error(
      `${name}: CLOUDFLARE_API_TOKEN missing in bound credentials; the realization cannot authenticate against Cloudflare`,
    );
  }
  return new cloudflare.Provider(
    name,
    { apiToken: creds.CLOUDFLARE_API_TOKEN },
    opts,
  );
}
