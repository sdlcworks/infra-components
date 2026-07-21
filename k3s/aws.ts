import { z } from "zod";

const AwsArchitectureSchema = z.enum(["x86_64", "arm64"]);
const AwsRootVolumeTypeSchema = z.enum(["gp3", "gp2"]);

const AwsHostShape = {
  instanceType: z.string().min(1),
  architecture: AwsArchitectureSchema.default("x86_64"),
  amiId: z.string().min(1).optional(),
  rootVolumeSizeGb: z.number().int().min(20).max(16_384).default(40),
  rootVolumeType: AwsRootVolumeTypeSchema.default("gp3"),
  rootVolumeEncrypted: z.literal(true).default(true),
  labels: z.record(z.string(), z.string()).default({}),
  taints: z.array(z.string().min(1)).default([]),
};

const AwsServerPoolSchema = z.object({
  ...AwsHostShape,
  count: z.number().int().positive(),
});

const AwsAgentPoolSchema = z
  .object({
    ...AwsHostShape,
    capacityType: z.enum(["on-demand", "spot"]).default("on-demand"),
    minSize: z.number().int().nonnegative(),
    desiredSize: z.number().int().nonnegative(),
    maxSize: z.number().int().positive(),
    targetCpuUtilization: z.number().positive().max(100).optional(),
    subnetIds: z.array(z.string().min(1)).min(1).optional(),
  })
  .superRefine((pool, ctx) => {
    if (pool.minSize > pool.desiredSize || pool.desiredSize > pool.maxSize) {
      ctx.addIssue({
        code: "custom",
        path: ["desiredSize"],
        message: "desiredSize must be between minSize and maxSize",
      });
    }
  });

const AwsAdmissionSchema = z.object({
  public: z.boolean().default(false),
  allowedCidrs: z.array(z.string().min(1)).default([]),
});

const AwsWorkloadIngressSchema = z.object({
  enabled: z.boolean().default(false),
  allowedCidrs: z.array(z.string().min(1)).default([]),
});

export const AwsK3sConfigSchema = z
  .object({
    vpcId: z.string().min(1),
    privateSubnetIds: z.array(z.string().min(1)).min(1),
    publicSubnetIds: z.array(z.string().min(1)).default([]),
    servers: AwsServerPoolSchema,
    agentPools: z.record(z.string().min(1), AwsAgentPoolSchema).default({}),
    controlPlane: AwsAdmissionSchema.default({
      public: false,
      allowedCidrs: [],
    }),
    workloadIngress: AwsWorkloadIngressSchema.default({
      enabled: false,
      allowedCidrs: [],
    }),
    ecrRepositoryArns: z.array(z.string().min(1)).min(1),
    amiOwner: z.string().min(1).default("099720109477"),
    labels: z.record(z.string(), z.string()).default({}),
  })
  .superRefine((config, ctx) => {
    const serverCount = config.servers.count;
    if (serverCount !== 1 && (serverCount < 3 || serverCount % 2 === 0)) {
      ctx.addIssue({
        code: "custom",
        path: ["servers", "count"],
        message: "servers.count must be 1 or an odd number of at least 3",
      });
    }

    if (serverCount >= 3 && config.privateSubnetIds.length < 3) {
      ctx.addIssue({
        code: "custom",
        path: ["privateSubnetIds"],
        message: "HA servers require at least three privateSubnetIds",
      });
    }

    if (config.controlPlane.public && config.publicSubnetIds.length < 2) {
      ctx.addIssue({
        code: "custom",
        path: ["publicSubnetIds"],
        message: "public controlPlane requires at least two publicSubnetIds",
      });
    }
    if (config.controlPlane.allowedCidrs.length === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["controlPlane", "allowedCidrs"],
        message: "controlPlane.allowedCidrs must admit the provisioning client or VPC",
      });
    }

    for (const [poolName, pool] of Object.entries(config.agentPools)) {
      for (const subnetId of pool.subnetIds ?? []) {
        if (!config.privateSubnetIds.includes(subnetId)) {
          ctx.addIssue({
            code: "custom",
            path: ["agentPools", poolName, "subnetIds"],
            message: "agent pool subnetIds must be selected from privateSubnetIds",
          });
        }
      }
    }

    if (config.workloadIngress.enabled && config.publicSubnetIds.length < 2) {
      ctx.addIssue({
        code: "custom",
        path: ["publicSubnetIds"],
        message: "workloadIngress requires at least two publicSubnetIds",
      });
    }
    if (
      config.workloadIngress.enabled &&
      config.workloadIngress.allowedCidrs.length === 0
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["workloadIngress", "allowedCidrs"],
        message: "enabled workloadIngress requires at least one allowed CIDR",
      });
    }
  });

