# SUBSYSTEM.md - DynamoDB Managed Table

## name

dynamo-db

## definition

Declares and upholds the existence of one managed key-value/document table with a fixed key identity and user-chosen safety, capacity, indexing, and streaming behaviour. It exists so that a running system can persist and query structured state at scale without operating a database server. Its load-bearing invariant is that the table's identity is immutable in place and its data must be recoverable across the table's life, so the subsystem exposes identity to consumers and defends data through recoverability rather than deletion refusal. Without it, stateful AWS-resident workloads on the platform would have no first-class managed store whose shape is fully user-declared.

## inputs

### provider-injection

The AWS provider bound to the platform's AWS credential identity and region. This must flow inward because the table is materialized in the credential's region under the credential's identity; the subsystem never chooses region itself.

### validated-declaration

The user's fully validated table shape, including keys, attributes, billing, indexes, streams, time-to-live, recoverability, encryption, storage class, protection posture, access policy, and tags. This must flow inward because the table cannot be declared until its shape is internally consistent.

### identity-continuity

The previously persisted table identity. This must flow inward so consumers can be answered without re-deriving identity and so repeated provisioning cycles recognize the same table.

### catalogue-registration

The act of being discovered and projected as a selectable infrastructure catalogue entry with its declared configuration, output, and connection schemas. This must flow inward for the component to be attachable to a branch.

## outputs

### resource-declaration

The desired managed-table resource declaration and optional resource-policy declaration. This flows outward because provisioning is the act of declaring the table's shape to the cloud control plane.

### identity-persistence

The table identity captured after provisioning. This flows outward so identity survives across provisioning cycles and reaches connection handling.

### table-identity

The table name, table address, credential region, and optional stream address exposed to consumers. This flows outward because a consumer reaches the table with its own AWS identity plus this table identity; the subsystem supplies identity, not permission or a secret.

### provision-outputs

Observable table identity and stream identity for platform reference independent of consumer wiring. This flows outward so the platform can report what was provisioned.
