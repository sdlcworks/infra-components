import {
  AttachVolumeCommand,
  DescribeInstancesCommand,
  RunInstancesCommand,
  type RunInstancesCommandInput,
} from "@aws-sdk/client-ec2";
import {
  taskProviderLostAnswer,
  taskProviderRefusal,
  type TaskEnactmentAccount,
  type TaskRealizationContext,
} from "@sdlcworks/components/task";
import {
  canonical,
  awsNativeJSON,
  classifyAwsError,
  putAwsObjectImmutable,
  selectRunner,
  sha256,
  stageAwsDelivery,
} from "../aws-common";
import { awsCloudInitProgram, awsGuestCarriageProgram } from "./guest";
import type { AwsEc2Dependencies } from "./index";
import type { AwsEc2AllocationState, AwsEc2Configuration, AwsEc2Credentials, AwsEc2RunState } from "./schemas";

type Context = TaskRealizationContext<AwsEc2Configuration, AwsEc2Credentials, AwsEc2AllocationState, AwsEc2RunState>;
const protectedTagKeys = ["sdlc:run-digest", "sdlc:configuration-digest", "sdlc:archive-sha256", "sdlc:tree-sha256", "sdlc:client-token"];

function ebsShape(volume: AwsEc2Configuration["rootVolume"] | Extract<AwsEc2Configuration["attachedVolume"], { mode: "create-per-run" }>) {
  return {
    VolumeType: volume.volumeType,
    VolumeSize: volume.sizeGiB,
    Encrypted: volume.encrypted,
    ...(volume.iops === null ? {} : { Iops: volume.iops }),
    ...(volume.throughputMiBps === null ? {} : { Throughput: volume.throughputMiBps }),
    ...(volume.kmsKeyId === null ? {} : { KmsKeyId: volume.kmsKeyId }),
  };
}

export function buildRunInstancesInput(context: Context, carriagePrefix: string): RunInstancesCommandInput {
  const configuration = context.configuration;
  const allocation = context.allocationState!;
  const clientToken = sha256(`sdlc-task-ec2-v1\0${context.runId}`);
  const tags = [sha256(context.runId), allocation.configurationDigest, context.definition.content.archiveSha256, context.definition.content.treeSha256, clientToken].map((Value, index) => ({ Key: protectedTagKeys[index], Value }));
  const blockDeviceMappings: NonNullable<RunInstancesCommandInput["BlockDeviceMappings"]> = [{
    DeviceName: allocation.image.rootDeviceName,
    Ebs: { ...ebsShape(configuration.rootVolume), DeleteOnTermination: true },
  }];
  if (configuration.attachedVolume.mode === "create-per-run")
    blockDeviceMappings.push({ DeviceName: configuration.attachedVolume.deviceName, Ebs: { ...ebsShape(configuration.attachedVolume), ...(configuration.attachedVolume.snapshotId === null ? {} : { SnapshotId: configuration.attachedVolume.snapshotId }), DeleteOnTermination: configuration.attachedVolume.deleteOnRetire } });
  const userData = awsCloudInitProgram(configuration, carriagePrefix).replace("__ARCHIVE_SHA256__", context.definition.content.archiveSha256);
  return {
    ImageId: configuration.machine.imageId,
    InstanceType: configuration.machine.instanceType as any,
    MinCount: 1,
    MaxCount: 1,
    ClientToken: clientToken,
    HibernationOptions: { Configured: true },
    NetworkInterfaces: [{ DeviceIndex: 0, DeleteOnTermination: true, SubnetId: configuration.machine.subnetId, Groups: configuration.machine.securityGroupIds, AssociatePublicIpAddress: configuration.machine.associatePublicIpv4Address }],
    IamInstanceProfile: { Arn: configuration.machine.instanceProfileArn },
    ...(configuration.machine.keyName === null ? {} : { KeyName: configuration.machine.keyName }),
    Placement: { Tenancy: configuration.machine.tenancy },
    CapacityReservationSpecification: { CapacityReservationPreference: configuration.machine.capacityReservationPreference },
    ...(configuration.machine.cpuCredits.mode === "not-applicable" ? {} : { CreditSpecification: { CpuCredits: configuration.machine.cpuCredits.mode } }),
    EbsOptimized: configuration.machine.ebsOptimized,
    MetadataOptions: { HttpEndpoint: "enabled", HttpTokens: "required", HttpPutResponseHopLimit: configuration.machine.metadata.httpPutResponseHopLimit },
    DisableApiStop: false,
    DisableApiTermination: false,
    InstanceInitiatedShutdownBehavior: "terminate",
    BlockDeviceMappings: blockDeviceMappings,
    UserData: Buffer.from(userData).toString("base64"),
    TagSpecifications: [
      { ResourceType: "instance", Tags: tags },
      { ResourceType: "volume", Tags: tags },
    ],
  };
}

