import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import * as pulumi from "../../.js/node_modules/@pulumi/pulumi/index.js";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const build = spawnSync("sdlc-components-build", ["--bundle"], {
  cwd: repositoryRoot,
  encoding: "utf8",
});
if (build.status !== 0) {
  throw new Error(`component build failed:\n${build.stdout}${build.stderr}`);
}

const resources = [];
let subnetCall = 0;
const kubeconfig = `apiVersion: v1
clusters:
  - cluster:
      server: https://control.internal:6443
      certificate-authority-data: Y2E=
    name: default
contexts: []
current-context: ""
kind: Config
preferences: {}
users:
  - name: default
    user:
      client-certificate-data: Y2VydA==
      client-key-data: a2V5
`;

pulumi.runtime.setMocks(
  {
    newResource: (args) => {
      resources.push(args);
      const id = `${args.name}-id`;
      return {
        id,
        state: {
          ...args.inputs,
          id,
          arn: `arn:aws:mock:us-east-1:123456789012:${args.name}`,
          name: args.name,
          dnsName: `${args.name}.internal`,
          privateIp: "10.0.1.10",
          availabilityZone: "us-east-1a",
          latestVersion: 1,
          privateKeyOpenssh: args.type.includes("PrivateKey")
            ? "mock-private-key"
            : undefined,
          value:
            args.type === "pulumi-nodejs:dynamic:Resource"
              ? kubeconfig
              : undefined,
        },
      };
    },
    call: (args) => {
      if (args.token.includes("getAmi")) {
        return { id: "ami-ubuntu-2404", rootDeviceName: "/dev/sda1" };
      }
      if (args.token.includes("getSubnet")) {
        subnetCall += 1;
        return {
          ...args.inputs,
          vpcId: "vpc-123",
          availabilityZone:
            subnetCall % 2 === 0 ? "us-east-1b" : "us-east-1a",
          mapPublicIpOnLaunch: false,
        };
      }
      if (args.token.includes("getZone")) {
        return { zoneId: "zone-123", name: "example.com" };
      }
      return args.inputs;
    },
  },
  "project",
  "stack",
  false,
);

