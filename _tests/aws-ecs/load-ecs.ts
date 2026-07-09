import { mock } from "bun:test";

mock.module("@pulumi/aws", () => ({}));
mock.module("@pulumi/pulumi", () => ({}));
mock.module("../../_internal/interfaces", () => ({
  InternalServiceCI: {},
  PublicCI: {},
}));

let componentDefinition: unknown;
let implementationRegistration: unknown[] | undefined;

mock.module("@sdlcworks/components", () => {
  class InfraComponent {
    constructor(definition: unknown) {
      componentDefinition = definition;
    }

    implement(...args: unknown[]): void {
      implementationRegistration = args;
    }
  }

  return {
    CloudProvider: { aws: "aws" },
    DeploymentArtifactType: { oci_spec_image: "oci_spec_image" },
    InfraComponent,
    connectionHandler: (..._args: unknown[]) => ({}),
  };
});

let ecsModule: Promise<typeof import("../../aws-ecs/index")> | undefined;

export function loadEcs(): Promise<typeof import("../../aws-ecs/index")> {
  ecsModule ??= import("../../aws-ecs/index");
  return ecsModule;
}

export function getComponentDefinition(): unknown {
  return componentDefinition;
}

export function getImplementationRegistration(): unknown[] | undefined {
  return implementationRegistration;
}