export function cloudInitUserData(
  configuration: AwsEc2Configuration,
  runPrefix: string,
  archiveSha256: string,
): string {
  return Buffer.from(
    awsCloudInitProgram(configuration, runPrefix).replace(
      "__ARCHIVE_SHA256__",
      archiveSha256,
    ),
  ).toString("base64");
}

function exactInstance(instance: any, input: RunInstancesCommandInput, allocation: AwsEc2AllocationState) {
  const tags = Object.fromEntries((instance?.Tags ?? []).map((tag: any) => [tag.Key, tag.Value]));
  const expectedTags = Object.fromEntries((input.TagSpecifications?.find((item) => item.ResourceType === "instance")?.Tags ?? []).map((tag) => [tag.Key, tag.Value]));
  return instance && instance.ImageId === input.ImageId && instance.InstanceType === input.InstanceType && instance.SubnetId === allocation.network.subnetId && instance.IamInstanceProfile?.Arn === allocation.instanceProfileArn && instance.HibernationOptions?.Configured === true && protectedTagKeys.every((key) => tags[key] === expectedTags[key]);
}

export function createLaunch(dependencies: AwsEc2Dependencies) {
  return async (context: Context): Promise<TaskEnactmentAccount<AwsEc2AllocationState, AwsEc2RunState>> => {
    const base = { version: 1 as const, actIdentity: context.actIdentity, runId: context.runId, allocationState: context.allocationState, runState: context.runState, providerTestimony: { kind: "silent" as const }, environmentStatus: context.environmentStatus, retention: null };
    if (!context.allocationState)
      return { ...base, outcome: taskProviderRefusal("ec2-allocation-state-required", null) };
    try {
      const runner = selectRunner(context.configuration.machine.architecture, context.runners);
      const carriage = context.runState?.carriage ?? await stageAwsDelivery({ s3: dependencies.s3, carriage: context.configuration.statusCarriage, runId: context.runId, configuration: context.configuration, definition: context.definition, inputDocument: context.inputDocument, runner, guestProgram: awsGuestCarriageProgram(context.configuration), fetchContent: dependencies.fetchContent });
      const input = buildRunInstancesInput(context, carriage.runPrefix);
      let output: any;
      try {
        output = await dependencies.ec2.send(new RunInstancesCommand(input));
      } catch (firstError) {
        const classified = classifyAwsError("RunInstances", "mutation", firstError);
        if (classified.kind !== "lost-answer") return { ...base, outcome: classified };
        try {
          output = await dependencies.ec2.send(new RunInstancesCommand(input));
        } catch (secondError) {
          const second = classifyAwsError("RunInstances", "mutation", secondError);
          if (second.kind === "refusal") return { ...base, outcome: second };
          const recovered = await dependencies.ec2.send(new DescribeInstancesCommand({ Filters: [{ Name: "client-token", Values: [input.ClientToken!] }, ...protectedTagKeys.map((key) => ({ Name: `tag:${key}`, Values: [(input.TagSpecifications?.[0]?.Tags ?? []).find((tag) => tag.Key === key)?.Value!] }))] }));
          const instances = (recovered.Reservations ?? []).flatMap((reservation: any) => reservation.Instances ?? []);
          if (instances.length === 0) return { ...base, outcome: taskProviderLostAnswer("RunInstances", { clientToken: input.ClientToken! }) };
          if (instances.length !== 1 || !exactInstance(instances[0], input, context.allocationState))
        return { ...base, providerTestimony: { kind: "witnessed", standing: "conflict", observedAt: dependencies.now().toISOString(), native: awsNativeJSON(recovered) }, outcome: taskProviderRefusal("ec2-launch-identity-conflict", null) };
          output = { Instances: instances };
        }
      }
      const instanceId = output.Instances?.[0]?.InstanceId;
      if (!instanceId) return { ...base, outcome: taskProviderLostAnswer("RunInstances", null) };
      let described = await dependencies.ec2.send(new DescribeInstancesCommand({ InstanceIds: [instanceId] }));
      let instance = described.Reservations?.[0]?.Instances?.[0];
      if (!exactInstance(instance, input, context.allocationState))
        return { ...base, providerTestimony: { kind: "witnessed", standing: "conflict", observedAt: dependencies.now().toISOString(), native: awsNativeJSON(described) }, outcome: taskProviderRefusal("ec2-launch-identity-conflict", null) };
      const rootVolumeId = instance.BlockDeviceMappings?.find((mapping: any) => mapping.DeviceName === context.allocationState!.image.rootDeviceName)?.Ebs?.VolumeId;
      if (!rootVolumeId) return { ...base, outcome: taskProviderLostAnswer("DescribeInstances", null) };
      let attachedVolumeId: string | null = null;
      let ownership: AwsEc2RunState["attachedVolumeOwnership"] = "none";
      if (context.configuration.attachedVolume.mode === "existing") {
        const existingVolume = context.configuration.attachedVolume;
        const volumeId = existingVolume.volumeId;
        attachedVolumeId = volumeId;
        ownership = "external";
        await dependencies.ec2.send(new AttachVolumeCommand({ InstanceId: instanceId, VolumeId: volumeId, Device: existingVolume.deviceName }));
      } else if (context.configuration.attachedVolume.mode === "create-per-run") {
        const createdVolume = context.configuration.attachedVolume;
        attachedVolumeId = instance.BlockDeviceMappings?.find((mapping: any) => mapping.DeviceName === createdVolume.deviceName)?.Ebs?.VolumeId ?? null;
        ownership = "run";
      }
      described = await dependencies.ec2.send(new DescribeInstancesCommand({ InstanceIds: [instanceId] }));
      instance = described.Reservations?.[0]?.Instances?.[0];
      if (attachedVolumeId && !instance?.BlockDeviceMappings?.some((mapping: any) => mapping.Ebs?.VolumeId === attachedVolumeId))
        return { ...base, outcome: taskProviderRefusal("ec2-attached-volume-association-conflict", awsNativeJSON(described)) };
      const association = { runDigest: sha256(context.runId), configurationDigest: context.allocationState.configurationDigest, archiveSha256: context.definition.content.archiveSha256, treeSha256: context.definition.content.treeSha256, runnerSha256: runner.sha256 };
      await putAwsObjectImmutable(dependencies.s3, { bucket: carriage.bucket, runPrefix: carriage.runPrefix, maximumObjectBytes: context.configuration.statusCarriage.maximumObjectBytes }, "launch-ready.json", new TextEncoder().encode(canonical({ instanceId, rootVolumeId, attachedVolumeId })), association);
      const state = String(instance?.State?.Name ?? "pending") as AwsEc2RunState["lastProviderState"];
      const runState: AwsEc2RunState = { version: 1, configurationDigest: context.allocationState.configurationDigest, clientToken: input.ClientToken!, instanceId, rootVolumeId, attachedVolumeId, attachedVolumeOwnership: ownership, carriage, launchAssociationDigest: sha256(canonical({ instanceId, rootVolumeId, attachedVolumeId, clientToken: input.ClientToken })), lastProviderState: state, pauseWitnessedAt: null, commandSequence: 0 };
      return { ...base, runState, providerTestimony: { kind: "witnessed", standing: state === "running" ? "live" : "pending", observedAt: dependencies.now().toISOString(), native: awsNativeJSON(described) }, outcome: { kind: "witnessed" } };
    } catch (error) {
      if (typeof error === "object" && error !== null && "kind" in error) return { ...base, outcome: error as any };
      return { ...base, outcome: classifyAwsError("Launch", "mutation", error) };
    }
  };
}