await pulumi.runtime.runInPulumiStack(async () => {
  const { default: component } = await import("../../.js/dist/k3s.js");
  const inputs = component.opts.configSchema.parse({
    aws: {
      vpcId: "vpc-123",
      privateSubnetIds: ["subnet-private-a"],
      publicSubnetIds: ["subnet-public-a", "subnet-public-b"],
      ecrRepositoryArns: [
        "arn:aws:ecr:us-east-1:123456789012:repository/apps/*",
      ],
      servers: { count: 1, instanceType: "t3.small" },
      agentPools: {
        general: {
          instanceType: "m7i.large",
          minSize: 1,
          desiredSize: 1,
          maxSize: 2,
        },
      },
      controlPlane: { public: false, allowedCidrs: ["10.0.0.0/16"] },
      workloadIngress: { enabled: true, allowedCidrs: ["0.0.0.0/0"] },
    },
  });
  const state = {};
  const implementation = component.providers.aws;
  const result = await implementation.pulumi({
    $: (name) => `smoke-${name}`,
    inputs,
    state,
    getCredentials: () => ({
      AWS_ACCESS_KEY_ID: "test-access-key",
      AWS_SECRET_ACCESS_KEY: "test-secret-key",
      AWS_REGION: "us-east-1",
    }),
    aws: undefined,
  });

  assert(result.apiServerUrl);
  assert(result.nodes);
  assert(result.agentPools);

  state.allocations = {
    api: {
      appComponentType: "http-service",
      namespace: "components",
      servicePort: 8080,
      public: true,
      requiredHost: "api.example.com",
      publicProtocol: "https",
    },
  };
  const publicHandler = implementation
    .connect({ state, selfComponentName: "api" })
    .find((candidate) => candidate.interface.name === "public");
  assert(publicHandler, "expected the public connection handler");
  const publicConnection = await publicHandler.handler({});
  assert.equal(await publicConnection.uri.promise(), "https://api.example.com");
  assert.equal(publicConnection.metadata.requiredHost, "api.example.com");
  assert.equal(publicConnection.metadata.protocol, "https");
  assert.equal(publicConnection.metadata.port, 443);

  const postgresInputs = component.opts.configSchema.parse({
    ...inputs,
    postgresClusterConfig: {
      primary: {
        dbName: "app",
        dbPassword: "not-a-real-password",
      },
    },
  });
  await assert.rejects(
    implementation.pulumi({
      $: (name) => `postgres-smoke-${name}`,
      inputs: postgresInputs,
      state: {},
      getCredentials: () => ({
        AWS_ACCESS_KEY_ID: "test-access-key",
        AWS_SECRET_ACCESS_KEY: "test-secret-key",
        AWS_REGION: "us-east-1",
      }),
      aws: undefined,
    }),
    /postgresClusterConfig requires durable network storage/,
  );
  await assert.rejects(
    implementation.pulumi({
      $: (name) => `runtime-change-smoke-${name}`,
      inputs: component.opts.configSchema.parse({
        ...inputs,
        k3sVersion: "v1.35.2+k3s1",
      }),
      state,
      getCredentials: () => ({
        AWS_ACCESS_KEY_ID: "test-access-key",
        AWS_SECRET_ACCESS_KEY: "test-secret-key",
        AWS_REGION: "us-east-1",
      }),
      aws: undefined,
    }),
    /fixed-server runtime changes require an explicit cluster migration/,
  );
  await assert.rejects(
    implementation.pulumi({
      $: (name) => `pool-removal-smoke-${name}`,
      inputs: component.opts.configSchema.parse({
        ...inputs,
        aws: { ...inputs.aws, agentPools: {} },
      }),
      state,
      getCredentials: () => ({
        AWS_ACCESS_KEY_ID: "test-access-key",
        AWS_SECRET_ACCESS_KEY: "test-secret-key",
        AWS_REGION: "us-east-1",
      }),
      aws: undefined,
    }),
    /scale agent pools to minSize=0 and desiredSize=0 before removing them/,
  );

  const { default: cloudflareDns } = await import(
    "../../.js/dist/url-register--cloudflare-dns.js"
  );
  const dnsResults = await cloudflareDns.getProvision()({
    $: (name) => `dns-smoke-${name}`,
    config: {
      domain: "example.com",
      defaults: { proxied: true },
      records: { api: { name: "api" } },
    },
    components: {
      api: {
        uri: "https://api.example.com",
        metadata: {
          appComponentType: "http-service",
          host: "workload-nlb.internal",
          requiredHost: "api.example.com",
          protocol: "https",
          port: 443,
        },
      },
    },
    getCredentials: () => ({}),
    cloudflare: undefined,
  });
  assert.equal(await dnsResults.api.promise(), "https://api.example.com");
  await assert.rejects(
    cloudflareDns.getProvision()({
      $: (name) => `dns-mismatch-${name}`,
      config: {
        domain: "example.com",
        defaults: { proxied: true },
        records: { api: { name: "other" } },
      },
      components: {
        api: {
          uri: "https://api.example.com",
          metadata: {
            appComponentType: "http-service",
            host: "workload-nlb.internal",
            requiredHost: "api.example.com",
            protocol: "https",
            port: 443,
          },
        },
      },
      getCredentials: () => ({}),
      cloudflare: undefined,
    }),
    /requires Host 'api\.example\.com'.*resolves to 'other\.example\.com'/,
  );
  await assert.rejects(
    cloudflareDns.getProvision()({
      $: (name) => `dns-conflict-${name}`,
      config: {
        domain: "example.com",
        defaults: { proxied: true },
        records: { api: { name: "api" } },
      },
      components: {
        api: {
          uri: "https://api.example.com",
          metadata: {
            appComponentType: "http-service",
            host: "workload-nlb.internal",
            requiredHost: "api.example.com",
            originAddressed: true,
            protocol: "https",
            port: 443,
          },
        },
      },
      getCredentials: () => ({}),
      cloudflare: undefined,
    }),
    /requiredHost and originAddressed.*mutually exclusive/,
  );
  return result;
});

const resourceTypes = resources.map((resource) => resource.type);
for (const requiredType of [
  "aws:ec2/instance:Instance",
  "aws:autoscaling/group:Group",
  "aws:ec2/launchTemplate:LaunchTemplate",
  "aws:lb/loadBalancer:LoadBalancer",
  "aws:secretsmanager/secret:Secret",
  "aws:ec2/securityGroupRule:SecurityGroupRule",
  "aws:autoscaling/lifecycleHook:LifecycleHook",
  "aws:cloudwatch/eventRule:EventRule",
  "aws:lambda/function:Function",
]) {
  assert(
    resourceTypes.includes(requiredType),
    `expected mocked resource graph to include ${requiredType}`,
  );
}

const controlTargets = resources.find(
  (resource) =>
    resource.type === "aws:lb/targetGroup:TargetGroup" &&
    resource.name.includes("control-targets"),
);
assert.equal(controlTargets?.inputs.preserveClientIp, "false");

const fixedServers = resources.filter(
  (resource) => resource.type === "aws:ec2/instance:Instance",
);
assert(fixedServers.length > 0);

assert(!resourceTypes.includes("aws:ec2/eip:Eip"));
assert(!resourceTypes.includes("aws:ec2/keyPair:KeyPair"));
assert(
  resourceTypes.some((type) => type.toLowerCase().includes("dnsrecord")),
  "expected the public endpoint to produce a Cloudflare DNS record",
);
assert(
  resourceTypes.every((type) => !type.toLowerCase().includes("workersscript")),
  "host-compatible aliases must not install a host-rewrite worker",
);

console.log(`AWS k3s Pulumi smoke graph: ${resources.length} resources`);
