# infra-components

Centralised, public SDLC infrastructure component definitions. This repository is the default infra source for SDLC projects -- it provides the set of infrastructure components, artifact registries, and URL registers that the SDLC platform provisions and manages.

Users reference this repo as an infra source in their SDLC project configuration. The components here are read-only from the user's perspective; the platform reads, builds, and provisions them.

## Components

### Infrastructure

| Directory | Description |
|---|---|
| `k3s/` | Single-node k3s Kubernetes cluster on GCP (VM, firewall, TLS, CNPG, ingress) |
| `vpc/` | GCP Virtual Private Cloud network |
| `subnet/` | GCP VPC subnet |
| `firewall/` | GCP firewall rules |
| `http-lb-external/` | GCP external HTTP(S) load balancer |
| `bucket/` | GCP Cloud Storage / Cloudflare R2 bucket |
| `serverless-fn/` | GCP Cloud Run service + Cloudflare Workers |
| `cloudjob/` | GCP Cloud Run Job |
| `cloudflare-d1/` | Cloudflare D1 database |

### Artifact Registries

| Directory | Description |
|---|---|
| `artifact-registries/gcp-artifact-registry/` | GCP Artifact Registry (Docker, npm) |
| `artifact-registries/github-releases/` | GitHub Releases |
| `artifact-registries/azure-devops-npm/` | Azure DevOps npm feed |
| `artifact-registries/npm-public/` | Public npm registry |

### URL Registers

| Directory | Description |
|---|---|
| `url-registers/cloudflare-dns/` | Cloudflare DNS records + Workers custom domains |

### Shared

| Directory | Description |
|---|---|
| `_internal/interfaces.ts` | Connection interface definitions shared across components |

## Building

This repo is an SDLC infra component (`infra_code = true` in `sdlc.toml`). The build toolchain:

1. Install JS dependencies: `cd .js && bun install`
2. Bundle: `sdlc-components-build --bundle` (from the repo root)

The `shell.nix` provides `bun`, `nodejs`, and the `sdlc-components-build` binary.

The full build command declared in `sdlc.toml`:
```
(cd .js && bun install) && sdlc-components-build --bundle
```

Build output lands at `.js/infra-bundle.tar.gz`.

### Dependencies

Runtime dependencies are declared in `.js/package.json`:
- `@sdlcworks/components` (0.0.63) -- the SDLC component authoring SDK (public npm)
- `@pulumi/*` -- Pulumi providers (GCP, AWS, Cloudflare, Kubernetes, TLS, Command)
- `zod`, `js-yaml`

The lock file is `.js/bun.lock` (bun is the package manager; no `package-lock.json`).

## Known issues

### `@sdlc/types` import in `url-registers/cloudflare-dns/index.ts`

Line 6 imports `BranchMetadataCloudCredentialCloudflare` from `@sdlc/types`. This package does not exist on npm and is not declared in `package.json`. The type IS exported by `@sdlcworks/components` (from its `copied-types` module). In the monorepo, this import likely resolves via workspace hoisting. For standalone use, it must be changed to import from `@sdlcworks/components`. This has not been changed in this extraction -- it needs a deliberate fix before the repo is functional standalone.

## Open design decision: component name for coexistence

The `sdlc.toml` declares this as `["@infra"]`. When an SDLC project uses this as its infra source, the component name `@infra` is what the platform recognises. If a project also has its own local `@infra` component, there is a naming collision. The coexistence naming strategy (e.g., whether the centralised repo always claims `@infra`, or whether it uses a different name, or whether the platform supports namespaced disambiguation) is an open design decision. For now, the name is `@infra` -- unchanged from the monorepo source.
