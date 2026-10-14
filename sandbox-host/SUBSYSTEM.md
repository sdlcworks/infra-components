---
name: resident-workspace-process-host
definition: >
  Realizes an admitted workspace release as managed processes resident in the
  enactor's actual environment and publishes an endpoint only after witnessed
  listening. A source binding identifies intended content and placement; it
  cannot establish the current environment or authority that admits serving.
  Hosted bindings must match the actual sandbox. Machine bindings additionally
  match an independently supplied current managed session, writer generation
  and canonical source root. Public identities contain no private credential
  and cannot replace the supervisor's current admission.
  Process custody is isolated by actual environment and, for machine work,
  installation, session, workspace generation and root before component.
  Replacement, restart, readiness and retirement act only within that exact
  custody. A foreign port or predecessor is not permission to signal another
  environment's work. Existing data survives ordinary process replacement.
  Managed machine admission and restart stop when current session standing
  expires or closes. Owned process cessation is witnessed, with incomplete
  drain retained rather than claiming release or deleting authored source.
  Machine readiness requires positive operating-system listener ownership;
  an unrelated listener cannot be credited merely because an owned process
  is alive. Inaccessible ownership remains unavailable. This is finite
  observed readiness, not perpetual endpoint identity. A retained numerical
  process identity alone cannot authorize a later signal or prove a live
  incarnation. Machine cessation is requested through the exact retained
  supervisor custody, and only that live supervisor acts on its own group.
  Session observation survives carrier restarts: equal revisions retain equal
  meaning, regressions refuse, and observed expiry or closure cannot be erased
  by a later revision of the same session.
  Local reachability is explicitly loopback; hosted reachability retains its
  declared sandbox ingress. Neither a configured port nor a running process
  alone establishes the release's witnessed serving identity.
inputs:
  - name: resident-serving-demand
    boundary: environment/deployment
    description: >
      Admitted per-component release, declared command, port and application
      environment with selected local artifact addressing. The enclosing
      enactor owns authorization; this realization may not infer it from an
      artifact, a public identity or a prior successful serving record.
  - name: resident-serving-binding
    boundary: environment/workspace-filesystem
    description: >
      Nonsecret content binding naming the component, canonical source root,
      runtime search path and intended sandbox or machine session and writer
      generation. Required to compare the artifact's intended placement with
      independently held actual current context before any process effect.
  - name: managed-workspace-serving-context
    boundary: environment/deployment
    description: >
      Independently supplied current local supervisor standing: installation,
      session, workspace, generation, canonical root and bounded validity.
      Exact renewals preserve this identity, while closure or expiry stops
      managed admission and restart. It supplies no artifact-carried authority
      and is never derived from the binding it judges. Revision meaning and
      terminal observed expiry or closure persist across carrier invocations;
      a later revision cannot resurrect that exact session.
  - name: resident-process-testimony
    boundary: environment/process-substrate
    description: >
      Actual process-group existence, termination, loopback listening and
      listener ownership attributed to the exact live managed incarnation,
      and response from its retained private supervisor custody,
      required to distinguish owned placement, readiness, restart and complete
      retirement from requested or historically observed state.
  - name: resident-host-identity
    boundary: environment/task-environment
    description: >
      The actual hosted sandbox identity independently supplied by its birth
      environment. An absent identity cannot implicitly select machine work;
      machine placement instead requires its complete managed context.
outputs:
  - name: resident-process-act
    boundary: environment/process-substrate
    description: >
      Start, bounded startup observation, admitted restart and retirement of
      only the exact custody's managed process group. Machine cessation is
      addressed to the retained live supervisor rather than a reusable numeric
      process identity; unavailable custody cannot authorize a signal.
      No other session's work,
      source tree or persistent application data is implicitly discarded.
  - name: resident-serving-account
    boundary: environment/deployment
    description: >
      Witnessed release and environment identity, port and actual reachable
      hosted or loopback endpoint, or a named mismatch, readiness or incomplete
      retirement refusal. Historical records and foreign listeners never
      manufacture current serving readiness.
---
