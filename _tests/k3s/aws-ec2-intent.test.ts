import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";

import {
  AwsK3sConfigSchema,
  awsNodeIngressPlan,
  buildAwsDrainLambdaCode,
  buildAwsK3sCloudInit,
  buildAwsNodePolicy,
  validateAwsEcrImage,
} from "../../k3s/aws";

const privateSingleServer = {
  vpcId: "vpc-123",
  privateSubnetIds: ["subnet-private-a"],
  ecrRepositoryArns: [
    "arn:aws:ecr:us-east-1:123456789012:repository/apps/*",
  ],
  servers: {
    count: 1,
    instanceType: "t3.small",
  },
  controlPlane: { public: false, allowedCidrs: ["10.0.0.0/16"] },
};

test("AWS cluster intent accepts an explicitly reviewed single-server topology", () => {
  const config = AwsK3sConfigSchema.parse(privateSingleServer);

  expect(config.servers.count).toBe(1);
  expect(config.controlPlane.public).toBe(false);
  expect(config.servers.rootVolumeEncrypted).toBe(true);
  expect(config.agentPools).toEqual({});
});

test("AWS cluster intent accepts only one server or an odd HA server count of at least three", () => {
  expect(() =>
    AwsK3sConfigSchema.parse({
      ...privateSingleServer,
      servers: { ...privateSingleServer.servers, count: 2 },
    }),
  ).toThrow("servers.count must be 1 or an odd number of at least 3");

  expect(
    AwsK3sConfigSchema.parse({
      ...privateSingleServer,
      privateSubnetIds: ["subnet-a", "subnet-b", "subnet-c"],
      servers: { ...privateSingleServer.servers, count: 3 },
    }).servers.count,
  ).toBe(3);
});

test("AWS agent-pool intent validates bounded replaceable capacity", () => {
  expect(() =>
    AwsK3sConfigSchema.parse({
      ...privateSingleServer,
      agentPools: {
        workers: {
          instanceType: "m7i.large",
          capacityType: "spot",
          minSize: 2,
          desiredSize: 1,
          maxSize: 4,
        },
      },
    }),
  ).toThrow("desiredSize must be between minSize and maxSize");
});

test("public AWS surfaces require reviewed admission and multi-AZ public placement", () => {
  expect(() =>
    AwsK3sConfigSchema.parse({
      ...privateSingleServer,
      controlPlane: { public: true, allowedCidrs: [] },
      publicSubnetIds: ["subnet-public-a"],
    }),
  ).toThrow("public controlPlane requires at least two publicSubnetIds");

  const config = AwsK3sConfigSchema.parse({
    ...privateSingleServer,
    publicSubnetIds: ["subnet-public-a", "subnet-public-b"],
    controlPlane: { public: true, allowedCidrs: ["203.0.113.8/32"] },
    workloadIngress: {
      enabled: true,
      allowedCidrs: ["0.0.0.0/0"],
    },
  });

  expect(config.controlPlane.allowedCidrs).toEqual(["203.0.113.8/32"]);
  expect(config.workloadIngress.enabled).toBe(true);
});

test("AWS node admission never exposes overlay, kubelet, or etcd ports to CIDRs", () => {
  const plan = awsNodeIngressPlan({
    controlPlaneAllowedCidrs: ["203.0.113.8/32"],
    workloadIngressEnabled: true,
  });

  for (const port of [2379, 2380, 8472, 10250]) {
    expect(
      plan.filter((rule) => rule.fromPort <= port && rule.toPort >= port),
    ).toSatisfy((rules) =>
      rules.every((rule) => rule.sourceKind !== "cidr"),
    );
  }

  expect(plan).toContainEqual({
    target: "server",
    protocol: "tcp",
    fromPort: 6443,
    toPort: 6443,
    sourceKind: "control-load-balancer",
    description: "Kubernetes API from the control-plane load balancer",
  });
});

