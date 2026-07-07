import { z } from "zod";
import {
  CloudProvider,
  InfraComponent,
} from "@sdlcworks/components";
import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";

const GWLB_TYPE = "gateway";
const GWLB_ENDPOINT_TYPE = "GatewayLoadBalancer";
const GENEVE_PROTOCOL = "GENEVE";
const GENEVE_PORT = 6081;
const TCP_PROTOCOL = "TCP";
const ENDPOINT_ACCEPTANCE_MANUAL = "manual";
const ENDPOINT_ACCEPTANCE_AUTO = "auto";
const DEFAULT_CROSS_ZONE = false;

const EndpointAcceptance = z.enum([
  ENDPOINT_ACCEPTANCE_MANUAL,
  ENDPOINT_ACCEPTANCE_AUTO,
]);

const ApplianceTargetSchema = z.object({
  ip: z.string().optional(),
  instanceId: z.string().optional(),
  port: z.number().default(GENEVE_PORT),
});

const RouteEditSchema = z.object({
  routeTableId: z.string(),
  destinationCidr: z.string(),
});

const EndpointSchema = z.object({
  vpcId: z.string(),
  subnetIds: z.array(z.string()).min(1),
  routeEdits: z.array(RouteEditSchema).min(1),
});

const ConfigSchema = z.object({
  vpcId: z.string(),
  subnetIds: z.array(z.string()).min(1),
  applianceTargets: z.array(ApplianceTargetSchema).min(1),
  endpointAcceptance: EndpointAcceptance,
  allowedPrincipals: z.array(z.string()).default([]),
  endpoints: z.array(EndpointSchema).default([]),
  crossZone: z.boolean().default(DEFAULT_CROSS_ZONE),
});

type Config = z.infer<typeof ConfigSchema>;

const component = new InfraComponent({
  metadata: {
    stateful: false,
    proxiable: false,
  },
  connectionTypes: {} as const,
  configSchema: ConfigSchema,
  appComponentTypes: {},
  outputSchema: z.object({
    arn: z.string(),
    endpointServiceName: z.string(),
    endpointIds: z.array(z.string()),
    targetGroupArn: z.string(),
  }),
});

component.implement(CloudProvider.aws, {
  stateSchema: z.object({}),
  initialState: {},

  pulumi: async ({ $, inputs, aws: provider }) => {
    const {
      vpcId,
      subnetIds,
      applianceTargets,
      endpointAcceptance,
      allowedPrincipals,
      endpoints,
      crossZone,
    } = inputs as Config;

    const awsOpts: pulumi.CustomResourceOptions = { provider };

    let targetType: "ip" | "instance" | undefined;

    applianceTargets.forEach((target, index) => {
      const hasIp = Boolean(target.ip);
      const hasInstanceId = Boolean(target.instanceId);

      if (hasIp === hasInstanceId) {
        throw new Error(
          `aws-gwlb: applianceTargets[${index}] must specify exactly one of ip or instanceId.`,
        );
      }

      const currentTargetType = hasIp ? "ip" : "instance";
      targetType ??= currentTargetType;

      if (targetType !== currentTargetType) {
        throw new Error(
          "aws-gwlb: applianceTargets must not mix ip and instanceId targets.",
        );
      }
    });

    endpoints.forEach((endpoint, endpointIndex) => {
      if (endpoint.routeEdits.length === 0) {
        throw new Error(
          `aws-gwlb: endpoints[${endpointIndex}].routeEdits must contain at least one explicit route edit.`,
        );
      }
    });

    const acceptanceRequired =
      endpointAcceptance === ENDPOINT_ACCEPTANCE_MANUAL
        ? true
        : endpointAcceptance === ENDPOINT_ACCEPTANCE_AUTO
          ? false
          : (() => {
              throw new Error("aws-gwlb: endpointAcceptance must be manual or auto.");
            })();

    const loadBalancer = new aws.lb.LoadBalancer(
      $`gwlb`,
      {
        loadBalancerType: GWLB_TYPE,
        subnets: subnetIds,
        enableCrossZoneLoadBalancing: crossZone,
      },
      awsOpts,
    );

    const targetGroup = new aws.lb.TargetGroup(
      $`gwlb-tg`,
      {
        port: GENEVE_PORT,
        protocol: GENEVE_PROTOCOL,
        targetType,
        vpcId,
        healthCheck: {
          protocol: TCP_PROTOCOL,
        },
      },
      awsOpts,
    );

    applianceTargets.forEach((target, index) => {
      new aws.lb.TargetGroupAttachment(
        $`gwlb-target-${index}`,
        {
          targetGroupArn: targetGroup.arn,
          targetId: target.ip ?? target.instanceId!,
          port: target.port,
        },
        awsOpts,
      );
    });

    new aws.lb.Listener(
      $`gwlb-listener`,
      {
        loadBalancerArn: loadBalancer.arn,
        defaultActions: [
          {
            type: "forward",
            targetGroupArn: targetGroup.arn,
          },
        ],
      },
      awsOpts,
    );

    const endpointService = new aws.ec2.VpcEndpointService(
      $`gwlb-endpoint-service`,
      {
        acceptanceRequired,
        gatewayLoadBalancerArns: [loadBalancer.arn],
      },
      awsOpts,
    );

    allowedPrincipals.forEach((principalArn, index) => {
      new aws.ec2.VpcEndpointServiceAllowedPrinciple(
        $`gwlb-principal-${index}`,
        {
          principalArn,
          vpcEndpointServiceId: endpointService.id,
        },
        awsOpts,
      );
    });

    const consumerEndpoints = endpoints.map((endpoint, endpointIndex) =>
      new aws.ec2.VpcEndpoint(
        $`gwlb-endpoint-${endpointIndex}`,
        {
          vpcEndpointType: GWLB_ENDPOINT_TYPE,
          vpcId: endpoint.vpcId,
          subnetIds: endpoint.subnetIds,
          serviceName: endpointService.serviceName,
        },
        awsOpts,
      )
    );

    endpoints.forEach((endpoint, endpointIndex) => {
      endpoint.routeEdits.forEach((routeEdit, routeIndex) => {
        new aws.ec2.Route(
          $`gwlb-route-${endpointIndex}-${routeIndex}`,
          {
            routeTableId: routeEdit.routeTableId,
            destinationCidrBlock: routeEdit.destinationCidr,
            vpcEndpointId: consumerEndpoints[endpointIndex].id,
          },
          awsOpts,
        );
      });
    });

    return {
      arn: loadBalancer.arn,
      endpointServiceName: endpointService.serviceName,
      endpointIds: pulumi.all(consumerEndpoints.map((endpoint) => endpoint.id)),
      targetGroupArn: targetGroup.arn,
    };
  },
});

export default component;
