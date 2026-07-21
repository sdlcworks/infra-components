---
name: application-portfolio
definition: >
  Owns reviewed application-to-runtime mappings, deployable release artifacts,
  and requests for infrastructure-backed capabilities, and receives the scoped
  addresses and access meanings returned to applications. It exists because
  application allocation, deployment content, dependency choice, and access
  requests belong to the application boundary rather than any hosting, data,
  or delivery subsystem's interior; without it, application intent and
  infrastructure authority would be indistinguishable.
inputs:
  - name: internal-service-endpoint
    description: >
      Private service address and protocol meaning returned to applications for
      declared dependencies that remain inside their shared hosting network.
  - name: database-access
    description: >
      Credentialed document-database connection meaning scoped to the
      requesting application.
  - name: object-store-access
    description: >
      Stable object-store coordinates returned under an application's existing
      execution authority.
  - name: table-access
    description: >
      Table coordinates and reviewed access level returned to a requesting
      application.
  - name: edge-delivery-address
    description: >
      Public edge address returned to applications for delivered content or
      application traffic.
outputs:
  - name: workload-allocation-intent
    description: >
      Reviewed application-to-workload mapping with workload kind, namespace,
      service exposure, resources, scaling, health, scheduling, runtime
      environment, volume, and update posture.
  - name: deployable-image-artifact
    description: >
      Per-application container-image identity and registry authorization
      meaning supplied by an application release for deployment to its
      allocated workload.
  - name: deployable-code-artifact
    description: >
      Per-application function-code content identity supplied by an application
      release for deployment to its allocated function.
  - name: workload-connection-material
    description: >
      Typed endpoint, credential, and authorization meanings declared for each
      application's dependencies and scoped only to the consuming workload.
  - name: app-service-mapping
    description: >
      Reviewed injective mapping from each allocated application to one
      provisioned long-running service identity.
  - name: app-function-mapping
    description: >
      Reviewed injective mapping from each allocated application to one
      provisioned function identity.
  - name: database-access-request
    description: >
      Application-boundary request for an isolated logical database and its
      required access roles.
  - name: object-store-access-request
    description: >
      Application-boundary request for stable object-store coordinates under
      the application's existing execution authority.
  - name: table-access-request
    description: >
      Application-boundary request naming the reviewed tables and access level
      required by the application.
---