export type AwsK3sConfig = z.infer<typeof AwsK3sConfigSchema>;

/** Reject images outside the explicitly reviewed private ECR repositories. */
export function validateAwsEcrImage(
  imageUri: string,
  allowedRepositoryArns: string[],
): void {
  const match = imageUri.match(
    /^(\d{12})\.dkr\.ecr\.([a-z0-9-]+)\.amazonaws\.com(\.cn)?\/([^@:]+(?:\/[^@:]+)*)(?::[^@]+|@sha256:[a-f0-9]{64})$/,
  );
  if (!match) {
    throw new Error(`k3s (aws): image ${imageUri} is not a tagged or digest-pinned private ECR image`);
  }
  const [, account, region, chinaSuffix, repository] = match;
  const arn = `arn:${chinaSuffix ? "aws-cn" : "aws"}:ecr:${region}:${account}:repository/${repository}`;
  const allowed = allowedRepositoryArns.some((pattern) =>
    pattern.endsWith("*") ? arn.startsWith(pattern.slice(0, -1)) : arn === pattern,
  );
  if (!allowed) {
    throw new Error(`k3s (aws): image repository ${arn} is not in ecrRepositoryArns`);
  }
}

type AwsNodeTarget = "server" | "agent";
type AwsIngressSourceKind =
  | "cidr"
  | "server"
  | "agent"
  | "control-load-balancer"
  | "workload-load-balancer";

export interface AwsNodeIngressRulePlan {
  target: AwsNodeTarget;
  protocol: "tcp" | "udp";
  fromPort: number;
  toPort: number;
  sourceKind: AwsIngressSourceKind;
  description: string;
}

/**
 * Provider-independent description of the EC2 host admission boundary.
 * CIDR admission terminates at load balancer security groups, never directly
 * on a node security group.
 */
export function awsNodeIngressPlan(_input: {
  controlPlaneAllowedCidrs: string[];
  workloadIngressEnabled: boolean;
}): AwsNodeIngressRulePlan[] {
  const rules: AwsNodeIngressRulePlan[] = [
    {
      target: "server",
      protocol: "tcp",
      fromPort: 6443,
      toPort: 6443,
      sourceKind: "control-load-balancer",
      description: "Kubernetes API from the control-plane load balancer",
    },
    {
      target: "server",
      protocol: "tcp",
      fromPort: 6443,
      toPort: 6443,
      sourceKind: "server",
      description: "Kubernetes API for server registration and recovery",
    },
    {
      target: "server",
      protocol: "tcp",
      fromPort: 6443,
      toPort: 6443,
      sourceKind: "agent",
      description: "Kubernetes API for agent registration",
    },
    {
      target: "server",
      protocol: "tcp",
      fromPort: 2379,
      toPort: 2380,
      sourceKind: "server",
      description: "Embedded etcd between fixed server nodes",
    },
  ];

  for (const target of ["server", "agent"] as const) {
    for (const sourceKind of ["server", "agent"] as const) {
      rules.push(
        {
          target,
          protocol: "udp",
          fromPort: 8472,
          toPort: 8472,
          sourceKind,
          description: "Flannel VXLAN between cluster nodes",
        },
        {
          target,
          protocol: "tcp",
          fromPort: 10250,
          toPort: 10250,
          sourceKind,
          description: "Kubelet API and metrics between cluster nodes",
        },
      );
    }
  }

  if (_input.workloadIngressEnabled) {
    for (const target of ["server", "agent"] as const) {
      for (const port of [80, 443]) {
        rules.push({
          target,
          protocol: "tcp",
          fromPort: port,
          toPort: port,
          sourceKind: "workload-load-balancer",
          description: `Workload ingress on TCP ${port}`,
        });
      }
    }
  }

  return rules;
}

