---
name: aws-vpc

definition: >
  Provides the private AWS network fabric for branch infrastructure. It exists
  to make address architecture, placement tiers, routing surfaces, and egress
  cost posture explicit; without it, network-resident systems would inherit
  unsafe or costly provider defaults.

inputs:
  - name: network-fabric-intent
    description: >
      Environment-declared address, placement, reachability, and egress posture
      that defines the network fabric.
  - name: aws-control-authority
    description: >
      Environment-provided authority to create and govern AWS infrastructure in
      the selected account and region.

outputs:
  - name: placement-context
    description: >
      Network identity and address space, availability-zone distribution,
      public and private placement tiers, route surfaces, and stable egress
      posture needed by systems that must reside in or expose traffic through
      the fabric.
  - name: attachment-surface
    description: >
      Network identity, address range, private placement, and routing surfaces
      needed by an interconnect hub.
  - name: traffic-insertion-surface
    description: >
      Network identity, endpoint placement, and routing surfaces needed to
      insert an inspection path into traffic flow.
  - name: network-fabric-identity
    description: >
      Environment-visible identity and posture of the created network fabric.
---
