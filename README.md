# infra-components

Centralised, public SDLC infrastructure component definitions. This repository is the default infra source for SDLC projects -- it provides the set of infrastructure components, artifact registries, and URL registers that the SDLC platform provisions and manages.

Users reference this repo as an infra source in their SDLC project configuration. The components here are read-only from the user's perspective; the platform reads, builds, and provisions them.

## Components

### Infrastructure

| Directory | Description |
|---|---|
| `aws-cloudfront/` | AWS CloudFront distribution with S3 OAC and custom-origin support |
| `aws-dynamodb/` | AWS DynamoDB table store with reviewed key schema and app-selected table access |
| `aws-ecs/` | AWS ECS Fargate service fleet with reviewed scaling, discovery, exposure, and deployment posture |
| `aws-gwlb/` | AWS Gateway Load Balancer with endpoint-service and route-edit management |
| `aws-lambda/` | AWS Lambda function fleet with deploy-time code updates |
| `aws-lb/` | AWS Application / Network Load Balancer with listeners, target groups, and explicit ingress |
| `aws-s3/` | AWS S3 bucket with permanent non-public posture and infra-addressable identity |
| `aws-tgw/` | AWS Transit Gateway hub with attachments, route tables, propagation, and return routes |
| `aws-vpc/` | AWS VPC fabric with subnet tiers, route tables, NAT, and endpoints |
| `aws-vm/` | Standalone AWS EC2 VM (Elastic IP, Security Group, IAM instance profile, cloud-init) |
| `gcloud-vm/` | Standalone Google Compute Engine VM (static IP, firewall, Shielded VM, cloud-init) |
| `hetzner-vm/` | Standalone Hetzner Cloud VM (PrimaryIP, firewall, cloud-init) |
| `k3s/` | k3s Kubernetes cluster on GCP or private AWS EC2 fleets, with workload allocation, CNPG, monitoring, and ingress |
| `vpc/` | GCP Virtual Private Cloud network |
| `subnet/` | GCP VPC subnet |
| `firewall/` | GCP firewall rules |
| `http-lb-external/` | GCP external HTTP(S) load balancer |
| `bucket/` | GCP Cloud Storage / Cloudflare R2 / AWS S3 bucket |
| `serverless-fn/` | GCP Cloud Run service + Cloudflare Workers |
| `cloudjob/` | GCP Cloud Run Job |
| `cloudflare-d1/` | Cloudflare D1 database |

### Artifact Registries

| Directory | Description |
|---|---|
| `artifact-registries/aws-ecr/` | AWS ECR image registry for same-account AWS workloads |
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
- `@sdlcworks/components` (0.0.64) -- the SDLC component authoring SDK (public npm)
- `@pulumi/*` -- Pulumi providers (GCP, AWS, Cloudflare, Kubernetes, TLS, Command)
- `zod`, `js-yaml`

The lock file is `.js/bun.lock` (bun is the package manager; no `package-lock.json`).
