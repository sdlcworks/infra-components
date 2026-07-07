import { z } from "zod";

import { CloudProvider, InfraComponent } from "@sdlcworks/components";

import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";

const MANAGED_CACHE_POLICY_IDS = {
  cachingOptimized: "658327ea-f89d-4fab-a63d-7e88639e58f6",
  cachingDisabled: "4135ea2d-6df8-44a3-9df3-4b5a84be39ad",
} as const;

const MANAGED_ORIGIN_REQUEST_POLICY_IDS = {
  allViewer: "216adef6-5c7f-47e4-b989-5492eafa07d3",
  allViewerExceptHostHeader: "b689b0a8-53d0-40ab-baf2-68738e2966ac",
  corsS3Origin: "88a5eaf4-2fd4-4709-b370-b4c650ea3fcf",
  corsCustomOrigin: "59781a5b-3903-41f3-afcb-af62929ccde1",
} as const;

const MANAGED_RESPONSE_HEADERS_POLICY_IDS = {
  corsWithPreflight: "5cc3b908-e619-4b99-88e5-2cf7f45965bd",
  securityHeaders: "67f7725c-6f97-4210-82d7-5512b31e9d03",
  simpleCors: "60669652-455b-4ae9-85a4-c4c02393f86c",
} as const;

const OAC_ORIGIN_TYPE = "s3";
const OAC_SIGNING_BEHAVIOR = "always";
const OAC_SIGNING_PROTOCOL = "sigv4";
const MINIMUM_TLS_VERSION = "TLSv1.2_2021";
const SSL_SUPPORT_METHOD = "sni-only";
const CLOUDFRONT_HOSTED_ZONE_ID = "Z2FDTNDATAQYW2";
const VIEWER_PROTOCOL_POLICY = "redirect-to-https";
const CUSTOM_ORIGIN_PROTOCOL_POLICY = "https-only";
const HTTP_VERSION = "http2and3";
const PRICE_CLASS_100 = "PriceClass_100";
const PRICE_CLASS_200 = "PriceClass_200";
const PRICE_CLASS_ALL = "PriceClass_All";
const S3_OBJECT_ARN_SUFFIX = "/*";
const CLOUDFRONT_SERVICE_PRINCIPAL = "cloudfront.amazonaws.com";
const AWS_SOURCE_ARN_CONDITION = "AWS:SourceArn";
const S3_GET_OBJECT_ACTION = "s3:GetObject";
const CUSTOM_ORIGIN_HTTP_PORT = 80;
const CUSTOM_ORIGIN_HTTPS_PORT = 443;
const ORIGIN_SSL_PROTOCOLS = ["TLSv1.2"];
const ALLOWED_METHODS = [
  "GET",
  "HEAD",
  "OPTIONS",
  "PUT",
  "POST",
  "PATCH",
  "DELETE",
];
const CACHED_METHODS = ["GET", "HEAD"];

const CachePolicySchema = z.union([
  z.enum(["caching-optimized", "caching-disabled"]),
  z.object({
    id: z.string(),
  }),
]);

const OriginRequestPolicySchema = z.union([
  z.enum([
    "all-viewer",
    "all-viewer-except-host-header",
    "cors-s3-origin",
    "cors-custom-origin",
  ]),
  z.object({
    id: z.string(),
  }),
]);

const ResponseHeadersPolicySchema = z.union([
  z.enum(["cors-with-preflight", "security-headers", "simple-cors"]),
  z.object({
    id: z.string(),
  }),
]);

const S3OriginSchema = z.object({
  type: z.literal("s3"),
  id: z.string(),
  bucketName: z.string(),
  regionalDomainName: z.string(),
});

const LoadBalancerOriginSchema = z.object({
  type: z.literal("load-balancer"),
  id: z.string(),
  domainName: z.string(),
  protocolPolicy: z.string().default(CUSTOM_ORIGIN_PROTOCOL_POLICY),
});

