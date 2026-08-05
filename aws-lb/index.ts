import { z } from "zod";

import { InfraComponent } from "@sdlcworks/components";

import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";

const TLS_POLICY = "ELBSecurityPolicy-TLS13-1-2-2021-06";
const LAMBDA_INVOKE_PRINCIPAL = "elasticloadbalancing.amazonaws.com";
const DEFAULT_HEALTH_CHECK_PATH = "/";
const DEFAULT_DEREGISTRATION_DELAY = 300;
const DEFAULT_IDLE_TIMEOUT = 60;
const DEFAULT_IP_ADDRESS_TYPE = "ipv4";
const LAMBDA_INVOKE_ACTION = "lambda:InvokeFunction";

const ApplicationListenerProtocol = z.enum(["HTTP", "HTTPS"]);
const NetworkListenerProtocol = z.enum([
  "TCP",
  "TLS",
  "UDP",
  "TCP_UDP",
]);
const ListenerProtocol = z.union([
  ApplicationListenerProtocol,
  NetworkListenerProtocol,
]);

const ApplicationTargetProtocol = z.enum(["HTTP", "HTTPS"]);
const NetworkTargetProtocol = z.enum(["TCP", "TLS", "UDP", "TCP_UDP"]);
const TargetProtocol = z.union([
  ApplicationTargetProtocol,
  NetworkTargetProtocol,
]);

const AccessLogsSchema = z.object({
  bucket: z.string(),
  prefix: z.string().optional(),
});

const ApplicationSettingsSchema = z.object({
  http2: z.boolean().default(true),
  dropInvalidHeaderFields: z.boolean().default(true),
  wafWebAclArn: z.string().optional(),
});

const NetworkSettingsSchema = z.object({
  crossZone: z.boolean().default(false),
  eipAllocationIds: z.array(z.string()).optional(),
});

const WeightedTargetGroupSchema = z.object({
  targetGroup: z.string(),
  weight: z.number().min(0).max(999).optional(),
});

const ForwardActionSchema = z.object({
  type: z.literal("forward"),
  targetGroup: z.string().optional(),
  targetGroups: z.array(WeightedTargetGroupSchema).min(1).max(5).optional(),
});

const RedirectActionSchema = z.object({
  type: z.literal("redirect"),
  statusCode: z.enum(["HTTP_301", "HTTP_302"]),
  host: z.string().optional(),
  path: z.string().optional(),
  port: z.string().optional(),
  protocol: z.enum(["HTTP", "HTTPS", "#{protocol}"]).optional(),
  query: z.string().optional(),
});

const FixedResponseActionSchema = z.object({
  type: z.literal("fixed-response"),
  contentType: z.enum([
    "text/plain",
    "text/css",
    "text/html",
    "application/javascript",
    "application/json",
  ]),
  messageBody: z.string().optional(),
  statusCode: z.string().optional(),
});

const ActionSchema = z
  .discriminatedUnion("type", [
    ForwardActionSchema,
    RedirectActionSchema,
    FixedResponseActionSchema,
  ])
  .superRefine((action, ctx) => {
    if (
      action.type === "forward" &&
      !action.targetGroup &&
      !action.targetGroups
    ) {
      ctx.addIssue({
        code: "custom",
        message:
          "forward actions require targetGroup or targetGroups.",
        path: ["targetGroup"],
      });
    }
  });

const RuleConditionSchema = z.object({
  hostHeaders: z.array(z.string()).min(1).optional(),
  pathPatterns: z.array(z.string()).min(1).optional(),
  sourceIps: z.array(z.string()).min(1).optional(),
  methods: z.array(z.string()).min(1).optional(),
  httpHeader: z
    .object({
      name: z.string(),
      values: z.array(z.string()).min(1),
    })
    .optional(),
  queryStrings: z
    .array(
      z.object({
        key: z.string().optional(),
        value: z.string(),
      }),
    )
    .min(1)
    .optional(),
});

