import { z } from "zod";

// The declared vocabulary for one workload ingress rule, and the two pure
// derivations over it.
//
// This lives beside `index.ts` rather than inside it so the vocabulary can be
// exercised without importing the component module, whose Pulumi imports run
// V8-intrinsic setup that the test runtime cannot host.

// Ingress rule definition for Deployment workloads.
//
// Beyond host/path, a rule may claim transport-envelope facts (method class,
// header acceptance). Facts within one rule compose by AND; rules compose by
// OR. When two components claim one host, `precedence` makes the composition
// deterministic (higher wins) instead of order-dependent.
export const IngressEnvelopeMatchSchema = z
  .object({
    methods: z
      .array(z.enum(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]))
      .min(1)
      .optional()
      .describe("Envelope fact: the request-method class this rule claims"),
    acceptContains: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Envelope fact: claims requests whose Accept header contains this media type",
      ),
  })
  .refine((m) => m.methods !== undefined || m.acceptContains !== undefined, {
    message: "an envelope match must state at least one envelope fact",
  });

export const IngressRuleSchema = z
  .object({
    host: z.string().describe("Hostname, e.g. api.example.com"),
    path: z.string().default("/"),
    pathType: z
      .enum(["Prefix", "Exact", "ImplementationSpecific"])
      .default("Prefix"),
    // Override the service port for this specific rule; defaults to servicePort.
    servicePort: z.number().optional(),
    match: IngressEnvelopeMatchSchema.optional(),
    precedence: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe(
        "Deterministic cross-component composition on a shared host: higher precedence wins (materialized as router priority)",
      ),
    publicTrust: z
      .boolean()
      .default(false)
      .describe(
        "Publicly-verifiable transport trust for this rule, materialized by the cluster edge via ACME (gcloud realization; requires cluster acmeContact). Serves on TLS with an HTTP→HTTPS redirect.",
      ),
  })
  .refine((r) => r.match === undefined || r.precedence !== undefined, {
    message: "a rule with an envelope match must declare an explicit precedence",
  });

// A rule with envelope facts, explicit precedence, or public trust exceeds the
// networking.k8s.io/v1 Ingress vocabulary and materializes as a Traefik
// IngressRoute instead.
export function ruleNeedsTraefikRoute(
  rule: z.infer<typeof IngressRuleSchema>,
): boolean {
  return (
    rule.match !== undefined ||
    rule.precedence !== undefined ||
    rule.publicTrust === true
  );
}

// Traefik v2 rule string for one declared ingress rule: facts AND-composed.
export function traefikRouteMatch(
  rule: z.infer<typeof IngressRuleSchema>,
): string {
  const parts = [`Host(\`${rule.host}\`)`];
  if (rule.path !== "/") {
    parts.push(
      rule.pathType === "Exact"
        ? `Path(\`${rule.path}\`)`
        : `PathPrefix(\`${rule.path}\`)`,
    );
  }
  if (rule.match?.methods) {
    parts.push(`Method(${rule.match.methods.map((m) => `\`${m}\``).join(",")})`);
  }
  if (rule.match?.acceptContains) {
    parts.push(`HeadersRegexp(\`Accept\`, \`${rule.match.acceptContains}\`)`);
  }
  return parts.join(" && ");
}
