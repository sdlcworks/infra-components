---
name: function-deployment
definition: >
  A public content witness preserves the admitted digest algorithm and value
  after verifying the complete deployed bytes under that algorithm. Historical
  admitted identities are not silently upgraded, relabelled or replaced by a
  new calculation. Unsupported or malformed identity refuses elected proof;
  absence retains legacy behaviour only when no public proof is elected.
  Preserves the identity and settings of allocated functions while delivering
  the exact selected application release into their provider-owned execution
  surface. Provisioning establishes resource identity; deployment updates code
  within that retained identity rather than recreating infrastructure. Declared
  public delivery is part of deployment: the owner reconciles only the exact
  admitted route to the retained function and refuses conflicting foreign
  ownership. Missing acknowledgement is resolved by exact observation, never
  by adopting another function or overwriting an unrelated route.
  A declaration requiring public-release proof binds the selected release and
  exact artifact content to a witness served by that deployed function. Success
  requires observing that witness at the admitted public destination. Stale
  release, wrong content, unrelated successful pages, redirects and unavailable
  observation cannot establish completion. Observation is bounded and limited
  to the protected public address whose host agrees with the declared route;
  caller-supplied alternate destinations and credential forwarding are refused.
  Provider-specific proof and routing use only admitted provider authority;
  browser-held credentials are not a prerequisite. Existing declarations without
  this proof election retain their previous deployment behaviour but cannot
  claim witnessed public delivery. Legacy retained resources may acquire the
  election through an ordinary reviewed declaration without changing identity.
inputs:
  - name: function-fleet-intent
    description: >
      Reviewed function packaging, settings, provider selection and exposure
      posture required to establish or preserve its stable execution identity.
  - name: app-function-mapping
    description: >
      Reviewed allocation of each application to its exact retained function;
      ambiguous shared selection cannot silently choose one application.
  - name: deployable-code-artifact
    description: >
      Exact selected application code content and its release identity, with
      the authored deployment configuration and any public-proof election.
      They identify the bytes and release that deployment must actually serve.
  - name: publication-intent
    description: >
      Reviewed public name and exact route meaning for the allocated function,
      including the public address at which an elected release is witnessed.
      It permits only the declared binding, not adoption of a foreign route.
  - name: edge-control-authority
    description: >
      Admitted authority over the selected public edge account and exact domain
      zone, required to deliver code and reconcile the declared route.
  - name: gcloud-control-authority
    description: >
      Admitted authority over the selected hosted function account and region,
      required only by the realization selected for that function.
outputs:
  - name: public-endpoint
    description: >
      The allocated function's public endpoint and request-host semantics.
      When public-release proof is elected, successful deployment attests that
      this exact public address served the selected release and artifact content.
  - name: function-fleet-identity
    description: >
      Credential-free retained function identities and endpoints for environment
      visibility; deployment preserves these identities across release changes.
---
