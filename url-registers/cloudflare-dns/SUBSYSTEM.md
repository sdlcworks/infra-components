---
name: cloudflare-dns
definition: >
  Publishes app components' advertised public endpoints under names in an
  owned domain zone, upholding the invariant that every published name serves
  its bound app's behaviour -- not merely that a name resolves. An endpoint
  with a separate required request host may be published only at that exact
  name, with the incoming host preserved. An origin-addressed endpoint without
  such a public-host requirement instead retains the managed edge hop that
  re-addresses requests to the provider-assigned origin name; withdrawing the
  required edge posture is refused. Declaring both request-host meanings is
  refused because preserving and rewriting the incoming host are mutually
  exclusive. It exists because routable origin addresses and accepted request
  identities are not always the same meaning; without it, owned names could
  resolve while the bound application still rejects the request identity it
  receives.
inputs:
  - name: publication-intent
    description: >
      Environment-declared owned root domain and the mapping of each
      published name under it to either an app component or a pre-existing
      edge compute service, with per-name edge posture such as proxying,
      caching lifetime, and record-shape overrides. A mapped name must equal
      any separate required request-host identity declared by its endpoint;
      origin-addressed endpoints require the managed edge posture that preserves
      their re-addressing path.
  - name: public-endpoint
    description: >
      Each bound app component's advertised public endpoint with its
      reachability meaning -- scheme, origin address, port, and transport mode
      -- and one of two distinct request-host meanings when applicable. A
      separate required public host selects exact-name publication with the
      incoming host preserved; origin-addressed meaning selects a managed
      re-addressing hop from the published name to the provider origin. An
      endpoint carrying both meanings is refused as contradictory.
  - name: edge-control-authority
    description: >
      Environment-provided authority over the domain's zone and its edge
      compute account, sufficient to manage names, routes, and the re-addressing
      hop required by origin-addressed endpoints.
outputs:
  - name: published-urls
    description: >
      The authoritative public URL for every published name, for downstream
      consumption and environment visibility; each URL is guaranteed to serve
      its bound target under the endpoint's declared request-host semantics.
---