const ListenerRuleSchema = z.object({
  priority: z.number().min(1).max(50000),
  conditions: z.array(RuleConditionSchema).min(1),
  actions: z.array(ActionSchema).min(1),
});

const ListenerSchema = z
  .object({
    port: z.number().min(1).max(65535),
    protocol: ListenerProtocol,
    certificateArn: z.string().optional(),
    sslPolicy: z.string().default(TLS_POLICY),
    defaultAction: ActionSchema,
    rules: z.array(ListenerRuleSchema).default([]),
  })
  .superRefine((listener, ctx) => {
    if (
      (listener.protocol === "HTTPS" || listener.protocol === "TLS") &&
      !listener.certificateArn
    ) {
      ctx.addIssue({
        code: "custom",
        message: "HTTPS/TLS listeners require certificateArn.",
        path: ["certificateArn"],
      });
    }
  });

const HealthCheckSchema = z.object({
  enabled: z.boolean().optional(),
  path: z.string().default(DEFAULT_HEALTH_CHECK_PATH),
  protocol: z.enum(["TCP", "HTTP", "HTTPS"]).optional(),
  port: z.string().optional(),
  matcher: z.string().optional(),
  interval: z.number().optional(),
  timeout: z.number().optional(),
  healthyThreshold: z.number().optional(),
  unhealthyThreshold: z.number().optional(),
});

const TargetSchema = z.object({
  id: z.string(),
  port: z.number().min(1).max(65535).optional(),
  availabilityZone: z.string().optional(),
});

const TargetGroupSchema = z
  .object({
    targetType: z.enum(["instance", "ip", "lambda", "alb"]),
    port: z.number().min(1).max(65535).optional(),
    protocol: TargetProtocol.optional(),
    healthCheck: HealthCheckSchema.optional(),
    deregistrationDelay: z.number().default(DEFAULT_DEREGISTRATION_DELAY),
    targets: z.array(TargetSchema).default([]),
  })
  .superRefine((targetGroup, ctx) => {
    if (targetGroup.targetType === "lambda") {
      if (targetGroup.port !== undefined) {
        ctx.addIssue({
          code: "custom",
          message: "lambda target groups must omit port.",
          path: ["port"],
        });
      }
      if (targetGroup.protocol !== undefined) {
        ctx.addIssue({
          code: "custom",
          message: "lambda target groups must omit protocol.",
          path: ["protocol"],
        });
      }
      return;
    }

    if (targetGroup.port === undefined) {
      ctx.addIssue({
        code: "custom",
        message: "non-lambda target groups require port.",
        path: ["port"],
      });
    }
    if (targetGroup.protocol === undefined) {
      ctx.addIssue({
        code: "custom",
        message: "non-lambda target groups require protocol.",
        path: ["protocol"],
      });
    }
  });

