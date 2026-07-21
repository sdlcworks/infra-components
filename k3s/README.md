# k3s infrastructure component

The `k3s` component provides the same app allocation, internal service discovery,
OCI deployment, and connection behavior on GCP and AWS. The AWS realization uses
private EC2 hosts and stable Network Load Balancer identities rather than exposing
individual instances.

## AWS design

- Servers are fixed, encrypted, non-Spot EC2 instances. `servers.count` must be
  `1`, or an odd HA count of at least `3`.
- Agent pools use EC2 launch templates and Auto Scaling Groups. Each pool has
  reviewed min, desired, and max capacity and may use On-Demand or Spot capacity.
- All hosts use private subnets, require IMDSv2, and have no public IP or inbound
  SSH. AWS Systems Manager Session Manager is the host-management path.
- The cluster join token and administrative kubeconfig are protected in AWS
  Secrets Manager. Neither is emitted as a component output.
- A control-plane NLB gives servers and agents a stable registration address.
  It may be internal or explicitly public with reviewed CIDR admission.
- An optional, separate public NLB exposes Traefik on ports 80 and 443. Cluster
  overlay, kubelet, and embedded-etcd ports accept traffic only from node security
  groups and are never CIDR-exposed.
- Private ECR pulls use a kubelet exec credential provider backed by the node IAM
  role; no expiring ECR token is stored in Kubernetes image-pull secrets.

Private subnets need routed HTTPS egress for the k3s installer, Ubuntu packages,
AWS APIs, Helm repositories, and container registries. The provisioning runtime
must also be able to reach the control NLB. For an internal control plane this
normally means running inside the VPC or through connected private networking.

## AWS configuration example

```yaml
aws:
  vpcId: vpc-0123456789abcdef0
  privateSubnetIds:
    - subnet-private-a
    - subnet-private-b
    - subnet-private-c
  publicSubnetIds:
    - subnet-public-a
    - subnet-public-b
  ecrRepositoryArns:
    - arn:aws:ecr:us-east-1:123456789012:repository/apps/*

  servers:
    count: 3
    instanceType: t3.small
    architecture: x86_64
    rootVolumeSizeGb: 40
    rootVolumeType: gp3
    rootVolumeEncrypted: true

  agentPools:
    general:
      instanceType: m7i.large
      architecture: x86_64
      capacityType: on-demand
      minSize: 2
      desiredSize: 2
      maxSize: 6
      targetCpuUtilization: 65
      rootVolumeSizeGb: 80
      rootVolumeType: gp3
      rootVolumeEncrypted: true
      labels:
        workload-class: general
      taints: []

  controlPlane:
    public: false
    # Must explicitly admit the Pulumi runner (or its VPC/NAT CIDR).
    allowedCidrs: ["10.0.0.0/16"]

  workloadIngress:
    enabled: true
    allowedCidrs:
      - 0.0.0.0/0
```

For an internet-facing control plane, set `controlPlane.public: true`, provide at
least two public subnets, and set `allowedCidrs` to the narrow administrative
networks that need Kubernetes API access. Public TCP and PostgreSQL listeners are
not inferred: the current AWS public surface exposes HTTP workloads through
Traefik only.

`postgresClusterConfig` is currently refused on AWS because this realization
does not yet provision a durable CSI-backed storage class. This prevents
CloudNativePG data from silently landing on replaceable node-local disks.

The default AMI lookup selects Canonical Ubuntu 24.04 from owner `099720109477`.
Set `amiId` on the server or agent-pool declaration to use a reviewed golden AMI;
it must retain Ubuntu-compatible systemd, snapd, curl, and Python 3 bootstrap
facilities, including the `/snap/bin/aws` path installed by cloud-init.
Server AMI, bootstrap/runtime settings, count, VPC, and subnet topology cannot
be changed in place because automatic fixed-server replacement is unsafe for
embedded etcd; perform an explicit cluster migration instead. Agent pools must
be scaled to `minSize: 0` and `desiredSize: 0` in a successful update before
removal. Nonempty pools are deletion-protected so their drain hooks cannot be
removed ahead of their instances. A
single-server cluster intentionally refuses to form a fresh datastore after its
bootstrap marker exists, so recovery requires restoring that server's datastore
or replacing the cluster. Use three servers for automated instance recovery.
