name: aws-lambda

definition: >
  Provides a provision-time fleet of on-demand compute functions whose stable
  infrastructure identities exist and are referenceable before any code is deployed.
  Function existence is infrastructure under config review; function code is
  deployment, delivered out-of-band and never reverted by provisioning. It exists
  because apps need serverless execution with stable, infra-addressable function
  identity; without it, function identities could not be wired into traffic
  distributors at provision time and code deployment would be entangled with
  infrastructure reconciliation.

inputs:
  - name: function-fleet-intent
    description: >
      Environment-declared function set with per-function packaging mode, sizing,
      exposure, and lifecycle posture; packaging and identity are fixed under review.
  - name: aws-control-authority
    description: >
      Environment-provided authority to create and govern AWS infrastructure in the
      selected account and region, including read authority over private image
      registry content in that account and region.
  - name: placement-context
    description: >
      Optional private-network placement meaning for functions that must execute
      inside a network fabric.
  - name: authorization-targets
    description: >
      Optional identities of data stores the functions' execution authority must reach.
  - name: deployable-code-artifact
    description: >
      Per-function code content reference delivered at deployment. Image-form
      artifacts must be canonical references into the same-account, same-region
      private image registry; references outside that registry are refused, never
      coerced, until the platform defines artifact content delivery.
  - name: app-function-mapping
    description: >
      App-boundary declaration mapping each app onto exactly one existing function;
      injective, reviewed, and consumed by deployment and connection.

outputs:
  - name: target-identity
    description: >
      Provision-time function identities that a traffic distributor can bind as
      invocation targets.
  - name: public-endpoint
    description: >
      App-facing public invocation endpoint, emitted only where exposure was
      explicitly chosen. The endpoint is origin-addressed: it serves only
      requests addressed by its own provider-assigned name, and it declares
      that addressing constraint so downstream publishers know pure name
      aliasing is insufficient and a re-addressing hop is required.
  - name: function-fleet-identity
    description: >
      Environment-visible identities and endpoints of the provisioned functions.
