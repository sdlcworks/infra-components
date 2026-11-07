import { mock } from "bun:test";

// Bun lacks the V8 closure-serialization intrinsics the real @pulumi/pulumi
// touches at import time, so the provider SDKs are stubbed and the component's
// lifecycle functions are invoked directly with fabricated contexts.

export type CapturedResource = {
  name: string;
  args: Record<string, any>;
  opts?: Record<string, any>;
};

export const captured: {
  subnetGroups: CapturedResource[];
  securityGroups: CapturedResource[];
  parameterGroups: CapturedResource[];
  instances: CapturedResource[];
  secrets: CapturedResource[];
  secretVersions: CapturedResource[];
} = {
  subnetGroups: [],
  securityGroups: [],
  parameterGroups: [],
  instances: [],
  secrets: [],
  secretVersions: [],
};

export function resetCaptured(): void {
  for (const key of Object.keys(captured) as Array<keyof typeof captured>) {
    captured[key] = [];
  }
}

export const PostgresCI = { interfaceName: "postgres" };
export const MysqlCI = { interfaceName: "mysql" };

mock.module("../../_internal/interfaces", () => ({ PostgresCI, MysqlCI }));

mock.module("@pulumi/pulumi", () => ({
  output: (value: unknown) => ({ apply: (f: (x: unknown) => unknown) => f(value) }),
  all: (values: unknown[]) => ({ apply: (f: (x: unknown) => unknown) => f(values) }),
  secret: (value: unknown) => value,
  interpolate: (strings: TemplateStringsArray, ...values: unknown[]) =>
    String.raw({ raw: strings }, ...values),
}));

class SubnetGroup {
  name: string;
  constructor(name: string, args: Record<string, any>, opts?: Record<string, any>) {
    this.name = String(args.name);
    captured.subnetGroups.push({ name, args, opts });
  }
}

class SecurityGroup {
  id = "sg-test";
  constructor(name: string, args: Record<string, any>, opts?: Record<string, any>) {
    captured.securityGroups.push({ name, args, opts });
  }
}

class ParameterGroup {
  name: string;
  family: string;
  constructor(name: string, args: Record<string, any>, opts?: Record<string, any>) {
    this.name = String(args.name);
    this.family = String(args.family);
    captured.parameterGroups.push({ name, args, opts });
  }
}

class Instance {
  identifier: string;
  address: string;
  port: number;
  arn: string;
  constructor(name: string, args: Record<string, any>, opts?: Record<string, any>) {
    this.identifier = String(args.identifier);
    this.address = `${this.identifier}.rds.test`;
    this.port = Number(args.port ?? 0);
    this.arn = `arn:aws:rds:eu-west-1:000000000000:db:${this.identifier}`;
    captured.instances.push({ name, args, opts });
  }
}

class Secret {
  arn: string;
  constructor(name: string, args: Record<string, any>, opts?: Record<string, any>) {
    this.arn = `arn:aws:secretsmanager:eu-west-1:000000000000:secret:${name}`;
    captured.secrets.push({ name, args, opts });
  }
}

class SecretVersion {
  constructor(name: string, args: Record<string, any>, opts?: Record<string, any>) {
    captured.secretVersions.push({ name, args, opts });
  }
}

mock.module("@pulumi/aws", () => ({
  rds: { SubnetGroup, ParameterGroup, Instance },
  ec2: { SecurityGroup },
  secretsmanager: { Secret, SecretVersion },
}));

let componentDefinition: any;
let implementationRegistration: any[] | undefined;

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
    InfraComponent,
    connectionHandler: (entry: unknown) => entry,
  };
});

let rdsModule: Promise<typeof import("../../aws-rds/index")> | undefined;

export function loadRds(): Promise<typeof import("../../aws-rds/index")> {
  rdsModule ??= import("../../aws-rds/index");
  return rdsModule;
}

export async function getComponentDefinition(): Promise<any> {
  await loadRds();
  return componentDefinition;
}

export async function getProviderFns(): Promise<any> {
  await loadRds();
  return implementationRegistration?.[1];
}

export const namingTag = ((
  strings: TemplateStringsArray,
  ...values: unknown[]
): string => String.raw({ raw: strings }, ...values)) as any;

export function pulumiCtx(inputs: unknown, state: Record<string, any>) {
  return {
    $: namingTag,
    componentName: "store",
    inputs,
    state,
    buildArtifacts: {},
    envStore: {},
    getCredentials: () => ({}),
  } as any;
}