const ConfigSchema = z
  .object({
    type: z.enum(["application", "network"]),
    internal: z.boolean(),
    vpcId: z.string(),
    subnetIds: z.array(z.string()).min(1),
    allowedIngressCidrs: z.array(z.string()).min(1),
    listeners: z.array(ListenerSchema).min(1),
    targetGroups: z.record(z.string(), TargetGroupSchema),
    deletionProtection: z.boolean().default(false),
    ipAddressType: z.string().default(DEFAULT_IP_ADDRESS_TYPE),
    application: ApplicationSettingsSchema.default({
      http2: true,
      dropInvalidHeaderFields: true,
    }),
    network: NetworkSettingsSchema.default({
      crossZone: false,
    }),
    accessLogs: AccessLogsSchema.optional(),
  })
  .superRefine((config, ctx) => {
    const targetGroupNames = new Set(Object.keys(config.targetGroups));

    if (targetGroupNames.size === 0) {
      ctx.addIssue({
        code: "custom",
        message: "targetGroups must contain at least one target group.",
        path: ["targetGroups"],
      });
    }

    if (config.type === "application") {
      validateAbsentNetworkSettings(config, ctx);
    } else {
      validateAbsentApplicationSettings(config, ctx);
      if (
        config.network.eipAllocationIds !== undefined &&
        config.network.eipAllocationIds.length !== config.subnetIds.length
      ) {
        ctx.addIssue({
          code: "custom",
          message:
            "network.eipAllocationIds must contain one allocation ID per subnet.",
          path: ["network", "eipAllocationIds"],
        });
      }
    }

    config.listeners.forEach((listener, listenerIndex) => {
      validateListenerForLoadBalancerType(config.type, listener, ctx, [
        "listeners",
        listenerIndex,
      ]);
      validateActionTargetGroups(listener.defaultAction, targetGroupNames, ctx, [
        "listeners",
        listenerIndex,
        "defaultAction",
      ]);

      listener.rules.forEach((rule, ruleIndex) => {
        if (config.type === "network") {
          ctx.addIssue({
            code: "custom",
            message: "network load balancers do not support listener rules.",
            path: ["listeners", listenerIndex, "rules", ruleIndex],
          });
        }
        rule.actions.forEach((action, actionIndex) => {
          validateActionTargetGroups(action, targetGroupNames, ctx, [
            "listeners",
            listenerIndex,
            "rules",
            ruleIndex,
            "actions",
            actionIndex,
          ]);
        });
      });
    });

    Object.entries(config.targetGroups).forEach(([name, targetGroup]) => {
      validateTargetGroupForLoadBalancerType(
        config.type,
        name,
        targetGroup,
        ctx,
      );
    });
  });

const component = new InfraComponent({
  metadata: {
    stateful: false,
    proxiable: false,
  },
  connectionTypes: {},
  configSchema: ConfigSchema,
  appComponentTypes: {},
  outputSchema: z.object({
    arn: z.string(),
    dnsName: z.string(),
    zoneId: z.string(),
    listenerArns: z.record(z.string(), z.string()),
    targetGroupArns: z.record(z.string(), z.string()),
    securityGroupId: z.string(),
  }),
});

