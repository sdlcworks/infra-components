---
name: aws-rds
definition: >
  Provides managed relational database instances whose durability posture --
  engine identity, storage growth, backup retention, final-snapshot and
  deletion protection, encryption at rest -- is fixed under configuration
  review and never touched by deployment. Admission is closed by default: only
  declared network sources reach an instance. Because the provider offers no
  means to mint per-application database principals, an application allocated
  to an instance receives that instance's administrative credential and its one
  database; separation between applications is therefore separation between
  instances. It exists because relational state is a data-loss boundary and an
  engine or identity change silently replaces the store; without it,
  applications would reshape or re-anchor durable databases outside
  infrastructure review.
inputs:
  - name: database-intent
    description: >
      Environment-declared engine, size, storage, backup, protection,
      parameter, replica, and credential-publication posture for each database
      instance.
  - name: aws-control-authority
    description: >
      Environment-provided authority to create and govern AWS infrastructure in
      the selected account and region.
  - name: placement-context
    description: >
      Private-network placement meaning provided by a network fabric, spanning
      at least two availability zones so a managed instance can be placed
      redundantly.
  - name: admitted-source-identity
    description: >
      Network identity of the sources permitted to reach the databases, so
      transport admission is scoped to exactly those sources; fully open
      admission is refused unless every instance is declared publicly
      reachable.
  - name: database-access-request
    description: >
      Application-boundary request naming which declared instance an
      application needs.
outputs:
  - name: database-access
    description: >
      Application-facing connection meaning carrying the credentialed primary
      endpoint, a read-only endpoint when replicas exist, and the component
      parts an application may compose itself; refused when the requested
      dialect is not the allocated instance's engine.
  - name: credential-custody-reference
    description: >
      Reference to the provider-held secret carrying the instance's
      administrative credential, so operators and managed services can read it
      without it travelling through environment declarations.
  - name: admission-target
    description: >
      Network-admission identity of the database tier that compute subsystems
      reference to be admitted.
  - name: database-identity
    description: >
      Environment-visible identity, reachability, and replica posture of the
      declared database instances.
---
