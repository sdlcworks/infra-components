import * as pulumi from "@pulumi/pulumi";

interface SecretWaiterInputs {
  secretId: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  expectedPublisherInstanceId: string;
  value?: string;
}

class SecretValueWaiterProvider implements pulumi.dynamic.ResourceProvider {
  private async readValue(inputs: SecretWaiterInputs): Promise<string> {
    const { GetSecretValueCommand, SecretsManagerClient } = await import(
      "@aws-sdk/client-secrets-manager"
    );
    const client = new SecretsManagerClient({
      region: inputs.region,
      credentials: {
        accessKeyId: inputs.accessKeyId,
        secretAccessKey: inputs.secretAccessKey,
        sessionToken: inputs.sessionToken,
      },
    });

    const deadline = Date.now() + 25 * 60 * 1000;
    let lastError: unknown;
    while (Date.now() < deadline) {
      try {
        const result = await client.send(
          new GetSecretValueCommand({ SecretId: inputs.secretId }),
        );
        if (!result.SecretString) {
          lastError = new Error(
            `secret ${inputs.secretId} has no string value yet`,
          );
        } else {
          const payload = JSON.parse(result.SecretString) as {
            publisherInstanceId?: string;
            kubeconfig?: string;
          };
          if (
            payload.publisherInstanceId === inputs.expectedPublisherInstanceId &&
            payload.kubeconfig
          ) {
            return payload.kubeconfig;
          }
          lastError = new Error(
            `secret ${inputs.secretId} was not published by current bootstrap server ${inputs.expectedPublisherInstanceId}`,
          );
        }
      } catch (error) {
        lastError = error;
      }
      await new Promise((resolve) => setTimeout(resolve, 5_000));
    }

    throw new Error(
      `k3s (aws): timed out waiting for protected kubeconfig ${inputs.secretId}: ${String(lastError)}`,
    );
  }

  async create(inputs: SecretWaiterInputs): Promise<pulumi.dynamic.CreateResult> {
    const value = await this.readValue(inputs);
    return {
      id: inputs.secretId,
      outs: { ...inputs, value },
    };
  }

  async diff(
    _id: pulumi.ID,
    olds: SecretWaiterInputs,
    news: SecretWaiterInputs,
  ): Promise<pulumi.dynamic.DiffResult> {
    const replaces = [
      "secretId",
      "region",
      "accessKeyId",
      "secretAccessKey",
      "sessionToken",
      "expectedPublisherInstanceId",
    ].filter(
      (key) =>
        olds[key as keyof SecretWaiterInputs] !==
        news[key as keyof SecretWaiterInputs],
    );
    return { changes: replaces.length > 0, replaces };
  }

  async update(
    _id: pulumi.ID,
    _olds: SecretWaiterInputs,
    news: SecretWaiterInputs,
  ): Promise<pulumi.dynamic.UpdateResult> {
    const value = await this.readValue(news);
    return { outs: { ...news, value } };
  }

  async delete(): Promise<void> {
    // The AWS Secret resource owns deletion; this resource only observes it.
  }
}

export interface SecretValueWaiterArgs {
  secretId: pulumi.Input<string>;
  region: pulumi.Input<string>;
  accessKeyId: pulumi.Input<string>;
  secretAccessKey: pulumi.Input<string>;
  sessionToken?: pulumi.Input<string>;
  expectedPublisherInstanceId: pulumi.Input<string>;
}

export class SecretValueWaiter extends pulumi.dynamic.Resource {
  declare readonly value: pulumi.Output<string>;

  constructor(
    name: string,
    args: SecretValueWaiterArgs,
    opts?: pulumi.CustomResourceOptions,
  ) {
    super(
      new SecretValueWaiterProvider(),
      name,
      {
        secretId: args.secretId,
        region: args.region,
        accessKeyId: pulumi.secret(args.accessKeyId),
        secretAccessKey: pulumi.secret(args.secretAccessKey),
        sessionToken:
          args.sessionToken === undefined
            ? undefined
            : pulumi.secret(args.sessionToken),
        expectedPublisherInstanceId: args.expectedPublisherInstanceId,
        value: undefined,
      },
      {
        ...opts,
        additionalSecretOutputs: [
          ...(opts?.additionalSecretOutputs ?? []),
          "value",
          "accessKeyId",
          "secretAccessKey",
          "sessionToken",
        ],
      },
    );
  }
}
