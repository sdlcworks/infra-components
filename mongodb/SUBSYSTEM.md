---
name: mongodb

definition: >
  Provides each app an isolated logical document database, reached over the
  MongoDB protocol, on a managed cluster operated by a dedicated
  document-database control plane outside the branch's other cloud accounts
  and reached over the public internet. The component guarantees the
  authorization boundary -- one per-app credential whose grants are scoped
  to exactly that app's logical database -- not the database's material
  existence: logical databases and collections materialize on first write
  and belong to the data plane, so the contract stops at project, cluster,
  network admission, and per-app credential. Admission is owned by the
  store: only explicitly declared network addresses may reach the cluster.
  Recoverability is always asked and termination protection defaults to
  protective -- never silently forfeited. It exists because apps need
  document databases whose isolation, reachability, and recoverability are
  under infrastructure review; without it, apps would share databases and
  credentials outside review, or depend on a store whose admission and
  backup posture were inherited provider defaults.

inputs:
  - name: document-store-intent
    description: >
      Environment-declared store shape: adoption of an existing
      control-plane project or creation of a new one, cluster topology,
      sizing, backing cloud, recoverability posture, and termination
      protection. Recoverability is asked, never defaulted off; sizing
      drift caused by declared autoscaling is absorbed, never destructively
      reconciled.
  - name: network-admission-declaration
    description: >
      Environment-declared public network addresses from which admitted
      consumers reach the store -- at least one, address-scoped because the
      store is reached over the public internet. For consumers resident in
      a private network fabric these are the fabric's stable egress
      addresses; the declaration is environment-mediated because the store
      and the fabrics answer to different control authorities. Fully open
      admission must be written explicitly, never inherited.
  - name: atlas-control-authority
    description: >
      Environment-provided authority to create and govern resources in the
      document-database control plane's selected organization or project.
  - name: database-access-request
    description: >
      App-boundary request naming the app's logical database and the access
      roles it requires. Injective: each logical database belongs to
      exactly one app, because a shared database would collapse the per-app
      authorization boundary.

outputs:
  - name: database-access
    description: >
      App-facing connection meaning carrying a credentialed address scoped
      to exactly the requesting app's logical database. The credential is
      the authorization boundary: possession of this meaning is possession
      of one database and nothing else.
  - name: document-store-identity
    description: >
      Environment-visible, credential-free identity and reachability of the
      store: project, cluster, and cluster address.
---
