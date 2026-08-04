---
name: machine-local-workload-host
definition: >
  A user-authored exemplar of the open provider vocabulary: an
  infrastructure component whose realization, registered under the
  author-chosen world label for the developer's own macOS machine,
  converges a machine-resident lightweight kubernetes substrate and
  hosts runnable containerized workloads on it. It is the reference
  demonstration that a developer machine is a world like any other —
  named by its author, realized by its author's code, and treated by
  the platform exactly as it treats any cloud.

  This exemplar exists to make the platform's runtime symmetry concrete:
  running a component locally and running it in the cloud are the same
  act under different realizations of the same declared entity. Nothing
  about this component is platform vocabulary — its world label, its
  credential shape, and its substrate choices are authored facts — and
  that is the point being exemplified.

  Four invariants shape the realization.

  Substrate as converged interior. The machine-resident kubernetes
  substrate — including whatever container-capable layer this operating
  system requires — is acquired and converged idempotently inside the
  realization: present when convergence needs it, a safe no-op when it
  already stands. No contract names the tooling; substrate choice is
  the author's private concern and may change without any contract
  moving.

  Shared substrate, tenancy-scoped blast radius. One substrate serves
  every branch realized on this machine. Each branch's workloads live
  in an isolation scope derived deterministically from the identity
  seeds the execution engine supplies, and the realization's teardown
  path retires only its own branch's scope — never the substrate, which
  other branches may be standing on. Destroying the substrate itself is
  a deliberate act outside any branch's lifecycle.

  Hosted continuity, machine-resident workloads. All continuity — the
  realization's state, the branch's footprint, the addresses it reports
  — lives in the branch's hosted carriers, exactly as for any world.
  The machine owns nothing but running workloads and this source. A
  convergence enacted from a different machine therefore re-realizes
  against that machine's substrate, and the engine's unconditional
  pre-convergence reconciliation surfaces the divergence between the
  hosted record and the standing machine honestly rather than silently.

  Peer-realization parity. This realization satisfies the same
  configuration schema, output schema, connection interfaces, and
  accepted artifact types as any cloud realization of the same declared
  entity, and it materializes workloads only from admitted build
  artifacts resolvable through the branch's bound artifact store — a
  registry reachable by both the build's upload and this substrate's
  pulls. Fields of the shared configuration whose meaning is
  intrinsically remote are accepted and inert here, because schema
  parity is what keeps world-switching a realization-level decision.
inputs:
  - name: realization-lifecycle-demand
    description: >
      The execution engine's generic lifecycle invocations — provision,
      allocate, connect, and their retirements — carrying the entity's
      declared configuration, prior hosted state, deterministic identity
      seeds, and the opaque credential material bound under this world
      label, which this realization alone interprets and which may be
      empty, since possession of the machine is this world's only
      authority. Must flow inward because the realization is executable
      knowledge, not an actor: every occasion of its acting originates
      in the engine's provider-blind orchestration.
  - name: admitted-workload-materials
    description: >
      The addresses and kinds of admitted build artifacts to be realized
      into running workloads, resolvable from this machine through the
      branch's bound artifact store. Must flow inward because
      infrastructure brings components to life from built materials, and
      the platform's admitted artifact record is the only sanctioned
      source of them — locality changes where the registry lives, never
      whether admission is passed through.
outputs:
  - name: tenancy-scoped-workload-hosting
    description: >
      Running containerized workloads on the machine substrate, confined
      to this branch's isolation scope, converged to the declared
      allocation. Must flow outward — as the realized world-state the
      whole declaration exists to produce — because this is the
      behaviour every consumer of the branch's infrastructure ultimately
      depends on.
  - name: workload-reachability
    description: >
      Per hosted workload, the machine-scoped addresses at which it is
      reachable, delivered through the entity's declared connection
      interfaces so that sibling components and endpoint registers wire
      against them without knowing this world exists. Must flow outward
      because address discovery is the connection phases' precondition,
      and because the addresses' machine-local reach is legible in the
      addresses themselves rather than special-cased anywhere.
  - name: realization-continuity
    description: >
      The realization's revised state, written back into the branch's
      hosted carriers after every convergence. Must flow outward because
      continuity is hosted-owned for every world: the machine keeps no
      record, so the hosted state is the only memory future
      convergences — from this machine or another — reconcile against.
---