const CustomOriginSchema = z.object({
  type: z.literal("custom"),
  id: z.string(),
  domainName: z.string(),
  protocolPolicy: z.string().default(CUSTOM_ORIGIN_PROTOCOL_POLICY),
});

const OriginSchema = z.discriminatedUnion("type", [
  S3OriginSchema,
  LoadBalancerOriginSchema,
  CustomOriginSchema,
]);

const BehaviorSchema = z.object({
  targetOrigin: z.string(),
  cachePolicy: CachePolicySchema,
  originRequestPolicy: OriginRequestPolicySchema.optional(),
  responseHeadersPolicy: ResponseHeadersPolicySchema.optional(),
  viewerProtocolPolicy: z.string().default(VIEWER_PROTOCOL_POLICY),
  compress: z.boolean().default(true),
});

const AdditionalBehaviorSchema = BehaviorSchema.extend({
  pathPattern: z.string(),
});

const CustomDomainSchema = z.object({
  aliases: z.array(z.string()).min(1),
  certificateArn: z.string(),
  minimumProtocolVersion: z.string().default(MINIMUM_TLS_VERSION),
  sslSupportMethod: z.string().default(SSL_SUPPORT_METHOD),
});

const LoggingSchema = z.object({
  bucket: z.string(),
  prefix: z.string().optional(),
  includeCookies: z.boolean().default(false),
});

const GeoRestrictionSchema = z.object({
  restrictionType: z.enum(["none", "whitelist", "blacklist"]).default("none"),
  locations: z.array(z.string()).default([]),
});

const ConfigSchema = z
  .object({
    origins: z.array(OriginSchema).min(1),
    defaultBehavior: BehaviorSchema,
    priceClass: z.enum(["100", "200", "all"]),
    customDomain: CustomDomainSchema.optional(),
    additionalBehaviors: z.array(AdditionalBehaviorSchema).default([]),
    webAclId: z.string().optional(),
    logging: LoggingSchema.optional(),
    defaultRootObject: z.string().optional(),
    isIpv6Enabled: z.boolean().default(true),
    httpVersion: z.string().default(HTTP_VERSION),
    enabled: z.boolean().default(true),
    geoRestriction: GeoRestrictionSchema.default({
      restrictionType: "none",
      locations: [],
    }),
  })
  .superRefine((config, ctx) => {
    const originIds = new Set<string>();
    const s3BucketNames = new Set<string>();

    config.origins.forEach((origin, index) => {
      if (originIds.has(origin.id)) {
        ctx.addIssue({
          code: "custom",
          message: `duplicate origin id "${origin.id}".`,
          path: ["origins", index, "id"],
        });
      }
      originIds.add(origin.id);

      if (origin.type === "s3") {
        if (s3BucketNames.has(origin.bucketName)) {
          ctx.addIssue({
            code: "custom",
            message:
              "duplicate S3 bucket origin; a bucket policy is a singleton managed by one origin claim.",
            path: ["origins", index, "bucketName"],
          });
        }
        s3BucketNames.add(origin.bucketName);
      }
    });

    if (!originIds.has(config.defaultBehavior.targetOrigin)) {
      ctx.addIssue({
        code: "custom",
        message: "defaultBehavior.targetOrigin must match an origin id.",
        path: ["defaultBehavior", "targetOrigin"],
      });
    }

    config.additionalBehaviors.forEach((behavior, index) => {
      if (!originIds.has(behavior.targetOrigin)) {
        ctx.addIssue({
          code: "custom",
          message: "additional behavior targetOrigin must match an origin id.",
          path: ["additionalBehaviors", index, "targetOrigin"],
        });
      }
    });
  });

type Config = z.infer<typeof ConfigSchema>;
type Origin = z.infer<typeof OriginSchema>;
type Behavior = z.infer<typeof BehaviorSchema>;
type AdditionalBehavior = z.infer<typeof AdditionalBehaviorSchema>;
type CachePolicy = z.infer<typeof CachePolicySchema>;
type OriginRequestPolicy = z.infer<typeof OriginRequestPolicySchema>;
type ResponseHeadersPolicy = z.infer<typeof ResponseHeadersPolicySchema>;

