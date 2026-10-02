import * as cloudflare from "@pulumi/cloudflare";

// The component grammar's lifecycle contexts carry credentials only through
// getCredentials(); no Pulumi provider instance is ever supplied. A realization
// that falls back to the default provider runs unauthenticated (legacy
// email+key auth with neither set), so every Cloudflare realization must
// construct its provider from the bound credential.
export function cloudflareProviderFromCredentials(
  name: string,
  getCredentials: () => unknown,
): cloudflare.Provider {
  const creds = (getCredentials() ?? {}) as { CLOUDFLARE_API_TOKEN?: string };
  if (!creds.CLOUDFLARE_API_TOKEN) {
    throw new Error(
      `${name}: CLOUDFLARE_API_TOKEN missing in bound credentials; the realization cannot authenticate against Cloudflare`,
    );
  }
  return new cloudflare.Provider(name, {
    apiToken: creds.CLOUDFLARE_API_TOKEN,
  });
}