component.implement("aws", {
  pulumi: async ({ $, inputs, aws: provider }) => {
    const awsOpts: pulumi.CustomResourceOptions = provider
      ? { provider }
      : {};

    const {
      type,
      internal,
      vpcId,
      subnetIds,
      allowedIngressCidrs,
      listeners,
      targetGroups,
      deletionProtection,
      ipAddressType,
      application,
      network,
      accessLogs,
    } = inputs as z.infer<typeof ConfigSchema>;

    const securityGroup = new aws.ec2.SecurityGroup($`sg`, {
      name: $`sg`,
      description: "Managed by sdlc.works aws-lb component",
      vpcId,
      ingress: buildIngressRules(listeners, allowedIngressCidrs),
      egress: [
        {
          protocol: "-1",
          fromPort: 0,
          toPort: 0,
          cidrBlocks: ["0.0.0.0/0"],
          description: "Allow all outbound",
        },
      ],
      revokeRulesOnDelete: true,
      tags: {
        Name: $`sg`,
      },
    }, awsOpts);

    const loadBalancerArgs: aws.lb.LoadBalancerArgs = {
      name: $`lb`,
      loadBalancerType: type,
      internal,
      ipAddressType,
      securityGroups: [securityGroup.id],
      enableDeletionProtection: deletionProtection,
      ...(accessLogs
        ? {
            accessLogs: {
              bucket: accessLogs.bucket,
              prefix: accessLogs.prefix,
              enabled: true,
            },
          }
        : {}),
      ...(type === "application"
        ? {
            subnets: subnetIds,
            idleTimeout: DEFAULT_IDLE_TIMEOUT,
            enableHttp2: application.http2,
            dropInvalidHeaderFields: application.dropInvalidHeaderFields,
          }
        : {
            enableCrossZoneLoadBalancing: network.crossZone,
            ...(network.eipAllocationIds
              ? {
                  subnetMappings: subnetIds.map((subnetId, index) => ({
                    subnetId,
                    allocationId: network.eipAllocationIds?.[index],
                  })),
                }
              : { subnets: subnetIds }),
          }),
      tags: {
        Name: $`lb`,
      },
    };

    const loadBalancer = new aws.lb.LoadBalancer(
      $`lb`,
      loadBalancerArgs,
      awsOpts,
    );

    if (type === "application" && application.wafWebAclArn) {
      new aws.wafv2.WebAclAssociation($`waf-assoc`, {
        resourceArn: loadBalancer.arn,
        webAclArn: application.wafWebAclArn,
      }, awsOpts);
    }

    const targetGroupResources: Record<string, aws.lb.TargetGroup> = {};
    for (const [name, targetGroup] of Object.entries(targetGroups)) {
      targetGroupResources[name] = new aws.lb.TargetGroup($`tg-${name}`, {
        name: $`tg-${name}`,
        targetType: targetGroup.targetType,
        deregistrationDelay: targetGroup.deregistrationDelay,
        ...(targetGroup.targetType === "lambda"
          ? {}
          : {
              port: targetGroup.port,
              protocol: targetGroup.protocol,
              vpcId,
            }),
        ...(targetGroup.healthCheck
          ? {
              healthCheck: buildHealthCheck(
                targetGroup.targetType,
                targetGroup.protocol,
                targetGroup.healthCheck,
              ),
            }
          : {}),
        tags: {
          Name: $`tg-${name}`,
        },
      }, awsOpts);
    }

    for (const [name, targetGroup] of Object.entries(targetGroups)) {
      const targetGroupResource = targetGroupResources[name];
      for (let index = 0; index < targetGroup.targets.length; index += 1) {
        const target = targetGroup.targets[index];
        let dependsOn: pulumi.Input<pulumi.Resource>[] | undefined;

        if (targetGroup.targetType === "lambda") {
          const permission = new aws.lambda.Permission(
            $`tg-${name}-lambda-${index}`,
            {
              action: LAMBDA_INVOKE_ACTION,
              function: target.id,
              principal: LAMBDA_INVOKE_PRINCIPAL,
              sourceArn: targetGroupResource.arn,
            },
            awsOpts,
          );
          dependsOn = [permission];
        }

        new aws.lb.TargetGroupAttachment(
          $`tg-${name}-target-${index}`,
          {
            targetGroupArn: targetGroupResource.arn,
            targetId: target.id,
            port: target.port,
            availabilityZone: target.availabilityZone,
          },
          {
            ...awsOpts,
            dependsOn,
          },
        );
      }
    }

    const listenerResources: Record<string, aws.lb.Listener> = {};
    for (let index = 0; index < listeners.length; index += 1) {
      const listener = listeners[index];
      const listenerName = `listener-${index}`;
      listenerResources[listenerName] = new aws.lb.Listener($`${listenerName}`, {
        loadBalancerArn: loadBalancer.arn,
        port: listener.port,
        protocol: listener.protocol,
        defaultActions: [
          buildListenerAction(listener.defaultAction, targetGroupResources),
        ],
        ...(listener.certificateArn
          ? {
              certificateArn: listener.certificateArn,
              sslPolicy: listener.sslPolicy,
            }
          : {}),
        tags: {
          Name: $`${listenerName}`,
        },
      }, awsOpts);

      for (let ruleIndex = 0; ruleIndex < listener.rules.length; ruleIndex += 1) {
        const rule = listener.rules[ruleIndex];
        new aws.lb.ListenerRule(
          $`${listenerName}-rule-${ruleIndex}`,
          {
            listenerArn: listenerResources[listenerName].arn,
            priority: rule.priority,
            actions: rule.actions.map((action: z.infer<typeof ActionSchema>) =>
              buildListenerAction(action, targetGroupResources),
            ),
            conditions: rule.conditions.flatMap(buildRuleConditions),
            tags: {
              Name: $`${listenerName}-rule-${ruleIndex}`,
            },
          },
          awsOpts,
        );
      }
    }

    return {
      arn: loadBalancer.arn,
      dnsName: loadBalancer.dnsName,
      zoneId: loadBalancer.zoneId,
      listenerArns: pulumi.output(
        Object.fromEntries(
          Object.entries(listenerResources).map(([name, listener]) => [
            name,
            listener.arn,
          ]),
        ),
      ),
      targetGroupArns: pulumi.output(
        Object.fromEntries(
          Object.entries(targetGroupResources).map(([name, targetGroup]) => [
            name,
            targetGroup.arn,
          ]),
        ),
      ),
      securityGroupId: securityGroup.id,
    };
  },
});

