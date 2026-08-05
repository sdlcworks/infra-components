import { mock } from "bun:test";

// Bun has no native V8 closure-serialization support, which the real
// @pulumi/pulumi module touches at import time. Declaration-shape tests never
// call `pulumi`/`connect`/`provision`, so a minimal structural stand-in is
// sufficient — mirrors js/packages/components/src/__test-preload-pulumi.ts.
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

mock.module("@pulumi/kubernetes", () => ({
  Provider: class {},
  core: { v1: { Namespace: class {}, Service: class {} } },
  apps: { v1: { Deployment: class {}, StatefulSet: class {} } },
  networking: { v1: { Ingress: class {} } },
}));

export function loadWorkloadHost(): Promise<typeof import("../../local-macos/index")> {
  return import("../../local-macos/index");
}

export function loadLocalIngress(): Promise<
  typeof import("../../url-registers/local-ingress/index")
> {
  return import("../../url-registers/local-ingress/index");
}

export function loadLocalRegistry(): Promise<
  typeof import("../../artifact-registries/local-registry/index")
> {
  return import("../../artifact-registries/local-registry/index");
}
