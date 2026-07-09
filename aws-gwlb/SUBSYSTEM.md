---
name: aws-gwlb

definition: Provides transparent insertion of declared inspection appliances into network traffic paths. It exists because inspection transit is not app exposure; without this subsystem, appliance routing and endpoint acceptance would be implicit, scattered, or conflated with ordinary load balancing.

inputs:
  - name: appliance-insertion-intent
    description: Environment-declared inspection admission, appliance participation, and traffic redirection policy.
  - name: aws-control-authority
    description: Environment-provided authority to create and govern AWS infrastructure in the selected account and region.
  - name: traffic-insertion-surface
    description: Network and routing meaning provided by a network fabric for placing inspection endpoints and redirecting selected traffic.
  - name: appliance-target-identity
    description: Inspection appliance identity supplied by the appliance boundary.

outputs:
  - name: inspection-service-identity
    description: Environment-visible identity of the inspection service and the consumer-side insertion points it provides.
---
