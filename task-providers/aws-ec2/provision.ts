import {
  DescribeImagesCommand,
  DescribeInstanceTypesCommand,
  DescribeSecurityGroupsCommand,
  DescribeSubnetsCommand,
  DescribeVolumesCommand,
} from "@aws-sdk/client-ec2";
import { GetInstanceProfileCommand } from "@aws-sdk/client-iam";
import {
  taskProviderRefusal,
  type TaskEnactmentAccount,
  type TaskRealizationContext,
} from "@sdlcworks/components/task";
import { awsConfigurationDigest, awsNativeJSON, classifyAwsError } from "../aws-common";
import type { AwsEc2Dependencies } from "./index";
import type {
  AwsEc2AllocationState,
  AwsEc2Configuration,
  AwsEc2Credentials,
  AwsEc2RunState,
} from "./schemas";

type Context = TaskRealizationContext<AwsEc2Configuration, AwsEc2Credentials, AwsEc2AllocationState, AwsEc2RunState>;

export function createProvisionAllocations(dependencies: AwsEc2Dependencies) {
  return async (context: Context): Promise<TaskEnactmentAccount<AwsEc2AllocationState, AwsEc2RunState>> => {
    const base = {
      version: 1 as const,
      actIdentity: context.actIdentity,
      runId: context.runId,
      allocationState: context.allocationState,
      runState: context.runState,
      providerTestimony: { kind: "silent" as const },
      environmentStatus: context.environmentStatus,
      retention: null,
    };
    try {
      const configuration = context.configuration;
      if (!configuration.rootVolume.encrypted)
        return { ...base, outcome: taskProviderRefusal("ec2-hibernation-root-encryption-required", null) };
      const [images, types, subnets, groups, profile] = await Promise.all([
        dependencies.ec2.send(new DescribeImagesCommand({ ImageIds: [configuration.machine.imageId], Owners: [configuration.machine.imageOwnerId] })),
        dependencies.ec2.send(new DescribeInstanceTypesCommand({ InstanceTypes: [configuration.machine.instanceType as any] })),
        dependencies.ec2.send(new DescribeSubnetsCommand({ SubnetIds: [configuration.machine.subnetId] })),
        dependencies.ec2.send(new DescribeSecurityGroupsCommand({ GroupIds: configuration.machine.securityGroupIds })),
        dependencies.iam.send(new GetInstanceProfileCommand({ InstanceProfileName: configuration.machine.instanceProfileArn.split("/").slice(-1)[0]! })),
      ]);
      const image = images.Images?.[0];
      const instanceType = types.InstanceTypes?.[0];
      const subnet = subnets.Subnets?.[0];
      const securityGroups = groups.SecurityGroups ?? [];
      if (!image || images.Images?.length !== 1 || image.State !== "available" || image.ImageType !== "machine" || image.VirtualizationType !== "hvm" || image.RootDeviceType !== "ebs" || image.Architecture !== configuration.machine.architecture || image.OwnerId !== configuration.machine.imageOwnerId)
        return { ...base, outcome: taskProviderRefusal("ec2-image-not-qualified", awsNativeJSON(images)) };
      const rootMappings = (image.BlockDeviceMappings ?? []).filter((mapping: any) => mapping.DeviceName === image.RootDeviceName && mapping.Ebs);
      if (rootMappings.length !== 1)
        return { ...base, outcome: taskProviderRefusal("ec2-image-root-mapping-not-unique", awsNativeJSON(images)) };
      if (!instanceType || !instanceType.ProcessorInfo?.SupportedArchitectures?.includes(configuration.machine.architecture) || instanceType.HibernationSupported !== true)
        return { ...base, outcome: taskProviderRefusal("ec2-instance-type-not-hibernation-qualified", awsNativeJSON(types)) };
      const vcpus = instanceType.VCpuInfo?.DefaultVCpus;
      const memoryMiB = instanceType.MemoryInfo?.SizeInMiB;
      if (!vcpus || !memoryMiB || !subnet?.VpcId || !subnet.AvailabilityZone)
        return { ...base, outcome: taskProviderRefusal("ec2-allocation-facts-incomplete", null) };
      if (securityGroups.length !== configuration.machine.securityGroupIds.length || securityGroups.some((group: any) => group.VpcId !== subnet.VpcId))
        return { ...base, outcome: taskProviderRefusal("ec2-network-vpc-mismatch", awsNativeJSON(groups)) };
      if (profile.InstanceProfile?.Arn !== configuration.machine.instanceProfileArn)
        return { ...base, outcome: taskProviderRefusal("ec2-instance-profile-mismatch", awsNativeJSON(profile)) };
      const burstCreditsSupported = instanceType.BurstablePerformanceSupported === true;
      if ((burstCreditsSupported && configuration.machine.cpuCredits.mode === "not-applicable") || (!burstCreditsSupported && configuration.machine.cpuCredits.mode !== "not-applicable"))
        return { ...base, outcome: taskProviderRefusal("ec2-cpu-credit-mode-mismatch", awsNativeJSON(types)) };
      const workspaceGiB = configuration.rootVolume.sizeGiB - Math.ceil(memoryMiB / 1024);
      if (workspaceGiB < 0)
        return { ...base, outcome: taskProviderRefusal("ec2-hibernation-root-volume-too-small", null) };
      let existingVolume: AwsEc2AllocationState["existingVolume"] = null;
      let volumeNative: any = null;
      if (configuration.attachedVolume.mode === "existing") {
        volumeNative = await dependencies.ec2.send(new DescribeVolumesCommand({ VolumeIds: [configuration.attachedVolume.volumeId] }));
        const volume = volumeNative.Volumes?.[0];
        if (!volume || volume.AvailabilityZone !== subnet.AvailabilityZone)
          return { ...base, outcome: taskProviderRefusal("ec2-existing-volume-availability-zone-mismatch", awsNativeJSON(volumeNative)) };
        if (volume.State !== "available" || (volume.Attachments?.length ?? 0) !== 0)
          return { ...base, outcome: taskProviderRefusal("ec2-existing-volume-not-exclusive", awsNativeJSON(volumeNative)) };
        existingVolume = { volumeId: volume.VolumeId!, availabilityZone: volume.AvailabilityZone!, state: "available" };
      }
      const allocationState: AwsEc2AllocationState = {
        version: 1,
        configurationDigest: awsConfigurationDigest(configuration),
        image: { id: image.ImageId!, ownerId: image.OwnerId!, rootDeviceName: image.RootDeviceName!, architecture: configuration.machine.architecture },
        instanceType: { name: configuration.machine.instanceType, vcpus, memoryMiB, hibernationSupported: true, burstCreditsSupported },
        network: { subnetId: subnet.SubnetId!, vpcId: subnet.VpcId, availabilityZone: subnet.AvailabilityZone, securityGroupIds: configuration.machine.securityGroupIds, securityGroupVpcId: subnet.VpcId },
        instanceProfileArn: configuration.machine.instanceProfileArn,
        existingVolume,
        qualifiedConstraints: { os: "linux", architecture: configuration.machine.architecture, vcpus, memoryMiB, workspaceGiB, attachedVolume: configuration.attachedVolume.mode !== "none", gpu: false },
      };
      return {
        ...base,
        allocationState,
        providerTestimony: { kind: "witnessed", standing: "live", observedAt: dependencies.now().toISOString(), native: JSON.parse(JSON.stringify({ images, types, subnets, groups, profile, volume: volumeNative })) },
        outcome: { kind: "witnessed" },
      };
    } catch (error) {
      return { ...base, outcome: classifyAwsError("ProvisionAllocations", "read", error) };
    }
  };
}
