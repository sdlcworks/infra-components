import { createSign } from "crypto";

/**
 * Mint a short-lived GCP OAuth2 access token from a service account JSON key
 * using the JWT bearer flow (RFC 7523).
 *
 * This avoids pulling in google-auth-library, which is not available in the
 * infra-components runtime. Uses Node.js built-in crypto for RSA-SHA256 signing.
 *
 * @param saKeyJson - The raw JSON string of a GCP service account key file
 * @returns A short-lived OAuth2 access token string
 */
export async function mintGcpAccessToken(saKeyJson: string): Promise<string> {
  const sa = JSON.parse(saKeyJson) as {
    client_email: string;
    private_key: string;
  };
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const claim = {
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/cloud-platform",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  };
  const b64url = (s: string | Buffer) =>
    (Buffer.isBuffer(s) ? s : Buffer.from(s))
      .toString("base64")
      .replace(/=+$/g, "")
      .replace(/\+/g, "-")
      .replace(/\//g, "_");
  const signingInput =
    `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claim))}`;
  const signer = createSign("RSA-SHA256");
  signer.update(signingInput);
  const signature = b64url(signer.sign(sa.private_key));
  const jwt = `${signingInput}.${signature}`;

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }).toString(),
  });
  if (!res.ok) {
    throw new Error(
      `gcp-helpers: GCP token mint failed (${res.status}): ${await res.text()}`,
    );
  }
  const json = (await res.json()) as { access_token?: string };
  if (!json.access_token) {
    throw new Error(
      `gcp-helpers: GCP token mint response missing access_token: ${JSON.stringify(json)}`,
    );
  }
  return json.access_token;
}

/**
 * Poll a Cloud Run v2 Long-Running Operation until it completes or times out.
 *
 * @param operationName - The full operation resource name (e.g. "projects/.../locations/.../operations/...")
 * @param accessToken - A valid GCP OAuth2 access token
 * @param timeoutMs - Maximum time to wait in ms (default: 5 minutes)
 */
export async function waitForCloudRunOperation(
  operationName: string,
  accessToken: string,
  timeoutMs = 5 * 60 * 1000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await fetch(
      `https://run.googleapis.com/v2/${operationName}`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    if (!res.ok) {
      throw new Error(
        `gcp-helpers: operation poll failed (${res.status}): ${await res.text()}`,
      );
    }
    const op = (await res.json()) as {
      done?: boolean;
      error?: { code?: number; message?: string };
    };
    if (op.done) {
      if (op.error) {
        throw new Error(
          `gcp-helpers: operation '${operationName}' failed: ${op.error.message ?? JSON.stringify(op.error)}`,
        );
      }
      return;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(
    `gcp-helpers: timed out waiting for operation '${operationName}' after ${timeoutMs}ms`,
  );
}
