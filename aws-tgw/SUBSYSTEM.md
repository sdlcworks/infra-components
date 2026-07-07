name: aws-tgw

definition: Provides an inter-network routing hub governed by explicit reachability policy. It exists to connect multiple network fabrics without creating an implicit any-to-any mesh; without it, attachments and return routes would be distributed across networks with no single routing invariant.

inputs:
  - name: interconnect-policy
    description: Environment-declared attachment, association, propagation, and reachability intent for connected networks.
  - name: aws-control-authority
    description: Environment-provided authority to create and govern AWS infrastructure in the selected account and region.
  - name: attachment-surface
    description: Network attachment meaning supplied by each participating network fabric.

outputs:
  - name: interconnect-identity
    description: Environment-visible identity of the routing hub, its network attachments, and its routing policy surfaces.