const component = new InfraComponent({
  metadata: {
    stateful: false,
    proxiable: false,
  },
  connectionTypes: {},
  configSchema: ConfigSchema,
  appComponentTypes: {},
  outputSchema: z.object({
    distributionId: z.string(),
    domainName: z.string(),
    arn: z.string(),
    hostedZoneId: z.string(),
  }),
});

component.implement(CloudProvider.aws, {
  pulumi: async ({ $, inputs, aws: provider }) => {
    const awsOpts: pulumi.CustomResourceOptions = provider
      ? { provider }
      : {};
    const config = inputs as Config;

    const s3Origins = config.origins.filter((origin) => origin.type === "s3");
    const originAccessControls = Object.fromEntries(
      s3Origins.map((origin) => [
        origin.id,
        new aws.cloudfront.OriginAccessControl(
          $`oac-${origin.id}`,
          {
            name: $`oac-${origin.id}`,
            originAccessControlOriginType: OAC_ORIGIN_TYPE,
            signingBehavior: OAC_SIGNING_BEHAVIOR,
            signingProtocol: OAC_SIGNING_PROTOCOL,
          },
          awsOpts,
        ),
      ]),
    );

    const distribution = new aws.cloudfront.Distribution(
      $`distribution`,
      {
        origins: config.origins.map((origin) =>
          buildOrigin(origin, originAccessControls),
        ),
        defaultCacheBehavior: buildDefaultCacheBehavior(
          config.defaultBehavior,
        ),
        orderedCacheBehaviors: config.additionalBehaviors.map(
          buildOrderedCacheBehavior,
        ),
        enabled: config.enabled,
        isIpv6Enabled: config.isIpv6Enabled,
        httpVersion: config.httpVersion,
        priceClass: mapPriceClass(config.priceClass),
        restrictions: {
          geoRestriction: config.geoRestriction,
        },
        viewerCertificate: buildViewerCertificate(config.customDomain),
        ...(config.customDomain
          ? { aliases: config.customDomain.aliases }
          : {}),
        ...(config.defaultRootObject
          ? { defaultRootObject: config.defaultRootObject }
          : {}),
        ...(config.logging
          ? {
              loggingConfig: {
                bucket: config.logging.bucket,
                prefix: config.logging.prefix,
                includeCookies: config.logging.includeCookies,
              },
            }
          : {}),
        ...(config.webAclId ? { webAclId: config.webAclId } : {}),
      },
      awsOpts,
    );

    s3Origins.forEach((origin) => {
      // CloudFront owns this singleton policy because its distribution ARN is
      // the condition that keeps the referenced bucket non-public.
      const policy = aws.iam.getPolicyDocumentOutput({
        statements: [
          {
            effect: "Allow",
            principals: [
              {
                type: "Service",
                identifiers: [CLOUDFRONT_SERVICE_PRINCIPAL],
              },
            ],
            actions: [S3_GET_OBJECT_ACTION],
            resources: [
              pulumi.interpolate`arn:aws:s3:::${origin.bucketName}${S3_OBJECT_ARN_SUFFIX}`,
            ],
            conditions: [
              {
                test: "StringEquals",
                variable: AWS_SOURCE_ARN_CONDITION,
                values: [distribution.arn],
              },
            ],
          },
        ],
      });

      new aws.s3.BucketPolicy(
        $`bucket-policy-${origin.id}`,
        {
          bucket: origin.bucketName,
          policy: policy.json,
        },
        awsOpts,
      );
    });

    return {
      distributionId: distribution.id,
      domainName: distribution.domainName,
      arn: distribution.arn,
      hostedZoneId: pulumi.output(CLOUDFRONT_HOSTED_ZONE_ID),
    };
  },
});