test("AWS bootstrap uses protected secret retrieval, ECR exec auth, and no SSH", () => {
  const cloudInit = buildAwsK3sCloudInit({
    nodeRole: "init-server",
    isHa: true,
    version: "v1.35.1+k3s1",
    channel: "stable",
    clusterTokenSecretArn: "arn:aws:secretsmanager:us-east-1:123:secret:join",
    kubeconfigSecretArn:
      "arn:aws:secretsmanager:us-east-1:123:secret:kubeconfig",
    bootstrapMarkerSecretArn:
      "arn:aws:secretsmanager:us-east-1:123:secret:bootstrap",
    expectedServerCount: 3,
    region: "us-east-1",
    joinUrl: "https://control.example.internal:6443",
    tlsSans: ["control.example.internal"],
    installFlags: ["--cluster-cidr=10.42.0.0/16"],
    nodeLabels: ["sdlc.works/machine-group=servers"],
    nodeTaints: [],
  });

  expect(cloudInit).toContain("aws secretsmanager get-secret-value");
  expect(cloudInit).toContain("aws secretsmanager put-secret-value");
  expect(cloudInit).toContain("image-credential-provider-config");
  expect(cloudInit).toContain("snap start amazon-ssm-agent");
  expect(cloudInit).toContain("*.dkr.ecr.*.amazonaws.com");
  expect(cloudInit).toContain('request.get("image", "")');
  expect(cloudInit).toContain('"/snap/bin/aws", "ecr"');
  expect(cloudInit).toContain('"--registry-ids", match.group("account")');
  expect(cloudInit).toContain("--tls-san=control.example.internal");
  expect(cloudInit).toContain("--cluster-init");
  expect(cloudInit).not.toContain("ssh_authorized_keys");
  expect(cloudInit).not.toContain("K3S_TOKEN=\"");
});

test("AWS drain uses a Kubernetes patch media type and removes the stale node", () => {
  const source = buildAwsDrainLambdaCode();

  expect(source).toContain('"application/merge-patch+json"');
  expect(source).toContain('"/api/v1/nodes/" + encodedNode, "DELETE"');
  expect(source.indexOf("const finalPods")).toBeGreaterThan(
    source.indexOf("while (Date.now() < deadline)"),
  );
  expect(
    source.indexOf('"/api/v1/nodes/" + encodedNode, "DELETE"'),
  ).toBeLessThan(
    source.indexOf("pod drain did not complete before the lifecycle deadline"),
  );
});

