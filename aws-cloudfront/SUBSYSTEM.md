---
name: aws-cloudfront

definition: Provides edge delivery for static and dynamic origins under explicit TLS, caching, and cost posture. It exists to make public edge access deliberate and to ensure object-store origins are reached only through the sanctioned edge path when such enforcement is available.

inputs:
  - name: edge-delivery-intent
    description: Environment-declared origin, caching, TLS, geographic, and cost posture for edge delivery.
  - name: aws-control-authority
    description: Environment-provided authority to create and govern AWS infrastructure in the selected account and region.
  - name: origin-identity
    description: Object-origin identity supplied by an object store so edge delivery can front non-public objects.
  - name: origin-address
    description: Dynamic-origin address supplied by a traffic distributor.
  - name: edge-certificate
    description: Environment-provided certificate authority meaning required when custom public names are declared.

outputs:
  - name: edge-delivery-address
    description: Public edge address meaning provided to apps and operators for reaching delivered content or applications.
  - name: edge-distribution-identity
    description: Environment-visible identity and operational status of the edge delivery surface.
---
