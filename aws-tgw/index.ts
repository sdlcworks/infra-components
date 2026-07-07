import { z } from "zod";

import { CloudProvider, InfraComponent } from "@sdlcworks/components";

import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";

const DEFAULT_AMAZON_SIDE_ASN = 64512;
const AWS_ENABLE = "enable";
const AWS_DISABLE = "disable";
const TGW_RESOURCE_NAME = "tgw";
const ATTACHMENT_RESOURCE_PREFIX = "attachment";
const ROUTE_TABLE_RESOURCE_PREFIX = "rt";
const ASSOCIATION_RESOURCE_PREFIX = "assoc";
const PROPAGATION_RESOURCE_PREFIX = "prop";
const TGW_ROUTE_RESOURCE_PREFIX = "route";
const RETURN_ROUTE_RESOURCE_PREFIX = "return-route";

const AwsToggleSchema = z.enum([AWS_ENABLE, AWS_DISABLE]);

const ReturnRouteSchema = z.object({
  routeTableId: z.string(),
  destinationCidr: z.string(),
});

const AttachmentSchema = z.object({
  vpcId: z.string(),
  subnetIds: z.array(z.string()).min(1),
  cidr: z.string(),
  applianceModeSupport: AwsToggleSchema.default(AWS_DISABLE),
  associateWith: z.string().optional(),
  propagateTo: z.array(z.string()).default([]),
  returnRoutes: z.array(ReturnRouteSchema).min(1),
});

const RouteSchema = z.object({
  destinationCidr: z.string(),
  attachment: z.string(),
});

const RouteTableSchema = z.object({
  routes: z.array(RouteSchema).default([]),
});

const ConfigSchema = z
  .object({
    defaultRouteTableAssociation: AwsToggleSchema,
    defaultRouteTablePropagation: AwsToggleSchema,
    attachments: z.record(z.string(), AttachmentSchema),
    routeTables: z.record(z.string(), RouteTableSchema).optional(),
    autoAcceptSharedAttachments: AwsToggleSchema.default(AWS_DISABLE),
    amazonSideAsn: z.number().default(DEFAULT_AMAZON_SIDE_ASN),
    dnsSupport: AwsToggleSchema.default(AWS_ENABLE),
    vpnEcmpSupport: AwsToggleSchema.default(AWS_ENABLE),
    multicast: AwsToggleSchema.default(AWS_DISABLE),
  })
  .superRefine((config, ctx) => {
    const attachmentNames = new Set(Object.keys(config.attachments));
    const routeTableNames = new Set(Object.keys(config.routeTables ?? {}));

    if (attachmentNames.size === 0) {
      ctx.addIssue({
        code: "custom",
        message: "attachments must contain at least one attachment.",
        path: ["attachments"],
      });
    }

    Object.entries(config.attachments).forEach(([name, attachment]) => {
      if (attachment.returnRoutes.length === 0) {
        ctx.addIssue({
          code: "custom",
          message: "attachments must declare at least one return route.",
          path: ["attachments", name, "returnRoutes"],
        });
      }

      if (
        config.defaultRouteTableAssociation === AWS_DISABLE &&
        attachment.associateWith === undefined
      ) {
        ctx.addIssue({
          code: "custom",
          message:
            "disabled defaultRouteTableAssociation requires associateWith on every attachment.",
          path: ["attachments", name, "associateWith"],
        });
      }

      if (
        config.defaultRouteTableAssociation === AWS_ENABLE &&
        attachment.associateWith !== undefined
      ) {
        ctx.addIssue({
          code: "custom",
          message:
            "enabled defaultRouteTableAssociation cannot be combined with explicit associateWith.",
          path: ["attachments", name, "associateWith"],
        });
      }

      if (
        attachment.associateWith !== undefined &&
        !routeTableNames.has(attachment.associateWith)
      ) {
        ctx.addIssue({
          code: "custom",
          message: `associateWith references unknown route table "${attachment.associateWith}".`,
          path: ["attachments", name, "associateWith"],
        });
      }

      attachment.propagateTo.forEach((routeTableName, index) => {
        if (!routeTableNames.has(routeTableName)) {
          ctx.addIssue({
            code: "custom",
            message: `propagateTo references unknown route table "${routeTableName}".`,
            path: ["attachments", name, "propagateTo", index],
          });
        }
      });
    });

    Object.entries(config.routeTables ?? {}).forEach(([routeTableName, routeTable]) => {
      routeTable.routes.forEach((route, index) => {
        if (!attachmentNames.has(route.attachment)) {
          ctx.addIssue({
            code: "custom",
            message: `route references unknown attachment "${route.attachment}".`,
            path: ["routeTables", routeTableName, "routes", index, "attachment"],
          });
        }
      });
    });
  });

type Config = z.infer<typeof ConfigSchema>;

const component = new InfraComponent({
  metadata: {
    stateful: false,
    proxiable: false,
  },
  connectionTypes: {},
  configSchema: ConfigSchema,
  appComponentTypes: {},
  outputSchema: z.object({
    tgwId: z.string(),
    arn: z.string(),
    attachmentIds: z.record(z.string(), z.string()),
    routeTableIds: z.record(z.string(), z.string()),
    defaultRouteTableId: z.string().optional(),
  }),
});