interface AwsNodePolicyInput {
  clusterTokenSecretArn: string;
  kubeconfigSecretArn: string;
  bootstrapMarkerSecretArn: string;
  mayBootstrapCluster: boolean;
  mayPublishKubeconfig: boolean;
  maySignalLifecycle?: boolean;
  ecrRepositoryArns: string[];
}

export function buildAwsNodePolicy(input: AwsNodePolicyInput) {
  const statements: Array<Record<string, unknown>> = [
    {
      Sid: "ReadClusterJoinToken",
      Effect: "Allow",
      Action: ["secretsmanager:GetSecretValue"],
      Resource: input.clusterTokenSecretArn,
    },
    {
      Sid: "RequestEcrAuthorization",
      Effect: "Allow",
      Action: ["ecr:GetAuthorizationToken"],
      Resource: "*",
    },
    {
      Sid: "PullReviewedEcrImages",
      Effect: "Allow",
      Action: [
        "ecr:BatchCheckLayerAvailability",
        "ecr:BatchGetImage",
        "ecr:GetDownloadUrlForLayer",
      ],
      Resource: input.ecrRepositoryArns,
    },
  ];

  if (input.mayPublishKubeconfig) {
    statements.push({
      Sid: "PublishProtectedKubeconfig",
      Effect: "Allow",
      Action: ["secretsmanager:PutSecretValue"],
      Resource: input.kubeconfigSecretArn,
    });
  }
  if (input.mayBootstrapCluster) {
    statements.push({
      Sid: "CoordinateClusterBootstrap",
      Effect: "Allow",
      Action: ["secretsmanager:GetSecretValue", "secretsmanager:PutSecretValue"],
      Resource: input.bootstrapMarkerSecretArn,
    });
  }
  if (input.maySignalLifecycle) {
    statements.push({
      Sid: "SignalAgentReadiness",
      Effect: "Allow",
      Action: ["autoscaling:CompleteLifecycleAction"],
      Resource: "*",
    });
  }

  return { Version: "2012-10-17", Statement: statements };
}