function validateAbsentNetworkSettings(
  config: z.infer<typeof ConfigSchema>,
  ctx: z.RefinementCtx,
) {
  if (config.network.crossZone !== false) {
    ctx.addIssue({
      code: "custom",
      message: "application load balancers do not accept network.crossZone.",
      path: ["network", "crossZone"],
    });
  }
  if (config.network.eipAllocationIds !== undefined) {
    ctx.addIssue({
      code: "custom",
      message:
        "application load balancers do not accept network.eipAllocationIds.",
      path: ["network", "eipAllocationIds"],
    });
  }
}

function validateAbsentApplicationSettings(
  config: z.infer<typeof ConfigSchema>,
  ctx: z.RefinementCtx,
) {
  if (config.application.http2 !== true) {
    ctx.addIssue({
      code: "custom",
      message: "network load balancers do not accept application.http2.",
      path: ["application", "http2"],
    });
  }
  if (config.application.dropInvalidHeaderFields !== true) {
    ctx.addIssue({
      code: "custom",
      message:
        "network load balancers do not accept application.dropInvalidHeaderFields.",
      path: ["application", "dropInvalidHeaderFields"],
    });
  }
  if (config.application.wafWebAclArn !== undefined) {
    ctx.addIssue({
      code: "custom",
      message: "network load balancers do not accept application.wafWebAclArn.",
      path: ["application", "wafWebAclArn"],
    });
  }
}

function validateListenerForLoadBalancerType(
  loadBalancerType: "application" | "network",
  listener: z.infer<typeof ListenerSchema>,
  ctx: z.RefinementCtx,
  path: (string | number)[],
) {
  const applicationProtocols = new Set(["HTTP", "HTTPS"]);
  const networkProtocols = new Set([
    "TCP",
    "TLS",
    "UDP",
    "TCP_UDP",
  ]);
  const valid = loadBalancerType === "application"
    ? applicationProtocols.has(listener.protocol)
    : networkProtocols.has(listener.protocol);

  if (!valid) {
    ctx.addIssue({
      code: "custom",
      message: `${loadBalancerType} load balancers do not support ${listener.protocol} listeners.`,
      path: [...path, "protocol"],
    });
  }
}

function validateTargetGroupForLoadBalancerType(
  loadBalancerType: "application" | "network",
  name: string,
  targetGroup: z.infer<typeof TargetGroupSchema>,
  ctx: z.RefinementCtx,
) {
  const path = ["targetGroups", name];

  if (loadBalancerType === "application") {
    if (
      targetGroup.targetType === "alb" ||
      (targetGroup.protocol !== undefined &&
        !["HTTP", "HTTPS"].includes(targetGroup.protocol))
    ) {
      ctx.addIssue({
        code: "custom",
        message:
          "application load balancers support HTTP/HTTPS target groups and lambda targets.",
        path,
      });
    }
    return;
  }

  if (
    targetGroup.targetType === "lambda" ||
    (targetGroup.protocol !== undefined &&
      !["TCP", "TLS", "UDP", "TCP_UDP"].includes(targetGroup.protocol))
  ) {
    ctx.addIssue({
      code: "custom",
      message:
        "network load balancers support TCP/TLS/UDP/TCP_UDP target groups and do not support lambda targets.",
      path,
    });
  }
}

