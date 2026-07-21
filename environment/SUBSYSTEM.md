---
name: infrastructure-environment
definition: >
  Owns reviewed infrastructure intent, provider and edge authority boundaries,
  adopted external identities, and environment-wide placement choices, and
  receives credential-free identities and published addresses from the
  infrastructure it governs. It exists because infrastructure subsystems
  require policy, placement, and authority selected outside their interiors;
  without it, those meanings would be unmatched or embedded independently
  inside each provider subsystem.
inputs:
  - name: cluster-fleet-identity
    description: >
      Credential-free control-plane address and host identities and addressing,
      together with any emitted provider, region, agent-pool, availability, and
      workload-surface meaning returned for environment visibility.
  - name: network-fabric-identity
    description: >
      Identity and posture of a provisioned network fabric returned for
      environment visibility and composition with network-resident systems.
  - name: published-urls
    description: >
      Authoritative owned-domain addresses returned for environment visibility
      after declared public endpoints are published under their applicable
      request-host semantics.
  - name: service-fleet-identity
    description: >
      Provisioned long-running service identities, status, and endpoints
      returned for environment visibility.
  - name: function-fleet-identity
    description: >
      Provisioned function identities and endpoints returned for environment
      visibility.
  - name: edge-distribution-identity
    description: >
      Provisioned edge-delivery identity and operational posture returned for
      environment visibility.
  - name: object-store-identity
    description: >
      Provisioned object-store identity, protection posture, and region returned
      for environment visibility.
  - name: table-store-identity
    description: >
      Provisioned table-store identity and stream posture returned for
      environment visibility.
  - name: filesystem-identity
    description: >
      Provisioned shared-filesystem identity, protection, and reachability
      posture returned for environment visibility.
  - name: interconnect-identity
    description: >
      Provisioned routing-hub identity, attachments, and policy surfaces
      returned for environment visibility.
  - name: inspection-service-identity
    description: >
      Provisioned inspection-service identity and insertion points returned for
      environment visibility.
  - name: traffic-distributor-identity
    description: >
      Provisioned traffic-distribution identity and endpoint meaning returned
      for environment visibility.
  - name: document-store-identity
    description: >
      Credential-free document-store project, cluster, and reachability meaning
      returned for environment visibility.
outputs:
  - name: cluster-fleet-intent
    description: >
      Reviewed provider selection, cluster topology, host-pool, release,
      availability, storage, observability, address-space, and admission posture
      for the environment's lightweight container cluster.
  - name: service-fleet-intent
    description: >
      Reviewed long-running service set, capacity, exposure, deployment,
      discovery, persistence, and observability posture.
  - name: function-fleet-intent
    description: >
      Reviewed function set with packaging, sizing, exposure, and lifecycle
      posture.
  - name: edge-delivery-intent
    description: >
      Reviewed origin, caching, transport protection, geographic, and cost
      posture for public edge delivery.
  - name: object-store-intent
    description: >
      Reviewed durability, recoverability, retention, and access posture for an
      object store.
  - name: table-store-intent
    description: >
      Reviewed table schema, capacity, recovery, protection, and indexing
      posture.
  - name: filesystem-intent
    description: >
      Reviewed protection, throughput, performance, lifecycle, and consumer
      identity posture for a shared filesystem.
  - name: interconnect-policy
    description: >
      Reviewed attachment, route association, propagation, and reachability
      intent for connected network fabrics.
  - name: appliance-insertion-intent
    description: >
      Reviewed inspection admission, appliance participation, and traffic
      redirection policy.
  - name: traffic-distribution-intent
    description: >
      Reviewed listener, admission, protocol, and target-distribution policy.
  - name: document-store-intent
    description: >
      Reviewed document-store project, topology, sizing, backing cloud,
      recoverability, and termination-protection posture.
  - name: aws-control-authority
    description: >
      Authority over the selected AWS account and region, supplied only to
      environment infrastructure whose declared realization requires it.
  - name: gcloud-control-authority
    description: >
      Authority over the selected Google Cloud project and region, supplied
      only to environment infrastructure whose declared realization requires
      it.
  - name: atlas-control-authority
    description: >
      Authority over the selected document-database organization or project,
      supplied only to the governed document store.
  - name: edge-control-authority
    description: >
      Authority over the selected domain zone and its public edge account,
      supplied to public-name and edge-delivery infrastructure.
  - name: edge-certificate
    description: >
      Reviewed certificate authority meaning supplied when custom public names
      require protected edge transport.
  - name: gcloud-placement-context
    description: >
      Google Cloud project, region, network identity, address space, placement,
      availability distribution, routed egress, and selected public reachability
      of an environment-owned or adopted network fabric.
  - name: network-fabric-intent
    description: >
      Reviewed address, placement, reachability, routing, endpoint, and egress
      posture for a network fabric provisioned as part of the environment.
  - name: publication-intent
    description: >
      Reviewed owned-domain mapping from advertised application endpoints to
      public names, including the edge posture required by each endpoint's
      request-host semantics. A required request host must equal the published
      name and remain unchanged; an origin-addressed endpoint instead retains
      its managed re-addressing path when published under another name. An
      endpoint declaring both meanings is contradictory and must be refused.
  - name: network-admission-declaration
    description: >
      Reviewed public network addresses from which governed consumers may reach
      an externally operated document store.
  - name: appliance-target-identity
    description: >
      Reviewed identity of adopted inspection appliances that may participate
      in the environment's traffic-inspection service.
---
