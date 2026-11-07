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
  securityGroups: CapturedResource[];
  functions: CapturedResource[];
  subnetLookups: Record<string, any>[];
} = {
  securityGroups: [],
  functions: [],
  subnetLookups: [],
};

export function resetCaptured(): void {
  captured.securityGroups = [];
  captured.functions = [];
  captured.subnetLookups = [];
}

export const PublicCI = { interfaceName: "public" };
export const PostgresCI = { interfaceName: "postgres" };
export const MysqlCI = { interfaceName: "mysql" };
export const MongoCI = { interfaceName: "mongodb" };

mock.module("../../_internal/interfaces", () => ({
  PublicCI,
  PostgresCI,
  MysqlCI,
  MongoCI,
}));

mock.module("@pulumi/pulumi", () => ({
  output: (value: unknown) => ({ apply: (f: (x: unknown) => unknown) => f(value) }),
  all: (values: unknown[]) => ({ apply: (f: (x: unknown) => unknown) => f(values) }),
  secret: (value: unknown) => value,
  asset: {
    AssetArchive: class {},
    StringAsset: class {},
  },
}));

class Named {
  id: string;
  name: string;
  arn: string;
  constructor(name: string, args?: Record<string, any>) {
    this.id = `${name}-id`;
    this.name = String(args?.name ?? name);
    this.arn = `arn:aws:iam::000000000000:${name}`;
  }
}

class SecurityGroup extends Named {
  constructor(name: string, args: Record<string, any>, opts?: Record<string, any>) {
    super(name, args);
    this.id = "sg-managed";
    captured.securityGroups.push({ name, args, opts });
  }
}

class LambdaFunction extends Named {
  functionUrl = "https://fn.lambda-url.eu-west-1.on.aws/";
  constructor(name: string, args: Record<string, any>, opts?: Record<string, any>) {
    super(name, args);
    captured.functions.push({ name, args, opts });
  }
}

mock.module("@pulumi/aws", () => ({
  getCallerIdentityOutput: () => ({ accountId: "000000000000" }),
  getRegionOutput: () => ({ name: "eu-west-1" }),
  ec2: {
    SecurityGroup,
    getSubnetOutput: (args: Record<string, any>) => {
      captured.subnetLookups.push(args);
      return { vpcId: "vpc-derived" };
    },
  },
  iam: { Role: Named, RolePolicyAttachment: Named, RolePolicy: Named },
  cloudwatch: { LogGroup: Named },
  lambda: {
    Function: LambdaFunction,
    FunctionUrl: LambdaFunction,
    FunctionEventInvokeConfig: Named,
  },
  ecr: { Repository: Named },
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
    DeploymentArtifactType: {
      oci_spec_image: "oci_spec_image",
      file: "file",
    },
    InfraComponent,
    connectionHandler: (entry: unknown) => entry,
  };
});

let lambdaModule: Promise<typeof import("../../aws-lambda/index")> | undefined;

export function loadLambda(): Promise<typeof import("../../aws-lambda/index")> {
  lambdaModule ??= import("../../aws-lambda/index");
  return lambdaModule;
}

export async function getComponentDefinition(): Promise<any> {
  await loadLambda();
  return componentDefinition;
}

export async function getProviderFns(): Promise<any> {
  await loadLambda();
  return implementationRegistration?.[1];
}

export const namingTag = ((
  strings: TemplateStringsArray,
  ...values: unknown[]
): string => String.raw({ raw: strings }, ...values)) as any;

export function pulumiCtx(inputs: unknown, state: Record<string, any>) {
  return {
    $: namingTag,
    componentName: "fleet",
    inputs,
    state,
    buildArtifacts: {},
    envStore: {},
    getCredentials: () => ({
      AWS_ACCESS_KEY_ID: "key",
      AWS_SECRET_ACCESS_KEY: "secret",
      AWS_REGION: "eu-west-1",
    }),
  } as any;
}
