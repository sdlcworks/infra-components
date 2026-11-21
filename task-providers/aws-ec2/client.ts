import { EC2Client } from "@aws-sdk/client-ec2";
import { IAMClient } from "@aws-sdk/client-iam";
import { S3Client } from "@aws-sdk/client-s3";
import { awsClientConfig } from "../aws-common";
import type { AwsEc2Configuration, AwsEc2Credentials } from "./schemas";

export function createAwsEc2Clients(
  configuration: AwsEc2Configuration,
  credentials: AwsEc2Credentials,
) {
  const config = awsClientConfig(configuration.region, configuration.client, credentials);
  return {
    ec2: new EC2Client(config),
    iam: new IAMClient(config),
    s3: new S3Client({
      ...config,
      forcePathStyle: configuration.client.s3AddressingStyle === "path",
    }),
  };
}
