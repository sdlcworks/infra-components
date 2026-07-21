---
name: aws-lb
definition: >
  Provides a stable application- or transport-level traffic-distribution point
  for declared targets inside a network. It exists to make exposure scope,
  admission, listener behaviour, and target distribution explicit; without it,
  application traffic would have no reviewed ingress boundary.
inputs:
  - name: traffic-distribution-intent
    description: >
      Environment-declared listener, admission, protocol, and target-distribution
      policy.
  - name: aws-control-authority
    description: >
      Environment-provided authority to create and govern AWS infrastructure in
      the selected account and region.
  - name: placement-context
    description: >
      Network placement meaning provided by a network fabric for locating the
      distributor.
  - name: workload-target-identity
    description: >
      Address-level target meaning supplied by the workload boundary when
      non-serverless targets are declared, including target form, port, health
      semantics, and instance-churn cadence needed to tune admission and drain.
  - name: target-identity
    description: >
      Serverless target identity supplied by a function fleet when functions
      are declared as traffic targets.
outputs:
  - name: origin-address
    description: >
      Stable address meaning that an edge-delivery subsystem can use as a
      dynamic origin.
  - name: target-attachment-point
    description: >
      Attachment-slot identity provided to the workload boundary so it can
      steer per-instance addresses into the distribution point as instances are
      created, replaced, and drained.
  - name: traffic-distributor-identity
    description: >
      Environment-visible identity and endpoint meaning of the traffic
      distributor.
---
