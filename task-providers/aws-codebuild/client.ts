import { CodeBuildClient } from "@aws-sdk/client-codebuild";
import { S3Client } from "@aws-sdk/client-s3";
import { awsClientConfig, type AwsCommonDependencies } from "../aws-common";
import type { AwsCodeBuildConfiguration, AwsCodeBuildCredentials } from "./schema";

export type AwsCodeBuildDependencies = AwsCommonDependencies & {
  codebuild: { send(command: unknown): Promise<any> };
};

export function createAwsCodeBuildClients(
  configuration: AwsCodeBuildConfiguration,
  credentials: AwsCodeBuildCredentials,
) {
  const config = awsClientConfig(configuration.region, configuration.client, credentials);
  return {
    codebuild: new CodeBuildClient(config),
    s3: new S3Client({
      ...config,
      forcePathStyle: configuration.client.s3AddressingStyle === "path",
    }),
  };
}
