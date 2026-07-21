---
name: lightweight-container-cluster
definition: >
  Provides one provider-selected fleet of virtual-machine hosts joined into a
  lightweight container-orchestration cluster, then allocates declared
  applications as long-running, stateful, scheduled, one-shot, or node-wide
  workloads. The Google Cloud realization supports individually declared hosts
  or fixed and autoscaled machine groups, including its established
  host-addressed bootstrap and optional cloud traffic integration. The AWS
  realization instead keeps fixed server hosts and replaceable agent pools in
  private placement, with stable and separately admitted control-plane and
  public-workload traffic surfaces and no public host-management path. Across
  both realizations the cluster owns bootstrap, membership, workload placement,
  registry authorization, rollout observation, in-cluster naming, and workload
  ingress as interior responsibilities. Infrastructure reconciliation governs
  cluster topology, release, add-ons, storage posture, identities, and workload
  declarations; deployment changes allocated workload content and runtime
  environment without redefining infrastructure. It exists because
  applications need one infra-addressable execution boundary with common
  allocation and connection behaviour across the supported cloud
  realizations; without it, applications would own host bootstrap, cluster
  membership, exposure, and deployment mechanics individually.
inputs:
  - name: cluster-fleet-intent
    description: >
      Environment-declared common cluster release, network address spaces,
      add-on, observability, workload-default, and storage posture together with
      provider-specific host topology. Google Cloud intent selects individual
      hosts or machine groups, host addressing, placement, replacement, and
      optional cloud traffic integration. AWS intent selects one fixed server
      or an odd high-availability server count of at least three, bounded fixed
      or autoscaled agent pools, reviewed private image repositories, encrypted
      host storage, private host placement, and separate control-plane and
      public-workload admission. Interruptible AWS capacity is confined to
      replaceable agent pools, and AWS durable database workloads are refused
      until durable network storage is provided.
  - name: aws-control-authority
    description: >
      Environment-provided authority used only when the selected realization is
      AWS, sufficient to govern the cluster's EC2 hosts, encrypted host
      storage, narrowly scoped host identities, protected bootstrap state,
      autoscaling, replacement observation, and distinct control-plane and
      workload traffic surfaces in the selected account and region.
  - name: gcloud-control-authority
    description: >
      Environment-provided authority used only when the selected realization is
      Google Cloud, sufficient to govern compute, storage, host bootstrap
      identity, network admission, scaling, and optional cloud traffic surfaces
      in the selected project and region.
  - name: placement-context
    description: >
      AWS network-fabric identity and address space, private placement tiers,
      availability-zone distribution, routed egress posture, and optional public
      ingress tiers, used only for the AWS realization and required to share the
      selected AWS authority scope. Every host requires private placement;
      public tiers are consumed only by explicitly public control-plane or
      workload traffic surfaces.
  - name: gcloud-placement-context
    description: >
      Google Cloud project, region, network-fabric identity and address space,
      host placement, availability distribution, routed egress posture, and
      selected public host reachability, used only for the Google Cloud
      realization and required to share the selected Google Cloud authority
      scope.
  - name: workload-allocation-intent
    description: >
      App-boundary mapping of each app to one declared workload kind together
      with namespace, service exposure, resource and scaling bounds, health,
      scheduling, runtime environment, volume, and update posture. Public
      exposure and durable-state claims are explicit; a stateful workload that
      names no durable storage posture receives no durability guarantee from
      replaceable hosts.
  - name: deployable-image-artifact
    description: >
      Per-app OCI container-image reference delivered at deployment together
      with the registry authorization meaning required for cluster hosts to pull
      it. An artifact whose registry is not reachable and authorized from the
      selected placement is refused rather than treated as deployed.
  - name: workload-connection-material
    description: >
      Typed endpoint, credential, and authorization meaning supplied by declared
      app dependencies and injected only into the consuming workload's runtime
      environment. The cluster transports this meaning but does not widen its
      authority or expose it through cluster identity outputs.
outputs:
  - name: public-endpoint
    description: >
      Application-facing endpoint carrying scheme or transport mode, routable
      origin address, and port from the realization's available public workload
      surface. A host-routed ingress additionally carries a separate required
      request-host identity; when present, a downstream publisher must bind
      exactly that public name and preserve the incoming host while retaining
      the origin address only as routing meaning. AWS emits public HTTP
      endpoints only for workloads with reviewed ingress on its stable workload
      traffic surface; the established Google Cloud realization may also expose
      a host address without a separate required request host.
  - name: internal-service-endpoint
    description: >
      App-facing in-cluster service address and protocol meaning for a declared
      service dependency, including scoped database connection meaning where the
      allocated workload provides a database. It is reachable only from
      workloads admitted to the same cluster network and never transits the
      public workload surface.
  - name: cluster-fleet-identity
    description: >
      Environment-visible, credential-free cluster identity containing the
      stable control-plane address and host identities and addressing, together
      with provider, region, agent-pool, availability, and public
      workload-surface meaning where the selected realization emits them.
      Cluster join secrets, host-management authority, and administrative client
      credentials remain lifecycle state and are never part of this output.
---