component.implement(CloudProvider.aws, {
  stateSchema: z.object({}),
  initialState: {},

  pulumi: async ({ $, inputs, aws: provider }) => {
    const {
      defaultRouteTableAssociation,
      defaultRouteTablePropagation,
      attachments,
      routeTables,
      autoAcceptSharedAttachments,
      amazonSideAsn,
      dnsSupport,
      vpnEcmpSupport,
      multicast,
    } = inputs as Config;

    const awsOpts: pulumi.CustomResourceOptions = provider
      ? { provider }
      : {};

    const transitGateway = new aws.ec2transitgateway.TransitGateway(
      $`${TGW_RESOURCE_NAME}`,
      {
        amazonSideAsn,
        autoAcceptSharedAttachments,
        defaultRouteTableAssociation,
        defaultRouteTablePropagation,
        dnsSupport,
        vpnEcmpSupport,
        multicastSupport: multicast,
        tags: {
          Name: $`${TGW_RESOURCE_NAME}`,
        },
      },
      awsOpts,
    );

    const attachmentResources: Record<string, aws.ec2transitgateway.VpcAttachment> = {};
    for (const [name, attachment] of Object.entries(attachments)) {
      attachmentResources[name] = new aws.ec2transitgateway.VpcAttachment(
        $`${ATTACHMENT_RESOURCE_PREFIX}-${name}`,
        {
          transitGatewayId: transitGateway.id,
          vpcId: attachment.vpcId,
          subnetIds: attachment.subnetIds,
          applianceModeSupport: attachment.applianceModeSupport,
          dnsSupport,
          transitGatewayDefaultRouteTableAssociation:
            defaultRouteTableAssociation === AWS_ENABLE,
          transitGatewayDefaultRouteTablePropagation:
            defaultRouteTablePropagation === AWS_ENABLE,
          tags: {
            Name: $`${ATTACHMENT_RESOURCE_PREFIX}-${name}`,
          },
        },
        awsOpts,
      );
    }

    const routeTableResources: Record<string, aws.ec2transitgateway.RouteTable> = {};
    for (const name of Object.keys(routeTables ?? {})) {
      routeTableResources[name] = new aws.ec2transitgateway.RouteTable(
        $`${ROUTE_TABLE_RESOURCE_PREFIX}-${name}`,
        {
          transitGatewayId: transitGateway.id,
          tags: {
            Name: $`${ROUTE_TABLE_RESOURCE_PREFIX}-${name}`,
          },
        },
        awsOpts,
      );
    }

    const associationResources: pulumi.Resource[] = [];
    for (const [attachmentName, attachment] of Object.entries(attachments)) {
      if (attachment.associateWith === undefined) {
        continue;
      }

      const routeTable = routeTableResources[attachment.associateWith];
      associationResources.push(
        new aws.ec2transitgateway.RouteTableAssociation(
          $`${ASSOCIATION_RESOURCE_PREFIX}-${attachmentName}-${attachment.associateWith}`,
          {
            transitGatewayAttachmentId: attachmentResources[attachmentName].id,
            transitGatewayRouteTableId: routeTable.id,
          },
          {
            ...awsOpts,
            dependsOn: [attachmentResources[attachmentName], routeTable],
          },
        ),
      );
    }

    const propagationResources: pulumi.Resource[] = [];
    for (const [attachmentName, attachment] of Object.entries(attachments)) {
      attachment.propagateTo.forEach((routeTableName) => {
        const routeTable = routeTableResources[routeTableName];
        propagationResources.push(
          new aws.ec2transitgateway.RouteTablePropagation(
            $`${PROPAGATION_RESOURCE_PREFIX}-${attachmentName}-${routeTableName}`,
            {
              transitGatewayAttachmentId: attachmentResources[attachmentName].id,
              transitGatewayRouteTableId: routeTable.id,
            },
            {
              ...awsOpts,
              dependsOn: [attachmentResources[attachmentName], routeTable],
            },
          ),
        );
      });
    }

    for (const [routeTableName, routeTable] of Object.entries(routeTables ?? {})) {
      routeTable.routes.forEach((route, index) => {
        new aws.ec2transitgateway.Route(
          $`${TGW_ROUTE_RESOURCE_PREFIX}-${routeTableName}-${index}`,
          {
            destinationCidrBlock: route.destinationCidr,
            transitGatewayAttachmentId: attachmentResources[route.attachment].id,
            transitGatewayRouteTableId: routeTableResources[routeTableName].id,
          },
          {
            ...awsOpts,
            dependsOn: [
              attachmentResources[route.attachment],
              routeTableResources[routeTableName],
              ...associationResources,
              ...propagationResources,
            ],
          },
        );
      });
    }

    for (const [attachmentName, attachment] of Object.entries(attachments)) {
      attachment.returnRoutes.forEach((returnRoute, index) => {
        new aws.ec2.Route(
          $`${RETURN_ROUTE_RESOURCE_PREFIX}-${attachmentName}-${index}`,
          {
            routeTableId: returnRoute.routeTableId,
            destinationCidrBlock: returnRoute.destinationCidr,
            transitGatewayId: transitGateway.id,
          },
          {
            ...awsOpts,
            dependsOn: [attachmentResources[attachmentName]],
          },
        );
      });
    }

    return {
      tgwId: transitGateway.id,
      arn: transitGateway.arn,
      attachmentIds: pulumi.output(
        Object.fromEntries(
          Object.entries(attachmentResources).map(([name, attachment]) => [
            name,
            attachment.id,
          ]),
        ),
      ),
      routeTableIds: pulumi.output(
        Object.fromEntries(
          Object.entries(routeTableResources).map(([name, routeTable]) => [
            name,
            routeTable.id,
          ]),
        ),
      ),
      defaultRouteTableId:
        defaultRouteTableAssociation === AWS_ENABLE ||
        defaultRouteTablePropagation === AWS_ENABLE
          ? transitGateway.associationDefaultRouteTableId
          : undefined,
    };
  },
});

export default component;
