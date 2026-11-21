import { LambdaClient } from "@aws-sdk/client-lambda";
import { S3Client } from "@aws-sdk/client-s3";
import { awsClientConfig, type AwsCommonDependencies } from "../aws-common";
import type { AwsLambdaConfiguration, AwsLambdaCredentials } from "./schema";

export type AwsLambdaDependencies = AwsCommonDependencies & { lambda: { send(command: unknown): Promise<any> } };

export function createAwsLambdaClients(configuration: AwsLambdaConfiguration, credentials: AwsLambdaCredentials) {
  const client = awsClientConfig(configuration.region, configuration.client, credentials);
  return {
    lambda: new LambdaClient(client),
    s3: new S3Client({
      ...client,
      forcePathStyle: configuration.client.s3AddressingStyle === "path",
    }),
  };
}
