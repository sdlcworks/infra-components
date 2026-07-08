---
name: cloudflare-dns
definition: >
  Publishes app components' advertised public endpoints under names in an
  owned domain zone, upholding the invariant that every published name
  serves its bound app's behaviour — not merely that a name resolves.
  Where an origin declares an addressing constraint (it serves only requests
  addressed by its own provider-assigned name), pure name aliasing cannot
  uphold the invariant; this register then provisions a managed edge hop
  that re-addresses traffic to the origin's own name, keeping the constraint
  invisible to the publication intent. A publication intent that withdraws
  the edge from a constraint-bearing origin is refused, never silently
  coerced. It exists because apps advertise provider-assigned endpoints
  while the system's identity lives in owned domain names; without it, owned
  names could not be bound to running apps, or the binding would silently
  break for constraint-bearing origins.
inputs:
  - name: publication-intent
    description: >
      Environment-declared owned root domain and the mapping of each
      published name under it to either an app component or a pre-existing
      edge compute service, with per-name edge posture such as proxying,
      caching lifetime, and record-shape overrides.
  - name: public-endpoint
    description: >
      Each bound app component's advertised public endpoint with its
      reachability meaning — scheme, port, transport mode — and its
      addressing constraint: whether the origin serves only requests
      addressed by its own origin name. The constraint selects between
      pure name aliasing and the managed re-addressing hop.
  - name: edge-control-authority
    description: >
      Environment-provided authority over the domain's zone and its edge
      compute account, sufficient to manage names, routes, and the managed
      re-addressing hop.
outputs:
  - name: published-urls
    description: >
      The authoritative public URL for every published name, for downstream
      consumption and environment visibility; each URL is guaranteed to
      serve its bound target's behaviour.
---
