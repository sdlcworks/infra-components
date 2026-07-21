---
name: public-url
definition: >
  Binds an app component's advertised endpoint to its declared owned-domain
  public name while keeping routing and request-host identity coherent across
  the selected publication posture. A separate required request host must equal
  the declared public name and is preserved. A managed edge-proxy publication
  for an endpoint without that requirement retains its origin re-addressing
  hop, while a host-preserving provider traffic boundary carries the public host
  through unchanged. An endpoint declaring both preservation and
  origin-addressed meanings is refused as contradictory. It exists because a
  single published URL must identify both a routable endpoint and a request
  identity the endpoint will serve; without it, successful name resolution
  could conceal an unusable binding.
inputs:
  - name: publication-intent
    description: >
      Environment-declared owned-domain mapping from the app component to its
      public name and either managed edge-proxy or host-preserving provider-edge
      posture. The mapped name must equal any separate required request-host
      identity declared by the endpoint.
  - name: public-endpoint
    description: >
      The app component's advertised scheme or transport mode, origin address,
      port, provider-service identity where required by the selected posture,
      and any separate required request-host identity. A required public host is
      preserved exactly; a managed edge-proxy posture re-addresses an endpoint
      without that requirement to its origin, while the provider-edge posture
      preserves the public host. The two request-host meanings may not be
      declared together.
  - name: edge-control-authority
    description: >
      Environment-provided authority over the selected public-name and edge
      boundaries, sufficient to bind the declared name through either managed
      edge re-addressing or a host-preserving provider traffic surface.
outputs:
  - name: published-urls
    description: >
      The authoritative public URL for the bound component, guaranteed to reach
      its endpoint under the request-host semantics of the selected publication
      posture.
---
