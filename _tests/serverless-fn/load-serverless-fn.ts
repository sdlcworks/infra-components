import { mock } from "bun:test";

export type CapturedResource = {
  name: string;
  args: Record<string, unknown>;
};

export const captured: {
  workersScripts: CapturedResource[];
  workersSubdomains: CapturedResource[];
  cloudRunServices: CapturedResource[];
} = {
  workersScripts: [],
  workersSubdomains: [],
  cloudRunServices: [],
};

export function resetCaptured(): void {
  captured.workersScripts = [];
  captured.workersSubdomains = [];
  captured.cloudRunServices = [];
}

// Bun has no native V8 closure-serialization support, which the real
// @pulumi/pulumi module touches at import time. These tests invoke provider
// functions directly with fabricated contexts, so a minimal structural
// stand-in is sufficient — mirrors _tests/local-macos/load-local-macos.ts.
mock.module("@pulumi/pulumi", () => ({
  output: (v: unknown) => v,
  Output: {
    isInstance: () => false,
    create: (v: unknown) => v,
  },
  interpolate: (strings: TemplateStringsArray, ...values: unknown[]) =>
    String.raw({ raw: strings }, ...values),
  all: (arr: unknown[]) => arr,
  Provider: class {},
}));

mock.module("@pulumi/cloudflare", () => ({
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
  WorkersCustomDomain: class {},
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

mock.module("../../_internal/gcp-helpers", () => ({
  mintGcpAccessToken: async () => "access-token",
  waitForCloudRunOperation: async () => undefined,
}));

export function loadServerlessFn(): Promise<
  typeof import("../../serverless-fn/index")
> {
  return import("../../serverless-fn/index");
}

// Permissively typed: the component framework's naming tag carries an
// overloaded signature these tests never exercise beyond template-tag use.
export const namingTag = ((
  strings: TemplateStringsArray,
  ...values: unknown[]
): string => String.raw({ raw: strings }, ...values)) as any;
