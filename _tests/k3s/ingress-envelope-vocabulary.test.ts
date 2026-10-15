import { expect, test } from "bun:test";

import {
  IngressRuleSchema,
  ruleNeedsTraefikRoute,
  traefikRouteMatch,
} from "../../k3s/ingress-vocabulary";

const HOST = "mcp.example.test";

const rule = (claim: Record<string, unknown>) =>
  IngressRuleSchema.parse({ host: HOST, ...claim });

test("plain host/path rules stay in the vanilla vocabulary", () => {
  expect(ruleNeedsTraefikRoute(rule({}))).toBe(false);
  expect(ruleNeedsTraefikRoute(rule({ path: "/app", servicePort: 80 }))).toBe(
    false,
  );
});

test("envelope facts, precedence, or public trust leave the vanilla vocabulary", () => {
  expect(
    ruleNeedsTraefikRoute(
      rule({ match: { methods: ["POST"] }, precedence: 20 }),
    ),
  ).toBe(true);
  expect(ruleNeedsTraefikRoute(rule({ precedence: 10 }))).toBe(true);
  expect(ruleNeedsTraefikRoute(rule({ publicTrust: true }))).toBe(true);
});

test("a rule carrying an envelope match must declare an explicit precedence", () => {
  expect(() => rule({ match: { methods: ["POST"] } })).toThrow(
    "a rule with an envelope match must declare an explicit precedence",
  );
  expect(() => rule({ match: {}, precedence: 20 })).toThrow(
    "an envelope match must state at least one envelope fact",
  );
});

test("AND-composes declared facts into one Traefik v2 match", () => {
  expect(
    traefikRouteMatch(
      rule({
        match: { methods: ["POST", "DELETE", "OPTIONS"] },
        precedence: 20,
        publicTrust: true,
      }),
    ),
  ).toBe("Host(`mcp.example.test`) && Method(`POST`,`DELETE`,`OPTIONS`)");

  expect(
    traefikRouteMatch(
      rule({ path: "/.well-known/", precedence: 20, publicTrust: true }),
    ),
  ).toBe("Host(`mcp.example.test`) && PathPrefix(`/.well-known/`)");

  expect(
    traefikRouteMatch(
      rule({
        match: { acceptContains: "text/event-stream" },
        precedence: 20,
        publicTrust: true,
      }),
    ),
  ).toBe(
    "Host(`mcp.example.test`) && HeadersRegexp(`Accept`, `text/event-stream`)",
  );

  expect(
    traefikRouteMatch(
      rule({
        path: "/mcp",
        pathType: "Exact",
        match: { methods: ["POST"], acceptContains: "text/event-stream" },
        precedence: 20,
      }),
    ),
  ).toBe(
    "Host(`mcp.example.test`) && Path(`/mcp`) && Method(`POST`) && " +
      "HeadersRegexp(`Accept`, `text/event-stream`)",
  );
});

test("the residual claim on a shared host states only host and precedence", () => {
  expect(traefikRouteMatch(rule({ precedence: 10, publicTrust: true }))).toBe(
    "Host(`mcp.example.test`)",
  );
});