test("AWS drain executes cordon, eviction, node deletion, and lifecycle completion", async () => {
  const requests: Array<{
    options: { path: string; method: string; headers?: Record<string, string> };
    body: string;
  }> = [];
  const lifecycleActions: Array<Record<string, string>> = [];
  let podListCount = 0;

  const https = {
    request(
      options: { path: string; method: string; headers?: Record<string, string> },
      callback: (response: EventEmitter & { statusCode: number }) => void,
    ) {
      const request = new EventEmitter() as EventEmitter & {
        body: string;
        write(chunk: string): void;
        end(): void;
      };
      request.body = "";
      request.write = (chunk) => {
        request.body += chunk;
      };
      request.end = () => {
        queueMicrotask(() => {
          requests.push({ options, body: request.body });
          const response = new EventEmitter() as EventEmitter & {
            statusCode: number;
          };
          response.statusCode = 200;
          callback(response);
          queueMicrotask(() => {
            let payload: Record<string, unknown> = {};
            if (options.path.startsWith("/api/v1/pods?")) {
              podListCount += 1;
              payload = podListCount === 1
                ? {
                    items: [{
                      metadata: { name: "api", namespace: "components" },
                      status: { phase: "Running" },
                    }],
                  }
                : { items: [] };
            }
            response.emit("data", Buffer.from(JSON.stringify(payload)));
            response.emit("end");
          });
        });
      };
      return request;
    },
  };
  class Command {
    constructor(readonly input: Record<string, string>) {}
  }
  class AutoScalingClient {
    async send(command: Command) {
      lifecycleActions.push(command.input);
      return {};
    }
  }
  class SecretsManagerClient {
    async send() {
      return {
        SecretString: JSON.stringify({
          kubeconfig: [
            "server: https://control.internal:6443",
            "certificate-authority-data: Y2E=",
            "client-certificate-data: Y2VydA==",
            "client-key-data: a2V5",
          ].join("\n"),
        }),
      };
    }
  }
  const fakeRequire = (specifier: string) => {
    if (specifier === "node:https") return https;
    if (specifier === "@aws-sdk/client-auto-scaling") {
      return { AutoScalingClient, CompleteLifecycleActionCommand: Command };
    }
    if (specifier === "@aws-sdk/client-secrets-manager") {
      return { SecretsManagerClient, GetSecretValueCommand: Command };
    }
    throw new Error(`unexpected require ${specifier}`);
  };
  const generatedExports: { handler?: (event: unknown) => Promise<void> } = {};
  new Function(
    "require",
    "exports",
    "setTimeout",
    buildAwsDrainLambdaCode(),
  )(fakeRequire, generatedExports, (callback: () => void) => callback());

  await generatedExports.handler?.({
    detail: {
      EC2InstanceId: "i-123",
      AutoScalingGroupName: "agents",
      LifecycleHookName: "drain",
      LifecycleActionToken: "token",
    },
  });

  expect(requests.map(({ options }) => [options.method, options.path])).toEqual([
    ["PATCH", "/api/v1/nodes/i-123"],
    ["GET", "/api/v1/pods?fieldSelector=spec.nodeName%3Di-123"],
    ["POST", "/api/v1/namespaces/components/pods/api/eviction"],
    ["GET", "/api/v1/pods?fieldSelector=spec.nodeName%3Di-123"],
    ["GET", "/api/v1/pods?fieldSelector=spec.nodeName%3Di-123"],
    ["DELETE", "/api/v1/nodes/i-123"],
  ]);
  expect(requests[0]?.options.headers?.["content-type"]).toBe(
    "application/merge-patch+json",
  );
  expect(JSON.parse(requests[2]?.body ?? "{}").kind).toBe("Eviction");
  expect(lifecycleActions).toEqual([{
    AutoScalingGroupName: "agents",
    LifecycleHookName: "drain",
    LifecycleActionToken: "token",
    LifecycleActionResult: "CONTINUE",
  }]);
});

test("AWS node authority permits ECR pulls while kubeconfig publication is server-only", () => {
  const serverPolicy = buildAwsNodePolicy({
    clusterTokenSecretArn: "arn:join",
    kubeconfigSecretArn: "arn:kubeconfig",
    bootstrapMarkerSecretArn: "arn:bootstrap",
    mayBootstrapCluster: true,
    mayPublishKubeconfig: true,
    ecrRepositoryArns: ["arn:aws:ecr:us-east-1:123:repository/apps/*"],
  });
  const agentPolicy = buildAwsNodePolicy({
    clusterTokenSecretArn: "arn:join",
    kubeconfigSecretArn: "arn:kubeconfig",
    bootstrapMarkerSecretArn: "arn:bootstrap",
    mayBootstrapCluster: false,
    mayPublishKubeconfig: false,
    ecrRepositoryArns: ["arn:aws:ecr:us-east-1:123:repository/apps/*"],
  });

  expect(JSON.stringify(serverPolicy)).toContain("secretsmanager:PutSecretValue");
  expect(JSON.stringify(serverPolicy)).toContain("ecr:GetAuthorizationToken");
  expect(JSON.stringify(serverPolicy)).toContain(
    "arn:aws:ecr:us-east-1:123:repository/apps/*",
  );
  expect(JSON.stringify(agentPolicy)).not.toContain(
    "secretsmanager:PutSecretValue",
  );
});

test("AWS artifact admission is scoped to reviewed account, region, and repository", () => {
  const allowed = [
    "arn:aws:ecr:us-east-1:123456789012:repository/apps/*",
  ];
  expect(() =>
    validateAwsEcrImage(
      "123456789012.dkr.ecr.us-east-1.amazonaws.com/apps/api:v1",
      allowed,
    ),
  ).not.toThrow();
  expect(() =>
    validateAwsEcrImage(
      "999999999999.dkr.ecr.us-east-1.amazonaws.com/apps/api:v1",
      allowed,
    ),
  ).toThrow("not in ecrRepositoryArns");
  expect(() => validateAwsEcrImage("docker.io/library/nginx:latest", allowed)).toThrow(
    "private ECR image",
  );
});