function buildOrigin(
  origin: Origin,
  originAccessControls: Record<string, aws.cloudfront.OriginAccessControl>,
) {
  if (origin.type === "s3") {
    return {
      originId: origin.id,
      domainName: origin.regionalDomainName,
      originAccessControlId: originAccessControls[origin.id].id,
    };
  }

  return {
    originId: origin.id,
    domainName: origin.domainName,
    customOriginConfig: {
      httpPort: CUSTOM_ORIGIN_HTTP_PORT,
      httpsPort: CUSTOM_ORIGIN_HTTPS_PORT,
      originProtocolPolicy: origin.protocolPolicy,
      originSslProtocols: ORIGIN_SSL_PROTOCOLS,
    },
  };
}

function buildDefaultCacheBehavior(behavior: Behavior) {
  return {
    allowedMethods: ALLOWED_METHODS,
    cachedMethods: CACHED_METHODS,
    targetOriginId: behavior.targetOrigin,
    cachePolicyId: resolveCachePolicyId(behavior.cachePolicy),
    originRequestPolicyId: behavior.originRequestPolicy
      ? resolveOriginRequestPolicyId(behavior.originRequestPolicy)
      : undefined,
    responseHeadersPolicyId: behavior.responseHeadersPolicy
      ? resolveResponseHeadersPolicyId(behavior.responseHeadersPolicy)
      : undefined,
    compress: behavior.compress,
    viewerProtocolPolicy: behavior.viewerProtocolPolicy,
  };
}

function buildOrderedCacheBehavior(behavior: AdditionalBehavior) {
  return {
    ...buildDefaultCacheBehavior(behavior),
    pathPattern: behavior.pathPattern,
  };
}

function buildViewerCertificate(customDomain: Config["customDomain"]) {
  if (!customDomain) {
    return {
      cloudfrontDefaultCertificate: true,
    };
  }

  return {
    acmCertificateArn: customDomain.certificateArn,
    minimumProtocolVersion: customDomain.minimumProtocolVersion,
    sslSupportMethod: customDomain.sslSupportMethod,
  };
}

function resolveCachePolicyId(cachePolicy: CachePolicy): string {
  if (typeof cachePolicy !== "string") {
    return cachePolicy.id;
  }

  switch (cachePolicy) {
    case "caching-optimized":
      return MANAGED_CACHE_POLICY_IDS.cachingOptimized;
    case "caching-disabled":
      return MANAGED_CACHE_POLICY_IDS.cachingDisabled;
  }
}

function resolveOriginRequestPolicyId(
  originRequestPolicy: OriginRequestPolicy,
): string {
  if (typeof originRequestPolicy !== "string") {
    return originRequestPolicy.id;
  }

  switch (originRequestPolicy) {
    case "all-viewer":
      return MANAGED_ORIGIN_REQUEST_POLICY_IDS.allViewer;
    case "all-viewer-except-host-header":
      return MANAGED_ORIGIN_REQUEST_POLICY_IDS.allViewerExceptHostHeader;
    case "cors-s3-origin":
      return MANAGED_ORIGIN_REQUEST_POLICY_IDS.corsS3Origin;
    case "cors-custom-origin":
      return MANAGED_ORIGIN_REQUEST_POLICY_IDS.corsCustomOrigin;
  }
}

function resolveResponseHeadersPolicyId(
  responseHeadersPolicy: ResponseHeadersPolicy,
): string {
  if (typeof responseHeadersPolicy !== "string") {
    return responseHeadersPolicy.id;
  }

  switch (responseHeadersPolicy) {
    case "cors-with-preflight":
      return MANAGED_RESPONSE_HEADERS_POLICY_IDS.corsWithPreflight;
    case "security-headers":
      return MANAGED_RESPONSE_HEADERS_POLICY_IDS.securityHeaders;
    case "simple-cors":
      return MANAGED_RESPONSE_HEADERS_POLICY_IDS.simpleCors;
  }
}

function mapPriceClass(priceClass: Config["priceClass"]): string {
  switch (priceClass) {
    case "100":
      return PRICE_CLASS_100;
    case "200":
      return PRICE_CLASS_200;
    case "all":
      return PRICE_CLASS_ALL;
  }
}

export default component;