function validateActionTargetGroups(
  action: z.infer<typeof ActionSchema>,
  targetGroupNames: Set<string>,
  ctx: z.RefinementCtx,
  path: (string | number)[],
) {
  if (action.type !== "forward") {
    return;
  }

  if (action.targetGroup && !targetGroupNames.has(action.targetGroup)) {
    ctx.addIssue({
      code: "custom",
      message: `unknown target group '${action.targetGroup}'.`,
      path: [...path, "targetGroup"],
    });
  }

  action.targetGroups?.forEach((targetGroup, index) => {
    if (!targetGroupNames.has(targetGroup.targetGroup)) {
      ctx.addIssue({
        code: "custom",
        message: `unknown target group '${targetGroup.targetGroup}'.`,
        path: [...path, "targetGroups", index, "targetGroup"],
      });
    }
  });
}

function buildIngressRules(
  listeners: z.infer<typeof ListenerSchema>[],
  allowedIngressCidrs: string[],
) {
  return listeners.flatMap((listener) => {
    const protocols = listener.protocol === "UDP"
      ? ["udp"]
      : listener.protocol === "TCP_UDP"
        ? ["tcp", "udp"]
        : ["tcp"];

    return protocols.map((protocol) => ({
      protocol,
      fromPort: listener.port,
      toPort: listener.port,
      cidrBlocks: allowedIngressCidrs,
      description: `Allow ${listener.protocol} listener ${listener.port}`,
    }));
  });
}

function buildHealthCheck(
  targetType: string,
  targetProtocol: string | undefined,
  healthCheck: z.infer<typeof HealthCheckSchema>,
) {
  if (targetType === "lambda") {
    const { protocol, port, path, ...lambdaHealthCheck } = healthCheck;
    void protocol;
    void port;
    return {
      ...lambdaHealthCheck,
      path,
    };
  }

  const effectiveProtocol = healthCheck.protocol ?? targetProtocol;
  if (
    effectiveProtocol !== undefined &&
    !["HTTP", "HTTPS"].includes(effectiveProtocol)
  ) {
    const { path, matcher, ...connectionHealthCheck } = healthCheck;
    void path;
    void matcher;
    return connectionHealthCheck;
  }

  return healthCheck;
}

function buildListenerAction(
  action: z.infer<typeof ActionSchema>,
  targetGroups: Record<string, aws.lb.TargetGroup>,
) {
  if (action.type === "redirect") {
    return {
      type: action.type,
      redirect: {
        statusCode: action.statusCode,
        host: action.host,
        path: action.path,
        port: action.port,
        protocol: action.protocol,
        query: action.query,
      },
    };
  }

  if (action.type === "fixed-response") {
    return {
      type: action.type,
      fixedResponse: {
        contentType: action.contentType,
        messageBody: action.messageBody,
        statusCode: action.statusCode,
      },
    };
  }

  if (action.targetGroups) {
    return {
      type: action.type,
      forward: {
        targetGroups: action.targetGroups.map((targetGroup) => ({
          arn: targetGroups[targetGroup.targetGroup].arn,
          weight: targetGroup.weight,
        })),
      },
    };
  }

  return {
    type: action.type,
    targetGroupArn: targetGroups[action.targetGroup as string].arn,
  };
}

function buildRuleConditions(condition: z.infer<typeof RuleConditionSchema>) {
  const conditions = [];

  if (condition.hostHeaders) {
    conditions.push({
      hostHeader: {
        values: condition.hostHeaders,
      },
    });
  }
  if (condition.pathPatterns) {
    conditions.push({
      pathPattern: {
        values: condition.pathPatterns,
      },
    });
  }
  if (condition.sourceIps) {
    conditions.push({
      sourceIp: {
        values: condition.sourceIps,
      },
    });
  }
  if (condition.methods) {
    conditions.push({
      httpRequestMethod: {
        values: condition.methods,
      },
    });
  }
  if (condition.httpHeader) {
    conditions.push({
      httpHeader: {
        httpHeaderName: condition.httpHeader.name,
        values: condition.httpHeader.values,
      },
    });
  }
  if (condition.queryStrings) {
    conditions.push({
      queryStrings: condition.queryStrings,
    });
  }

  return conditions;
}

export default component;
