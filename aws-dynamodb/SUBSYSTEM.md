---
name: aws-dynamodb
definition: >
  Provides durable AWS-managed serverless tables with reviewed key schemas and
  application-selected access. It exists because key schema and recoverability
  choices are data-loss boundaries; without it, applications would select or
  reshape durable tables outside infrastructure review.
inputs:
  - name: table-store-intent
    description: >
      Environment-declared table schema, capacity, recovery, protection, and
      indexing posture.
  - name: aws-control-authority
    description: >
      Environment-provided authority to create and govern AWS infrastructure in
      the selected account and region.
  - name: table-access-request
    description: >
      Application-boundary request naming which declared tables an application
      needs and the level of access it requires.
outputs:
  - name: table-access
    description: >
      Application-facing table access meaning containing table coordinates and
      the declared access level.
  - name: authorization-targets
    description: >
      Data-store target meaning that compute subsystems can use to authorize
      access to declared tables.
  - name: table-store-identity
    description: >
      Environment-visible identity and stream posture of the declared table
      store.
---
