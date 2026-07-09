---
name: aws-s3

definition: Provides one stable, infra-addressable, permanently non-public object store per subsystem instance. It exists because edge origins and apps need a component-granular object identity; without it, object storage would either be per-app allocation or publicly reachable policy surface.

inputs:
  - name: object-store-intent
    description: Environment-declared durability, recoverability, retention, and access posture for the object store.
  - name: aws-control-authority
    description: Environment-provided authority to create and govern AWS infrastructure in the selected account and region.
  - name: object-store-access-request
    description: App-boundary request to receive object-store coordinates under the app's existing execution authority.

outputs:
  - name: origin-identity
    description: Object-origin identity that an edge delivery subsystem can use to front non-public objects.
  - name: object-store-access
    description: App-facing object-store access meaning containing stable object-store coordinates.
  - name: object-store-identity
    description: Environment-visible identity and region meaning of the object store.
---
