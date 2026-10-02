import { mock } from "bun:test";

// Bun's mock.module registry is process-global and last-registration-wins, so
// every suite that stubs @pulumi/* must share ONE registration with the union
// of the classes its members construct — competing per-suite mocks starve each
// other depending on file order. Bun also lacks the V8 closure-serialization
// intrinsics the real @pulumi/pulumi touches at import time, which is why the
// modules are stubbed at all; lifecycle functions are invoked directly with
// fabricated contexts.

export type CapturedResource = {
  name: string;
  args: Record<string, unknown>;
};

export const captured: {
  workersScripts: CapturedResource[];
  workersSubdomains: CapturedResource[];
  cloudRunServices: CapturedResource[];
  cloudflareProviders: CapturedResource[];
  dnsRecords: CapturedResource[];
  workerCustomDomains: CapturedResource[];
} = {
  workersScripts: [],
  workersSubdomains: [],
  cloudRunServices: [],
  cloudflareProviders: [],
  dnsRecords: [],
  workerCustomDomains: [],
};

export function resetCaptured(): void {
  for (const key of Object.keys(captured) as Array<keyof typeof captured>) {
    captured[key] = [];
  }
}

mock.module("@pulumi/pulumi", () => ({
  output: (v: unknown) => ({ apply: (f: (x: unknown) => unknown) => f(v) }),
  Output: {
    isInstance: () => false,
    create: (v: unknown) => v,
  },
  interpolate: (strings: TemplateStringsArray, ...values: unknown[]) =>
    String.raw({ raw: strings }, ...values),
  all: (arr: unknown[]) => ({ apply: (f: (x: unknown) => unknown) => f(arr) }),
  Provider: class {},
}));

mock.module("@pulumi/cloudflare", () => ({
  Provider: class {
    constructor(name: string, args: Record<string, unknown>) {
      captured.cloudflareProviders.push({ name, args });
    }
  },
  getZoneOutput: () => ({ zoneId: "zone-1" }),
  DnsRecord: class {
    constructor(name: string, args: Record<string, unknown>) {
      captured.dnsRecords.push({ name, args });
    }
  },
  WorkersScript: class {
    id = "worker-id";
    scriptName: unknown;
    constructor(name: string, args: Record<string, unknown>) {
      this.scriptName = args.scriptName;
      captured.workersScripts.push({ name, args });
    }
  },
  WorkersScriptSubdomain: class {
    constructor(name: string, args: Record<string, unknown>) {
      captured.workersSubdomains.push({ name, args });
    }
  },
  WorkersRoute: class {},
  WorkersCustomDomain: class {
    constructor(name: string, args: Record<string, unknown>) {
      captured.workerCustomDomains.push({ name, args });
    }
  },
}));

class GcpResource {
  id = "gcp-id";
  name: string;
  email = "sa@example.iam.gserviceaccount.com";
  uri = "https://service.example.run.app";
  latestReadyRevision = "rev-1";
  location = "us-central1";
  selfLink = "https://gcp.example/self-link";
  privateKey = "key-json";
  constructor(name: string, args: Record<string, unknown>) {
    this.name = name;
    if (name.includes("service")) {
      captured.cloudRunServices.push({ name, args });
    }
  }
}

mock.module("@pulumi/gcp", () => ({
  serviceaccount: { Account: GcpResource, Key: GcpResource },
  cloudrunv2: { Service: GcpResource, ServiceIamMember: GcpResource },
  compute: {
    RegionNetworkEndpointGroup: GcpResource,
    BackendService: GcpResource,
  },
}));

mock.module("../_internal/gcp-helpers", () => ({
  mintGcpAccessToken: async () => "access-token",
  waitForCloudRunOperation: async () => undefined,
}));

// Permissively typed: the component framework's naming tag carries an
// overloaded signature these tests never exercise beyond template-tag use.
export const namingTag = ((
  strings: TemplateStringsArray,
  ...values: unknown[]
): string => String.raw({ raw: strings }, ...values)) as any;