/** Lambda source for draining an ASG-backed agent before termination. */
export function buildAwsDrainLambdaCode(): string {
  return `"use strict";
const https = require("node:https");
const { AutoScalingClient, CompleteLifecycleActionCommand } = require("@aws-sdk/client-auto-scaling");
const { GetSecretValueCommand, SecretsManagerClient } = require("@aws-sdk/client-secrets-manager");

function kubeconfigValue(text, key) {
  const match = text.match(new RegExp("(?:^|\\\\n)\\\\s*" + key + ":\\\\s*([^\\\\s]+)"));
  if (!match) throw new Error("kubeconfig is missing " + key);
  return match[1];
}

function kubeRequest(config, path, method = "GET", body) {
  const endpoint = new URL(config.server);
  return new Promise((resolve, reject) => {
    const request = https.request({
      hostname: endpoint.hostname,
      port: endpoint.port || 443,
      path,
      method,
      ca: Buffer.from(config.ca, "base64"),
      cert: Buffer.from(config.cert, "base64"),
      key: Buffer.from(config.key, "base64"),
      rejectUnauthorized: true,
      headers: body ? {
        "content-type": method === "PATCH"
          ? "application/merge-patch+json"
          : "application/json",
        "content-length": Buffer.byteLength(body),
      } : undefined,
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        if ((response.statusCode || 500) >= 400) {
          const error = new Error(method + " " + path + " failed: " + response.statusCode + " " + text);
          error.statusCode = response.statusCode;
          reject(error);
          return;
        }
        resolve(text ? JSON.parse(text) : {});
      });
    });
    request.on("error", reject);
    if (body) request.write(body);
    request.end();
  });
}

function evictable(pod) {
  if (["Succeeded", "Failed"].includes(pod.status?.phase)) return false;
  if (pod.metadata?.annotations?.["kubernetes.io/config.mirror"]) return false;
  return !(pod.metadata?.ownerReferences || []).some((owner) => owner.kind === "DaemonSet");
}

exports.handler = async (event) => {
  const detail = event.detail || {};
  const instanceId = detail.EC2InstanceId;
  const autoscaling = new AutoScalingClient({});
  try {
    if (!instanceId) throw new Error("termination event has no EC2InstanceId");
    const secrets = new SecretsManagerClient({});
    const secret = await secrets.send(new GetSecretValueCommand({
      SecretId: process.env.KUBECONFIG_SECRET_ARN,
    }));
    const payload = JSON.parse(secret.SecretString || "{}");
    const text = payload.kubeconfig;
    if (!text) throw new Error("protected kubeconfig payload has no kubeconfig value");
    const config = {
      server: kubeconfigValue(text, "server"),
      ca: kubeconfigValue(text, "certificate-authority-data"),
      cert: kubeconfigValue(text, "client-certificate-data"),
      key: kubeconfigValue(text, "client-key-data"),
    };
    const encodedNode = encodeURIComponent(instanceId);
    await kubeRequest(
      config,
      "/api/v1/nodes/" + encodedNode,
      "PATCH",
      JSON.stringify({ spec: { unschedulable: true } }),
    );

    const deadline = Date.now() + 12 * 60 * 1000;
    while (Date.now() < deadline) {
      const pods = await kubeRequest(
        config,
        "/api/v1/pods?fieldSelector=" + encodeURIComponent("spec.nodeName=" + instanceId),
      );
      const remaining = (pods.items || []).filter(evictable);
      if (remaining.length === 0) break;
      for (const pod of remaining) {
        const namespace = encodeURIComponent(pod.metadata.namespace);
        const name = encodeURIComponent(pod.metadata.name);
        try {
          await kubeRequest(
            config,
            "/api/v1/namespaces/" + namespace + "/pods/" + name + "/eviction",
            "POST",
            JSON.stringify({
              apiVersion: "policy/v1",
              kind: "Eviction",
              metadata: { name: pod.metadata.name, namespace: pod.metadata.namespace },
              deleteOptions: { gracePeriodSeconds: 30 },
            }),
          );
        } catch (error) {
          if (![404, 429].includes(error.statusCode)) throw error;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 10_000));
    }
    const finalPods = await kubeRequest(
      config,
      "/api/v1/pods?fieldSelector=" + encodeURIComponent("spec.nodeName=" + instanceId),
    );
    const drainIncomplete = (finalPods.items || []).some(evictable);
    try {
      await kubeRequest(config, "/api/v1/nodes/" + encodedNode, "DELETE");
    } catch (error) {
      if (error.statusCode !== 404) throw error;
    }
    if (drainIncomplete) {
      throw new Error("pod drain did not complete before the lifecycle deadline");
    }
  } catch (error) {
    console.error("k3s agent drain failed", error);
    throw error;
  }
  await autoscaling.send(new CompleteLifecycleActionCommand({
    AutoScalingGroupName: detail.AutoScalingGroupName,
    LifecycleHookName: detail.LifecycleHookName,
    LifecycleActionToken: detail.LifecycleActionToken,
    LifecycleActionResult: "CONTINUE",
  }));
};
`;
}

type AwsNodeRole = "init-server" | "server" | "agent";

interface AwsK3sCloudInitInput {
  nodeRole: AwsNodeRole;
  isHa: boolean;
  version?: string;
  channel: "stable" | "latest" | "testing";
  clusterTokenSecretArn: string;
  kubeconfigSecretArn: string;
  bootstrapMarkerSecretArn: string;
  expectedServerCount: number;
  region: string;
  joinUrl: string;
  tlsSans: string[];
  installFlags: string[];
  nodeLabels: string[];
  nodeTaints: string[];
  autoScalingGroupName?: string;
  launchLifecycleHookName?: string;
}

function shellQuote(value: string): string {
  return `'${value.split("'").join(`'"'"'`)}'`;
}

function indent(value: string, spaces: number): string {
  const prefix = " ".repeat(spaces);
  return value
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n");
}

