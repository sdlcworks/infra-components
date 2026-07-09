---
name: aws-efs

definition: >
  Provides a durable, network-resident shared filesystem whose lifetime is
  independent of any workload that mounts it. Every property is fixed under
  config review -- protection at rest, throughput and performance posture,
  aging-data lifecycle, per-availability-zone reachability, and the
  per-consumer enforced filesystem identity and scoped root each declared
  consumer receives; deployment never touches it. It exists because persistent
  state shared across replaceable compute instances is a data-loss boundary;
  without it, re-provisioning a workload would destroy its state, or shared
  state would ride on storage that admits undeclared consumers.

inputs:
  - name: filesystem-intent
    description: >
      Environment-declared protection, throughput, performance, aging-data
      lifecycle, and per-consumer identity posture for the shared filesystem.
  - name: aws-control-authority
    description: >
      Environment-provided authority to create and govern AWS infrastructure
      in the selected account and region.
  - name: placement-context
    description: >
      Private-network placement meaning provided by a network fabric; the
      filesystem is reachable only through per-availability-zone points inside
      the fabric.
  - name: mount-consumer-identity
    description: >
      Network and application-authority identity of the workloads declared as
      consumers, so transport admission and access authorization are scoped to
      exactly those consumers and no others.

outputs:
  - name: filesystem-attachment
    description: >
      Mount coordinates plus the per-consumer enforced filesystem identity and
      scoped root, together with the transport-encryption and authorization
      posture a consumer must honor to mount.
  - name: filesystem-identity
    description: >
      Environment-visible identity, protection, and reachability posture of
      the shared filesystem.
---
