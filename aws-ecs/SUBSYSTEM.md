---
name: aws-ecs

definition: >
  Provides a provision-time fleet of long-running container services on
  provider-managed serverless capacity, grouped under one reviewed layered
  configuration: fleet-wide defaults that every per-service declaration may
  override. Service existence and every identity a service carries -- the
  split between execution authority and application authority, sizing,
  scaling bounds, network posture, deployment and rollback posture,
  persistent-volume and log identities -- are infrastructure under config
  review; container image content is deployment, delivered out-of-band and
  never reverted by provisioning. For services declaring a staged-cutover
  deployment posture, the fleet owns the entire cutover surface as interior
  mechanism -- a dedicated traffic-distribution surface per such service,
  both target slots, the pre-cutover test surface, and the rule swap -- so
  no deploy-time mutation ever reaches an exterior distributor. In-fleet
  reachability meaning is scoped to a discovery namespace whose identity the
  environment declares and owns, and may later share across fleets. It
  exists because apps need always-on container execution with stable,
  infra-addressable service identity; without it, service targets could not
  be wired into traffic distributors at provision time and image rollout
  would be entangled with infrastructure reconciliation.

inputs:
  - name: service-fleet-intent
    description: >
      Environment-declared service set under layered configuration:
      fleet-wide defaults -- capacity posture, observability, deployment and
      rollback posture, sizing defaults, and the declared discovery-namespace
      identity, which the environment owns and may share across fleets --
      each overridable by the corresponding per-service declaration, with the
      per-service declaration winning. Per-service declarations cover sizing,
      scaling bounds, exposure, deployment and rollback posture, and
      persistent-volume declaration; identities are fixed under review. A
      service declaring both a staged-cutover deployment posture and
      attachment to an external traffic distributor is refused -- cutover
      cannot span a boundary the fleet does not own.
  - name: aws-control-authority
    description: >
      Environment-provided authority to create and govern AWS infrastructure
      in the selected account and region, including read authority over
      private image registry content in that account and region.
  - name: placement-context
    description: >
      Private-network placement meaning provided by a network fabric. Every
      service instance resides inside the fabric, so placement is required,
      not optional.
  - name: authorization-targets
    description: >
      Optional identities of data stores the services' application authority
      must reach.
  - name: target-attachment-point
    description: >
      Attachment-slot identity provided by a traffic distributor, into which
      the fleet steers per-instance addresses as instances are created,
      replaced, and drained; taken only for services without a staged-cutover
      deployment posture that choose composed or shared routing.
  - name: filesystem-attachment
    description: >
      Optional mount coordinates and per-consumer enforced filesystem identity
      provided by a shared filesystem, for services whose declared volumes
      must persist beyond any instance's lifetime.
  - name: edge-certificate
    description: >
      Environment-provided certificate authority meaning required when custom
      public names are declared for a service whose distribution surface the
      fleet owns.
  - name: deployable-image-artifact
    description: >
      Per-service container image reference delivered at deployment. Image
      references must be canonical references into the same-account,
      same-region private image registry; references outside that registry are
      refused, never coerced.
  - name: app-service-mapping
    description: >
      App-boundary declaration mapping each app onto exactly one existing
      service; injective, reviewed, and consumed by deployment and connection.

outputs:
  - name: workload-target-identity
    description: >
      Address-level target meaning for services without a staged-cutover
      deployment posture declared as targets of an external traffic
      distributor: target form and port, health semantics, and the
      instance-churn cadence the distributor needs to tune admission and
      drain.
  - name: public-endpoint
    description: >
      App-facing public endpoint of a service whose staged-cutover
      distribution surface the fleet owns, emitted only where that posture
      and public exposure are declared. The endpoint is not origin-addressed and
      carries no separate required request host: it accepts requests under
      custom public names, so a downstream publisher may bind a name directly
      without a re-addressing hop. Custom public names require the
      environment-provided certificate authority meaning.
  - name: mount-consumer-identity
    description: >
      Network and application-authority identity of services declaring
      persistent volumes, so a shared filesystem can scope transport admission
      and access authorization to exactly the declared consumers.
  - name: internal-service-endpoint
    description: >
      App-facing in-fleet address meaning by which one hosted app reaches
      another without leaving the network fabric or transiting the public
      edge. Reachability is scoped to the declared discovery namespace; the
      environment may later share that namespace across fleets, widening
      reachability without changing this relation's meaning.
  - name: service-fleet-identity
    description: >
      Environment-visible identities, status, and endpoints of the provisioned
      services.
---