function ecrCredentialProviderScript(): string {
  return `#!/usr/bin/env python3
import base64
import json
import re
import subprocess
import sys

request = json.load(sys.stdin)
image = request.get("image", "")
match = re.match(
    r"^(?P<account>\\d{12})\\.dkr\\.ecr\\.(?P<region>[a-z0-9-]+)\\.amazonaws\\.com(?:\\.cn)?/",
    image,
)
if not match:
    raise ValueError("credential request is not for a private ECR image")
raw = subprocess.check_output([
    "/snap/bin/aws", "ecr", "get-authorization-token",
    "--region", match.group("region"),
    "--registry-ids", match.group("account"),
    "--output", "json",
])
payload = json.loads(raw)
auth = {}
for entry in payload.get("authorizationData", []):
    username, password = base64.b64decode(entry["authorizationToken"]).decode().split(":", 1)
    registry = entry["proxyEndpoint"].removeprefix("https://")
    auth[registry] = {"username": username, "password": password}

json.dump({
    "kind": "CredentialProviderResponse",
    "apiVersion": "credentialprovider.kubelet.k8s.io/v1",
    "cacheKeyType": "Registry",
    "cacheDuration": "11h",
    "auth": auth,
}, sys.stdout)
`;
}

/** Build first-boot configuration for a private EC2 k3s host. */
export function buildAwsK3sCloudInit(input: AwsK3sCloudInitInput): string {
  const roleFlags: string[] = [];
  const tlsFlags =
    input.nodeRole === "agent"
      ? []
      : input.tlsSans.map((san) => `--tls-san=${san}`);
  const labelFlags = input.nodeLabels.map((label) => `--node-label=${label}`);
  const taintFlags = input.nodeTaints.map((taint) => `--node-taint=${taint}`);
  const credentialProviderFlags = [
    "--image-credential-provider-config=/var/lib/rancher/credentialprovider/config.yaml",
    "--image-credential-provider-bin-dir=/var/lib/rancher/credentialprovider/bin",
  ];
  const execFlags = [
    ...input.installFlags,
    ...roleFlags,
    ...tlsFlags,
    ...labelFlags,
    ...taintFlags,
    ...credentialProviderFlags,
  ].join(" ");
  const installMode = input.nodeRole === "agent" ? "agent" : "server";
  const versionLine = input.version
    ? `INSTALL_K3S_VERSION=${shellQuote(input.version)}`
    : `INSTALL_K3S_CHANNEL=${shellQuote(input.channel)}`;
  const joinLine = input.nodeRole === "init-server"
    ? `if aws secretsmanager get-secret-value --region ${shellQuote(input.region)} --secret-id ${shellQuote(input.bootstrapMarkerSecretArn)} --query SecretString --output text >/dev/null 2>&1; then
  K3S_URL=${shellQuote(input.joinUrl)}
  export K3S_URL
else
  INSTALL_K3S_EXEC="$INSTALL_K3S_EXEC --cluster-init"
  export INSTALL_K3S_EXEC
  FIRST_BOOTSTRAP=1
fi`
    : `K3S_URL=${shellQuote(input.joinUrl)}
export K3S_URL`;
  const publishKubeconfig =
    input.nodeRole === "init-server"
      ? `
for _ in $(seq 1 180); do
  SERVER_COUNT=$(k3s kubectl get nodes -l sdlc.works/k3s-role=server --no-headers 2>/dev/null | wc -l)
  [ "$SERVER_COUNT" -ge ${input.expectedServerCount} ] && \
    k3s kubectl --server ${shellQuote(input.joinUrl)} get --raw=/readyz 2>/dev/null | grep -qx ok && break
  sleep 5
done
[ "$SERVER_COUNT" -ge ${input.expectedServerCount} ]
k3s kubectl --server ${shellQuote(input.joinUrl)} get --raw=/readyz | grep -qx ok
if [ "${"$"}{FIRST_BOOTSTRAP:-}" = 1 ]; then
  aws secretsmanager put-secret-value --region ${shellQuote(input.region)} \
    --secret-id ${shellQuote(input.bootstrapMarkerSecretArn)} --secret-string ready >/dev/null
fi
sed ${shellQuote(`s|server: https://127.0.0.1:6443|server: ${input.joinUrl}|`)} /etc/rancher/k3s/k3s.yaml > /run/k3s-admin.yaml
python3 - <<'PY'
import json, os
with open('/run/k3s-admin.yaml') as source:
    value = {'publisherInstanceId': os.environ['K3S_NODE_NAME'], 'kubeconfig': source.read()}
with open('/run/k3s-admin-secret.json', 'w') as target:
    json.dump(value, target)
PY
aws secretsmanager put-secret-value --region ${shellQuote(input.region)} \
  --secret-id ${shellQuote(input.kubeconfigSecretArn)} --secret-string file:///run/k3s-admin-secret.json >/dev/null
shred -u /run/k3s-admin.yaml /run/k3s-admin-secret.json`
      : "";
  const signalAgentReady =
    input.nodeRole === "agent" &&
    input.autoScalingGroupName &&
    input.launchLifecycleHookName
      ? `
for _ in $(seq 1 120); do
  systemctl is-active --quiet k3s-agent && break
  sleep 5
done
systemctl is-active --quiet k3s-agent
aws autoscaling complete-lifecycle-action --region ${shellQuote(input.region)} \
  --auto-scaling-group-name ${shellQuote(input.autoScalingGroupName)} \
  --lifecycle-hook-name ${shellQuote(input.launchLifecycleHookName)} \
  --instance-id "$K3S_NODE_NAME" --lifecycle-action-result CONTINUE`
      : "";

  const providerConfig = `apiVersion: kubelet.config.k8s.io/v1
kind: CredentialProviderConfig
providers:
  - name: ecr-credential-provider
    matchImages:
      - "*.dkr.ecr.*.amazonaws.com"
      - "*.dkr.ecr.*.amazonaws.com.cn"
    defaultCacheDuration: "11h"
    apiVersion: credentialprovider.kubelet.k8s.io/v1
`;

  return `#cloud-config
package_update: true
packages:
  - python3
write_files:
  - path: /var/lib/rancher/credentialprovider/bin/ecr-credential-provider
    owner: root:root
    permissions: "0755"
    content: |
${indent(ecrCredentialProviderScript(), 6)}
  - path: /var/lib/rancher/credentialprovider/config.yaml
    owner: root:root
    permissions: "0644"
    content: |
${indent(providerConfig, 6)}
  - path: /usr/local/sbin/sdlc-k3s-bootstrap
    owner: root:root
    permissions: "0700"
    content: |
${indent(`#!/bin/bash
set -euo pipefail
snap list aws-cli >/dev/null 2>&1 || snap install aws-cli --classic
snap list amazon-ssm-agent >/dev/null 2>&1 || snap install amazon-ssm-agent --classic
snap start amazon-ssm-agent || true
export PATH="/snap/bin:$PATH"
IMDS_TOKEN=$(curl -fsS -X PUT -H "X-aws-ec2-metadata-token-ttl-seconds: 21600" http://169.254.169.254/latest/api/token)
K3S_NODE_NAME=$(curl -fsS -H "X-aws-ec2-metadata-token: $IMDS_TOKEN" http://169.254.169.254/latest/meta-data/instance-id)
export K3S_NODE_NAME
K3S_TOKEN=$(aws secretsmanager get-secret-value --region ${shellQuote(input.region)} --secret-id ${shellQuote(input.clusterTokenSecretArn)} --query SecretString --output text)
export K3S_TOKEN
${versionLine}
export ${input.version ? "INSTALL_K3S_VERSION" : "INSTALL_K3S_CHANNEL"}
INSTALL_K3S_EXEC=${shellQuote(execFlags)}
export INSTALL_K3S_EXEC
${joinLine}
curl -fsSL https://get.k3s.io | sh -s - ${installMode}${publishKubeconfig}${signalAgentReady}
`, 6)}
runcmd:
  - [ /bin/bash, /usr/local/sbin/sdlc-k3s-bootstrap ]
`;
}
