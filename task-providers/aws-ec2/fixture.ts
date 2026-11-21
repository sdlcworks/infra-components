import type { AwsObjectAssociation } from "../aws-common";
import type {
  ProviderScenarioDescriptor,
  ScenarioBinding,
  ScenarioDemand,
} from "../scenario";
import type { TaskProviderAct } from "@sdlcworks/components/task";
import { canonical, sha256 } from "../aws-common";
import { awsEc2ScenarioTaskContent } from "./scenario-task-content";
import { awsGuestCarriageProgram } from "./guest";
import type { AwsEc2Configuration } from "./schemas";

type RecordedCommand = { name: string; input: unknown };

export class AwsCommandRecorder {
  readonly commands: RecordedCommand[] = [];
  readonly objects = new Map<string, { bytes: Uint8Array; metadata: Record<string, string> }>();
  scenario: "success" | "denial" | "lost" | "association-conflict" = "success";

  readonly send = async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
    const name = command.constructor.name;
    this.commands.push({ name, input: command.input });
    if (this.scenario === "denial") throw Object.assign(new Error("denied"), { name: "AccessDenied" });
    if (this.scenario === "lost") throw Object.assign(new Error("timeout"), { name: "TimeoutError" });
    const bucket = String(command.input.Bucket ?? "");
    const key = String(command.input.Key ?? "");
    const identity = `${bucket}/${key}`;
    if (name === "PutObjectCommand") {
      if (this.objects.has(identity))
        throw Object.assign(new Error("exists"), { name: "PreconditionFailed" });
      this.objects.set(identity, {
        bytes: new Uint8Array(command.input.Body as Uint8Array),
        metadata: command.input.Metadata as Record<string, string>,
      });
      return {};
    }
    if (name === "GetObjectCommand") {
      const value = this.objects.get(identity);
      if (!value) throw Object.assign(new Error("missing"), { name: "NoSuchKey" });
      return {
        Body: value.bytes,
        Metadata:
          this.scenario === "association-conflict"
            ? { ...value.metadata, "run-digest": "0".repeat(64) }
            : value.metadata,
      };
    }
    if (name === "ListObjectsV2Command") {
      const prefix = `${bucket}/${String(command.input.Prefix ?? "")}`;
      return {
        Contents: Array.from(this.objects.keys())
          .filter((item) => item.startsWith(prefix))
          .map((item) => ({ Key: item.slice(bucket.length + 1) })),
      };
    }
    return {};
  };
}

export const awsScenario = {
  success: () => new AwsCommandRecorder(),
  denial: () => Object.assign(new AwsCommandRecorder(), { scenario: "denial" as const }),
  lostMutationResponse: () => Object.assign(new AwsCommandRecorder(), { scenario: "lost" as const }),
  preconditionReplay: () => new AwsCommandRecorder(),
  associationConflict: () =>
    Object.assign(new AwsCommandRecorder(), { scenario: "association-conflict" as const }),
};

export function fixtureAssociation(): AwsObjectAssociation {
  return {
    runDigest: "1".repeat(64),
    configurationDigest: "2".repeat(64),
    archiveSha256: "3".repeat(64),
    treeSha256: "4".repeat(64),
    runnerSha256: "5".repeat(64),
  };
}

export function validAwsEc2Configuration(
  attachedVolume: AwsEc2Configuration["attachedVolume"] = { mode: "none" },
): AwsEc2Configuration {
  return {
    region: "us-east-1",
    client: {
      endpoint: { mode: "aws-standard" },
      s3AddressingStyle: "virtual-hosted",
      connectionTimeoutMilliseconds: 1000,
      requestTimeoutMilliseconds: 5000,
      maximumAttempts: 2,
    },
    statusCarriage: {
      bucket: "task-evidence",
      prefix: "task-runs",
      maximumObjectBytes: 16_777_216,
      retention: "retain",
    },
    machine: {
      imageId: "ami-0123456789abcdef0",
      imageOwnerId: "123456789012",
      architecture: "x86_64",
      instanceType: "m6i.large",
      subnetId: "subnet-0123456789abcdef0",
      securityGroupIds: ["sg-0123456789abcdef0"],
      instanceProfileArn: "arn:aws:iam::123456789012:instance-profile/task",
      keyName: null,
      purchaseModel: "on-demand",
      tenancy: "default",
      capacityReservationPreference: "none",
      cpuCredits: { mode: "not-applicable" },
      ebsOptimized: true,
      associatePublicIpv4Address: false,
      metadata: {
        httpEndpoint: "enabled",
        httpTokens: "required",
        httpPutResponseHopLimit: 1,
      },
    },
    rootVolume: {
      volumeType: "gp3",
      sizeGiB: 32,
      iops: null,
      throughputMiBps: null,
      encrypted: true,
      kmsKeyId: null,
      deleteOnTermination: true,
    },
    attachedVolume,
    lifecycle: {
      pauseMode: "hibernate",
      pausedRetentionSeconds: 3600,
      cancelGraceMilliseconds: 10000,
      providerPollMilliseconds: 100,
    },
    guest: {
      shellPath: "/bin/bash",
      nodePath: "/usr/bin/node",
      awsCliPath: "/usr/bin/aws",
      tarPath: "/usr/bin/tar",
      workspaceRoot: "/var/lib/sdlc-task",
      pathDirectories: ["/usr/bin", "/bin"],
    },
  };
}

export const attachedVolumeFixtures: AwsEc2Configuration["attachedVolume"][] = [
  { mode: "none" },
  {
    mode: "create-per-run",
    deviceName: "/dev/sdf",
    volumeType: "gp3",
    sizeGiB: 20,
    iops: null,
    throughputMiBps: null,
    encrypted: true,
    kmsKeyId: null,
    snapshotId: null,
    deleteOnRetire: true,
  },
  {
    mode: "existing",
    volumeId: "vol-0123456789abcdef0",
    deviceName: "/dev/sdf",
    attachment: "exclusive",
    deleteOnRetire: false,
  },
];

export async function runLaunchFixtureChecks(): Promise<void> {
  const { buildRunInstancesInput } = await import("./launch");
  const configuration = validAwsEc2Configuration();
  const context = {
    runId: "fixture-run",
    definition: { content: { archiveSha256: "a".repeat(64), treeSha256: "b".repeat(64) } },
    configuration,
    allocationState: {
      configurationDigest: "c".repeat(64),
      image: { rootDeviceName: "/dev/sda1" },
      network: { subnetId: configuration.machine.subnetId },
      instanceProfileArn: configuration.machine.instanceProfileArn,
    },
  } as any;
  const first = buildRunInstancesInput(context, "prefix");
  const replay = buildRunInstancesInput(context, "prefix");
  if (JSON.stringify(first) !== JSON.stringify(replay)) throw new Error("launch-not-deterministic");
  if (first.MinCount !== 1 || first.MaxCount !== 1 || first.HibernationOptions?.Configured !== true)
    throw new Error("launch-shape");
  if (JSON.stringify(first).includes("secretAccessKey")) throw new Error("credential-leak");
  for (const attachedVolume of attachedVolumeFixtures) {
    context.configuration = validAwsEc2Configuration(attachedVolume);
    const input = buildRunInstancesInput(context, "prefix");
    const expected = attachedVolume.mode === "create-per-run" ? 2 : 1;
    if (input.BlockDeviceMappings?.length !== expected) throw new Error("volume-mapping");
  }
}

export async function runLifecycleFixtureChecks(): Promise<void> {
  const states = ["pending", "running", "stopping", "stopped", "shutting-down", "terminated", "missing"];
  const expected = ["pending", "live", "terminal", "paused", "terminal", "gone", "gone"];
  const map = (state: string, paused: boolean) => {
    if (state === "pending") return "pending";
    if (state === "running") return "live";
    if (state === "stopped") return paused ? "paused" : "conflict";
    if (state === "stopping" || state === "shutting-down") return "terminal";
    if (state === "terminated" || state === "missing") return "gone";
    return "conflict";
  };
  states.forEach((state, index) => {
    if (map(state, state === "stopped") !== expected[index]) throw new Error(`state-map:${state}`);
  });
  const credentials = { kind: "static", accessKeyId: "fixture-access", secretAccessKey: "fixture-secret", sessionToken: "fixture-session" };
  const serialized = JSON.stringify({ configuration: validAwsEc2Configuration(), states, ownership: ["none", "run", "external"] });
  for (const scalar of [credentials.accessKeyId, credentials.secretAccessKey, credentials.sessionToken])
    if (serialized.includes(scalar)) throw new Error("credential-leak");
}

export const awsEc2SchemaCases = [
  { name: "schema-unknown-field", category: "schema-refusal", expected: "refusal" },
  { name: "schema-missing-instance-type", category: "schema-refusal", expected: "refusal" },
  { name: "schema-gp2-iops", category: "schema-refusal", expected: "refusal" },
  { name: "schema-io1-missing-iops", category: "schema-refusal", expected: "refusal" },
  { name: "schema-kms-without-encryption", category: "schema-refusal", expected: "refusal" },
] as const;

const artifact = (name: string): ScenarioBinding => ({
  $scenario: { source: "artifact", name, step: null, path: [] },
});
const world = (name: string): ScenarioBinding => ({
  $scenario: { source: "world", name, step: null, path: [] },
});
const priorAccount = (step: string, path: string[]): ScenarioBinding => ({
  $scenario: { source: "account", name: "account", step, path },
});

const credentials = {
  kind: "static",
  accessKeyId: "scenario-access-key",
  secretAccessKey: "scenario-secret-key",
  sessionToken: null,
} as const;
const forbiddenAccountScalars = [
  "scenario-access-key",
  "scenario-secret-key",
  "scenario-session-token",
];
const silentEnvironment = {
  deliveryClaimed: null,
  entryStarted: null,
  entryExited: null,
  commandAcknowledgements: [],
};
const observedAt = {
  $expect: {
    kind: "iso-8601",
    anchor: "step-start",
    offsetSeconds: 0,
    toleranceMilliseconds: 30_000,
  },
} as const;
const awsDate = {
  $expect: {
    kind: "aws-amz-date",
    anchor: "step-start",
    offsetSeconds: 0,
    toleranceMilliseconds: 30_000,
  },
} as const;

function scenarioConfiguration(
  attachedVolume: AwsEc2Configuration["attachedVolume"] = { mode: "none" },
  rootEncrypted = true,
): AwsEc2Configuration {
  const configuration = validAwsEc2Configuration(attachedVolume);
  return {
    ...configuration,
    client: {
      ...configuration.client,
      endpoint: { mode: "custom", url: world("aws-http-root") },
      s3AddressingStyle: "path",
    },
    rootVolume: { ...configuration.rootVolume, encrypted: rootEncrypted },
  } as unknown as AwsEc2Configuration;
}

function demand(
  id: string,
  step: string,
  act: TaskProviderAct,
  configuration: AwsEc2Configuration | ScenarioBinding,
  previousStep: string | null,
): ScenarioDemand {
  return {
    version: 1,
    actIdentity: `${id}-${step}`,
    act,
    runId: `scenario-${id}`,
    definition: {
      address: { bundleIdentity: "scenario-bundle", member: "scenario-task" },
      content: {
        uri: artifact("task-content-uri"),
        archiveSha256: awsEc2ScenarioTaskContent.archiveSha256,
        treeSha256: awsEc2ScenarioTaskContent.treeSha256,
      },
      entry: { flakeSelector: awsEc2ScenarioTaskContent.entry },
      schemas: {
        input: { type: "object", additionalProperties: true },
        output: { type: "object", additionalProperties: true },
      },
      meta: {
        timeout: { mode: "absent" },
        computeConstraints: {
          os: "linux",
          architecture: "x86_64",
          minimumVcpus: 2,
          minimumMemoryMiB: 4096,
          minimumWorkspaceGiB: 16,
          attachedVolume: "either",
          gpu: false,
        },
        confidentialInputPaths: [],
      },
    },
    realization: artifact("built-realization"),
    inputDocument: { scenario: id },
    configuration,
    credentials,
    allocationState:
      previousStep === null ? null : priorAccount(previousStep, ["allocationState"]),
    runState: previousStep === null ? null : priorAccount(previousStep, ["runState"]),
    environmentStatus:
      previousStep === null
        ? silentEnvironment
        : priorAccount(previousStep, ["environmentStatus"]),
    runners: {
      linuxAmd64: {
        path: artifact("linux-amd64-runner-path"),
        sha256: artifact("linux-amd64-runner-sha256"),
      },
      linuxArm64: {
        path: artifact("linux-arm64-runner-path"),
        sha256: artifact("linux-arm64-runner-sha256"),
      },
      maximumOutputBytes: 1_048_576,
    },
  } as unknown as ScenarioDemand;
}

function expectedAccount(
  id: string,
  step: string,
  act: TaskProviderAct,
  outcome: string,
  configuration: AwsEc2Configuration | ScenarioBinding,
  previousStep: string | null,
) {
  const refusal = outcome.startsWith("refusal:");
  const lost = outcome.startsWith("lost-answer:");
  const expectedConfiguration = configuration as AwsEc2Configuration;
  const digestConfiguration = {
    ...expectedConfiguration,
    client: {
      ...expectedConfiguration.client,
      endpoint: expectedConfiguration.client.endpoint.mode === "custom"
        ? {
            mode: "custom",
            url: { $resolve: world("aws-http-root") },
          }
        : expectedConfiguration.client.endpoint,
    },
  };
  const configurationDigest = {
    $expect: {
      kind: "derived",
      name: "aws-configuration-digest",
      inputs: {
        configuration: { kind: "literal", value: digestConfiguration as any },
      },
    },
  } as const;
  const runDigest = {
    kind: "literal",
    value: "scenario-run-digest",
  } as const;
  const runPrefix = {
    $expect: {
      kind: "derived",
      name: "aws-run-prefix",
      inputs: {
        carriage: {
          kind: "literal",
          value: expectedConfiguration.statusCarriage as any,
        },
        configurationDigest: {
          kind: "account",
          step: "01-provision-allocations",
          path: "allocationState.configurationDigest",
        },
        runDigest,
      },
    },
  } as const;
  const deliverySha256 = {
    $expect: {
      kind: "derived",
      name: "aws-delivery-sha256",
      inputs: {
        delivery: { kind: "binding", binding: artifact("task-content-uri") },
      },
    },
  } as const;
  return {
    version: 1,
    actIdentity: `${id}-${step}`,
    runId: `scenario-${id}`,
    allocationState:
      act === "provision-allocations" && !refusal && !lost
        ? { version: 1, configurationDigest }
        : previousStep === null
          ? null
          : { $expect: { kind: "binding", binding: priorAccount(previousStep, ["allocationState"]) } },
    runState:
      act === "launch" && !refusal && !lost
        ? {
            version: 1,
            configurationDigest,
            carriage: { runPrefix, deliverySha256 },
          }
        : previousStep === null
          ? null
          : { $expect: { kind: "binding", binding: priorAccount(previousStep, ["runState"]) } },
    providerTestimony: { kind: "silent" },
    environmentStatus:
      previousStep === null
        ? silentEnvironment
        : { $expect: { kind: "binding", binding: priorAccount(previousStep, ["environmentStatus"]) } },
    retention: null,
    outcome: refusal
      ? { kind: "refusal", name: outcome.slice("refusal:".length), detail: null }
      : lost
        ? { kind: "lost-answer", operation: outcome.slice("lost-answer:".length), detail: null }
        : { kind: "witnessed" },
  } as const;
}

type ActSpec = {
  act: TaskProviderAct;
  trace: string;
  outcome?: string;
};

function descriptor(
  id: string,
  traces: string[],
  acts: ActSpec[],
  configuration: AwsEc2Configuration | ScenarioBinding = scenarioConfiguration(),
): ProviderScenarioDescriptor {
  let previousStep: string | null = null;
  return {
    version: 1,
    id,
    providerMember: "aws-ec2",
    traces: [...traces, "credential-redaction"],
    forbiddenAccountScalars: [...forbiddenAccountScalars],
    taskContent: awsEc2ScenarioTaskContent,
    world: {
      kind: "aws-http",
      initialState: { ec2: {}, iam: {}, s3: {} },
      script: [],
    },
    acts: acts.map(({ act, outcome = "witnessed" }, index) => {
      const step = `${String(index + 1).padStart(2, "0")}-${act}`;
      const value = {
        step,
        demand: demand(id, step, act, configuration, previousStep),
        expectedAccount: expectedAccount(
          id,
          step,
          act,
          outcome,
          configuration,
          previousStep,
        ),
        expectedWorld: { requests: [], effects: {}, environmentCount: 0 },
      };
      previousStep = step;
      return value;
    }),
  } as unknown as ProviderScenarioDescriptor;
}

const image = {
  ImageId: "ami-0123456789abcdef0",
  OwnerId: "123456789012",
  State: "available",
  ImageType: "machine",
  VirtualizationType: "hvm",
  RootDeviceType: "ebs",
  RootDeviceName: "/dev/sda1",
  Architecture: "x86_64",
  BlockDeviceMappings: [{ DeviceName: "/dev/sda1", Ebs: { SnapshotId: "snap-root" } }],
};
const instanceType = {
  InstanceType: "m6i.large",
  ProcessorInfo: { SupportedArchitectures: ["x86_64"] },
  HibernationSupported: true,
  VCpuInfo: { DefaultVCpus: 2 },
  MemoryInfo: { SizeInMiB: 8192 },
  BurstablePerformanceSupported: false,
};
const subnet = {
  SubnetId: "subnet-0123456789abcdef0",
  VpcId: "vpc-scenario",
  AvailabilityZone: "us-east-1a",
};
const groups = {
  SecurityGroups: [{
    GroupId: "sg-0123456789abcdef0",
    VpcId: "vpc-scenario",
    GroupName: "scenario",
    Description: "scenario",
  }],
};
const profile = {
  InstanceProfile: {
    Arn: "arn:aws:iam::123456789012:instance-profile/task",
    InstanceProfileName: "task",
    Path: "/",
    InstanceProfileId: "AIPASCENARIO",
    CreateDate: "2026-01-01T00:00:00.000Z",
    Roles: [],
  },
};
const existingVolumeInUse = {
  Volumes: [{
    VolumeId: "vol-0123456789abcdef0",
    AvailabilityZone: "us-east-1a",
    State: "in-use",
    Attachments: [{ InstanceId: "i-other", Device: "/dev/sdf", State: "attached" }],
  }],
};
const responseMetadata = { httpStatusCode: 200, attempts: 1, totalRetryDelay: 0 };

function xml(body: unknown) {
  return document({
    kind: "success" as const,
    status: 200,
    headers: { "content-type": "text/xml" },
    body,
  });
}

const imageXml = `<DescribeImagesResponse xmlns="http://ec2.amazonaws.com/doc/2016-11-15/"><requestId>request-images</requestId><imagesSet><item><imageId>${image.ImageId}</imageId><imageOwnerId>${image.OwnerId}</imageOwnerId><imageState>available</imageState><imageType>machine</imageType><virtualizationType>hvm</virtualizationType><rootDeviceType>ebs</rootDeviceType><rootDeviceName>/dev/sda1</rootDeviceName><architecture>x86_64</architecture><blockDeviceMapping><item><deviceName>/dev/sda1</deviceName><ebs><snapshotId>snap-root</snapshotId></ebs></item></blockDeviceMapping></item></imagesSet></DescribeImagesResponse>`;
const instanceTypeXml = (hibernation: boolean) => `<DescribeInstanceTypesResponse xmlns="http://ec2.amazonaws.com/doc/2016-11-15/"><requestId>request-types</requestId><instanceTypeSet><item><instanceType>m6i.large</instanceType><processorInfo><supportedArchitectures><item>x86_64</item></supportedArchitectures></processorInfo><hibernationSupported>${hibernation}</hibernationSupported><vCpuInfo><defaultVCpus>2</defaultVCpus></vCpuInfo><memoryInfo><sizeInMiB>8192</sizeInMiB></memoryInfo><burstablePerformanceSupported>false</burstablePerformanceSupported></item></instanceTypeSet></DescribeInstanceTypesResponse>`;
const subnetXml = `<DescribeSubnetsResponse xmlns="http://ec2.amazonaws.com/doc/2016-11-15/"><requestId>request-subnets</requestId><subnetSet><item><subnetId>${subnet.SubnetId}</subnetId><vpcId>${subnet.VpcId}</vpcId><availabilityZone>${subnet.AvailabilityZone}</availabilityZone></item></subnetSet></DescribeSubnetsResponse>`;
const groupsXml = `<DescribeSecurityGroupsResponse xmlns="http://ec2.amazonaws.com/doc/2016-11-15/"><requestId>request-groups</requestId><securityGroupInfo><item><groupId>sg-0123456789abcdef0</groupId><groupName>scenario</groupName><groupDescription>scenario</groupDescription><vpcId>${subnet.VpcId}</vpcId></item></securityGroupInfo></DescribeSecurityGroupsResponse>`;
const profileXml = `<GetInstanceProfileResponse xmlns="https://iam.amazonaws.com/doc/2010-05-08/"><GetInstanceProfileResult><InstanceProfile><Path>/</Path><InstanceProfileName>task</InstanceProfileName><InstanceProfileId>AIPASCENARIO</InstanceProfileId><Arn>${profile.InstanceProfile.Arn}</Arn><CreateDate>2026-01-01T00:00:00Z</CreateDate><Roles></Roles></InstanceProfile></GetInstanceProfileResult><ResponseMetadata><RequestId>request-profile</RequestId></ResponseMetadata></GetInstanceProfileResponse>`;
const volumeXml = (inUse: boolean) => `<DescribeVolumesResponse xmlns="http://ec2.amazonaws.com/doc/2016-11-15/"><requestId>request-volumes</requestId><volumeSet><item><volumeId>vol-0123456789abcdef0</volumeId><availabilityZone>us-east-1a</availabilityZone><status>${inUse ? "in-use" : "available"}</status><attachmentSet>${inUse ? "<item><instanceId>i-other</instanceId><device>/dev/sdf</device><status>attached</status></item>" : ""}</attachmentSet></item></volumeSet></DescribeVolumesResponse>`;

function signedQuery(operation: string, body: Record<string, string>, service = "ec2") {
  return {
    operation,
    method: "POST",
    path: "/",
    query: {},
    body,
    authorization: {
      algorithm: "AWS4-HMAC-SHA256",
      accessKeyId: credentials.accessKeyId,
      date: awsDate,
      region: "us-east-1",
      service,
      signedHeaders: [
        "amz-sdk-invocation-id",
        "amz-sdk-request",
        "content-length",
        "content-type",
        "host",
        "x-amz-content-sha256",
        "x-amz-date",
        "x-amz-user-agent",
      ],
      signaturePresent: true,
    },
    signingDate: awsDate,
    conditional: { ifNoneMatch: null },
    metadata: {},
  };
}

const qualificationRequests = [
  signedQuery("DescribeImages", { Action: "DescribeImages", Version: "2016-11-15", "ImageId.1": image.ImageId, "Owner.1": image.OwnerId }),
  signedQuery("DescribeInstanceTypes", { Action: "DescribeInstanceTypes", Version: "2016-11-15", "InstanceType.1": instanceType.InstanceType }),
  signedQuery("DescribeSubnets", { Action: "DescribeSubnets", Version: "2016-11-15", "SubnetId.1": subnet.SubnetId }),
  signedQuery("DescribeSecurityGroups", { Action: "DescribeSecurityGroups", Version: "2016-11-15", "GroupId.1": "sg-0123456789abcdef0" }),
  signedQuery("GetInstanceProfile", { Action: "GetInstanceProfile", Version: "2010-05-08", InstanceProfileName: "task" }, "iam"),
];

function qualification(
  trace: string,
  mode: "success" | "root-unencrypted" | "hibernation-unsupported" | "existing-volume-in-use",
  configurationOverride?: AwsEc2Configuration | ScenarioBinding,
): ProviderScenarioDescriptor {
  const configuration = configurationOverride ?? scenarioConfiguration(
    mode === "existing-volume-in-use" ? attachedVolumeFixtures[2] : undefined,
    mode !== "root-unencrypted",
  );
  const nativeType = mode === "hibernation-unsupported"
    ? { ...instanceType, HibernationSupported: false }
    : instanceType;
  const nativeVolume = mode === "existing-volume-in-use"
    ? { ...existingVolumeInUse, $metadata: responseMetadata }
    : null;
  const hasExistingVolume = (configuration as AwsEc2Configuration).attachedVolume.mode === "existing";
  const availableVolume = hasExistingVolume
    ? { Volumes: [{ VolumeId: "vol-0123456789abcdef0", AvailabilityZone: "us-east-1a", State: "available", Attachments: [] }], $metadata: responseMetadata }
    : null;
  const script = mode === "root-unencrypted" ? [] : [
    { request: {}, response: xml(imageXml), externalEffect: {} },
    { request: {}, response: xml(instanceTypeXml(nativeType.HibernationSupported)), externalEffect: {} },
    { request: {}, response: xml(subnetXml), externalEffect: {} },
    { request: {}, response: xml(groupsXml), externalEffect: {} },
    { request: {}, response: xml(profileXml), externalEffect: {} },
    ...(mode === "existing-volume-in-use"
      ? [{ request: {}, response: xml(volumeXml(true)), externalEffect: {} }]
      : hasExistingVolume
        ? [{ request: {}, response: xml(volumeXml(false)), externalEffect: {} }]
        : []),
  ];
  const base = descriptor(`ec2-${trace}`, [trace], [{
    act: "provision-allocations",
    trace,
    outcome: mode === "root-unencrypted"
      ? "refusal:ec2-hibernation-root-encryption-required"
      : mode === "hibernation-unsupported"
        ? "refusal:ec2-instance-type-not-hibernation-qualified"
        : mode === "existing-volume-in-use"
          ? "refusal:ec2-existing-volume-not-exclusive"
          : "witnessed",
  }], configuration);
  base.world.script = script;
  const account = base.acts[0]!.expectedAccount;
  if (
    typeof account !== "object" ||
    account === null ||
    !("allocationState" in account) ||
    !("providerTestimony" in account) ||
    !("outcome" in account)
  ) {
    throw new Error("ec2-qualification-account-required");
  }
  if (mode === "success") {
    const allocationState = account.allocationState;
    if (
      typeof allocationState !== "object" ||
      allocationState === null ||
      !("configurationDigest" in allocationState)
    ) {
      throw new Error("ec2-qualification-configuration-digest-required");
    }
    account.allocationState = {
      version: 1,
      configurationDigest: allocationState.configurationDigest,
      image: { id: image.ImageId, ownerId: image.OwnerId, rootDeviceName: image.RootDeviceName, architecture: "x86_64" },
      instanceType: { name: instanceType.InstanceType, vcpus: 2, memoryMiB: 8192, hibernationSupported: true, burstCreditsSupported: false },
      network: { subnetId: subnet.SubnetId, vpcId: subnet.VpcId, availabilityZone: subnet.AvailabilityZone, securityGroupIds: ["sg-0123456789abcdef0"], securityGroupVpcId: subnet.VpcId },
      instanceProfileArn: profile.InstanceProfile.Arn,
      existingVolume: hasExistingVolume ? { volumeId: "vol-0123456789abcdef0", availabilityZone: "us-east-1a", state: "available" } : null,
      qualifiedConstraints: { os: "linux", architecture: "x86_64", vcpus: 2, memoryMiB: 8192, workspaceGiB: 24, attachedVolume: (configuration as AwsEc2Configuration).attachedVolume.mode !== "none", gpu: false },
    };
    account.providerTestimony = {
      kind: "witnessed",
      standing: "live",
      observedAt,
      native: {
        images: { Images: [image], $metadata: responseMetadata },
        types: { InstanceTypes: [instanceType], $metadata: responseMetadata },
        subnets: { Subnets: [subnet], $metadata: responseMetadata },
        groups: { ...groups, $metadata: responseMetadata },
        profile: { ...profile, $metadata: responseMetadata },
        volume: availableVolume,
      },
    };
  } else if (mode !== "root-unencrypted") {
    if (typeof account.outcome !== "object" || account.outcome === null || !("detail" in account.outcome)) {
      throw new Error("ec2-qualification-outcome-required");
    }
    account.outcome.detail = mode === "hibernation-unsupported"
      ? { InstanceTypes: [nativeType], $metadata: responseMetadata }
      : nativeVolume;
  }
  base.acts[0]!.expectedWorld = {
    requests: mode === "root-unencrypted"
      ? []
      : [
          ...qualificationRequests,
          ...(mode === "existing-volume-in-use" || hasExistingVolume
            ? [signedQuery("DescribeVolumes", { Action: "DescribeVolumes", Version: "2016-11-15", "VolumeId.1": "vol-0123456789abcdef0" })]
            : []),
        ],
    effects: { ec2: {}, iam: {}, s3: {} },
    environmentCount: 0,
  };
  return base;
}
const resolve = (value: unknown) => ({ $resolve: value });
const literal = (value: unknown) => ({ kind: "literal", value });
const derived = (name: string, inputs: Record<string, unknown>) => ({ kind: "derived", name, inputs });
const joined = (...parts: unknown[]) => ({ kind: "joined", parts });
const expected = (value: unknown) => ({ $expect: value });
const document = (value: unknown) => JSON.parse(JSON.stringify(value));
const runDigestValue = (id: string) => sha256(`scenario-ec2-${id}`);
const configurationExpectation = (configuration: AwsEc2Configuration | ScenarioBinding) => {
  const value = configuration as AwsEc2Configuration;
  return {
    ...value,
    client: {
      ...value.client,
      endpoint: value.client.endpoint.mode === "custom"
        ? { mode: "custom", url: resolve(world("aws-http-root")) }
        : value.client.endpoint,
    },
  };
};
const configurationDigestDerived = (configuration: AwsEc2Configuration | ScenarioBinding) =>
  derived("aws-configuration-digest", { configuration: literal(configurationExpectation(configuration)) });
const runPrefixDerived = (id: string, configuration: AwsEc2Configuration | ScenarioBinding) =>
  derived("aws-run-prefix", {
    carriage: literal((configuration as AwsEc2Configuration).statusCarriage),
    configurationDigest: literal(resolve(configurationDigestDerived(configuration))),
    runDigest: literal(runDigestValue(id)),
  });
const deliveryDocumentDerived = (id: string, configuration: AwsEc2Configuration | ScenarioBinding) =>
  derived("aws-delivery-document", {
    runId: literal(`scenario-ec2-${id}`),
    content: literal({
      uri: resolve(artifact("task-content-uri")),
      archiveSha256: awsEc2ScenarioTaskContent.archiveSha256,
      treeSha256: awsEc2ScenarioTaskContent.treeSha256,
    }),
    inputDocument: literal({ scenario: `ec2-${id}` }),
    runnerSha256: { kind: "binding", binding: artifact("linux-amd64-runner-sha256") },
    bucket: literal("task-evidence"),
    runPrefix: literal(resolve(runPrefixDerived(id, configuration))),
    association: literal({
      runDigest: runDigestValue(id),
      configurationDigest: resolve(configurationDigestDerived(configuration)),
      archiveSha256: awsEc2ScenarioTaskContent.archiveSha256,
      treeSha256: awsEc2ScenarioTaskContent.treeSha256,
      runnerSha256: resolve(artifact("linux-amd64-runner-sha256")),
    }),
  });
const deliveryDigestDerived = (id: string, configuration: AwsEc2Configuration | ScenarioBinding) =>
  derived("aws-delivery-sha256", { delivery: literal(resolve(deliveryDocumentDerived(id, configuration))) });
const runnerDigestExpectation = expected({ kind: "binding", binding: artifact("linux-amd64-runner-sha256") });

function s3PutRequest(
  id: string,
  configuration: AwsEc2Configuration | ScenarioBinding,
  suffix: string,
  bytes: unknown,
) {
  const metadata = {
    "x-amz-meta-run-digest": runDigestValue(id),
    "x-amz-meta-configuration-digest": expected({ kind: "binding", binding: priorAccount("01-provision-allocations", ["allocationState", "configurationDigest"]) }),
    "x-amz-meta-archive-sha256": awsEc2ScenarioTaskContent.archiveSha256,
    "x-amz-meta-tree-sha256": awsEc2ScenarioTaskContent.treeSha256,
    "x-amz-meta-runner-sha256": runnerDigestExpectation,
  };
  return {
    operation: "PutObject",
    method: "PUT",
    path: expected(joined("/task-evidence/", runPrefixDerived(id, configuration), `/${suffix}`)),
    query: { "x-id": "PutObject" },
    body: expected(derived("recorded-body", { bytes })),
    authorization: {
      algorithm: "AWS4-HMAC-SHA256",
      accessKeyId: credentials.accessKeyId,
      date: awsDate,
      region: "us-east-1",
      service: "s3",
      signedHeaders: ["amz-sdk-invocation-id", "amz-sdk-request", "content-length", "content-type", "host", "if-none-match", "x-amz-checksum-crc32", "x-amz-content-sha256", "x-amz-date", "x-amz-meta-archive-sha256", "x-amz-meta-configuration-digest", "x-amz-meta-run-digest", "x-amz-meta-runner-sha256", "x-amz-meta-tree-sha256", "x-amz-sdk-checksum-algorithm", "x-amz-user-agent"],
      signaturePresent: true,
    },
    signingDate: awsDate,
    conditional: { ifNoneMatch: "*" },
    metadata,
  };
}

const instanceId = "i-0123456789abcdef0";
const rootVolumeId = "vol-root0123456789ab";
const createdVolumeId = "vol-created0123456789";
const clientToken = (id: string) => sha256(`sdlc-task-ec2-v1\0scenario-ec2-${id}`);
const launchTags = (id: string, configuration: AwsEc2Configuration | ScenarioBinding) => [
  { Key: "sdlc:run-digest", Value: runDigestValue(id) },
  { Key: "sdlc:configuration-digest", Value: resolve(configurationDigestDerived(configuration)) },
  { Key: "sdlc:archive-sha256", Value: awsEc2ScenarioTaskContent.archiveSha256 },
  { Key: "sdlc:tree-sha256", Value: awsEc2ScenarioTaskContent.treeSha256 },
  { Key: "sdlc:client-token", Value: clientToken(id) },
];
function launchedInstance(
  id: string,
  configuration: AwsEc2Configuration | ScenarioBinding,
  attachedVolumeId: string | null,
  state: "pending" | "running" | "stopping" | "stopped" | "shutting-down" | "terminated" = "pending",
) {
  const value = configuration as AwsEc2Configuration;
  return {
    InstanceId: instanceId,
    ClientToken: clientToken(id),
    ImageId: value.machine.imageId,
    InstanceType: value.machine.instanceType,
    SubnetId: value.machine.subnetId,
    IamInstanceProfile: { Arn: value.machine.instanceProfileArn },
    HibernationOptions: { Configured: true },
    State: { Code: state === "pending" ? 0 : state === "running" ? 16 : state === "stopping" ? 64 : state === "stopped" ? 80 : state === "shutting-down" ? 32 : 48, Name: state },
    Tags: launchTags(id, configuration),
    BlockDeviceMappings: [
      { DeviceName: "/dev/sda1", Ebs: { VolumeId: rootVolumeId, Status: "attached", DeleteOnTermination: true } },
      ...(attachedVolumeId === null ? [] : [{ DeviceName: "/dev/sdf", Ebs: { VolumeId: attachedVolumeId, Status: "attached", DeleteOnTermination: value.attachedVolume.mode === "create-per-run" ? value.attachedVolume.deleteOnRetire : false } }]),
    ],
  };
}
const instanceXml = (id: string, configuration: AwsEc2Configuration | ScenarioBinding, attachedVolumeId: string | null, state: "pending" | "running" | "stopping" | "stopped" | "shutting-down" | "terminated" = "pending") => {
  const value = launchedInstance(id, configuration, attachedVolumeId, state);
  const mappings = value.BlockDeviceMappings.map((mapping) => `<item><deviceName>${mapping.DeviceName}</deviceName><ebs><volumeId>${mapping.Ebs.VolumeId}</volumeId><status>attached</status><deleteOnTermination>${mapping.Ebs.DeleteOnTermination}</deleteOnTermination></ebs></item>`).join("");
  const tags = value.Tags.map((tag) => `<item><key>${tag.Key}</key><value>${tag.Key === "sdlc:configuration-digest" ? "__CONFIGURATION_DIGEST__" : tag.Value}</value></item>`).join("");
  const xml = `<reservationSet><item><reservationId>r-scenario</reservationId><instancesSet><item><instanceId>${instanceId}</instanceId><clientToken>${value.ClientToken}</clientToken><imageId>${value.ImageId}</imageId><instanceState><code>${value.State.Code}</code><name>${value.State.Name}</name></instanceState><instanceType>${value.InstanceType}</instanceType><subnetId>${value.SubnetId}</subnetId><iamInstanceProfile><arn>${value.IamInstanceProfile.Arn}</arn></iamInstanceProfile><hibernationOptions><configured>true</configured></hibernationOptions><blockDeviceMapping>${mappings}</blockDeviceMapping><tagSet>${tags}</tagSet></item></instancesSet></item></reservationSet>`;
  const [prefix, suffix] = xml.split("__CONFIGURATION_DIGEST__");
  return [prefix!, configurationDigestDerived(configuration), suffix!];
};
const runInstancesXml = (id: string, configuration: AwsEc2Configuration | ScenarioBinding, attachedVolumeId: string | null) => `<RunInstancesResponse xmlns="http://ec2.amazonaws.com/doc/2016-11-15/"><requestId>request-run</requestId><reservationId>r-scenario</reservationId><instancesSet><item><instanceId>${instanceId}</instanceId></item></instancesSet></RunInstancesResponse>`;
const describeInstancesXml = (id: string, configuration: AwsEc2Configuration | ScenarioBinding, attachedVolumeId: string | null, state: "pending" | "running" | "stopping" | "stopped" | "shutting-down" | "terminated" = "pending") => {
  return resolve(joined(`<DescribeInstancesResponse xmlns="http://ec2.amazonaws.com/doc/2016-11-15/"><requestId>request-describe</requestId>`, ...instanceXml(id, configuration, attachedVolumeId, state), "</DescribeInstancesResponse>"));
};

function runInstancesRequest(id: string, configuration: AwsEc2Configuration | ScenarioBinding) {
  const value = configuration as AwsEc2Configuration;
  const body: Record<string, unknown> = {
    Action: "RunInstances", Version: "2016-11-15", ImageId: value.machine.imageId, InstanceType: value.machine.instanceType,
    MinCount: "1", MaxCount: "1", ClientToken: clientToken(id),
    "HibernationOptions.Configured": "true", "NetworkInterface.1.DeviceIndex": "0", "NetworkInterface.1.DeleteOnTermination": "true",
    "NetworkInterface.1.SubnetId": value.machine.subnetId, "NetworkInterface.1.SecurityGroupId.1": value.machine.securityGroupIds[0],
    "NetworkInterface.1.AssociatePublicIpAddress": "false", "IamInstanceProfile.Arn": value.machine.instanceProfileArn,
    "Placement.Tenancy": value.machine.tenancy, "CapacityReservationSpecification.CapacityReservationPreference": value.machine.capacityReservationPreference,
    EbsOptimized: "true", "MetadataOptions.HttpEndpoint": "enabled", "MetadataOptions.HttpTokens": "required", "MetadataOptions.HttpPutResponseHopLimit": "1",
    DisableApiStop: "false", DisableApiTermination: "false", InstanceInitiatedShutdownBehavior: "terminate",
    UserData: expected(derived("aws-ec2-cloudInitUserData", { configuration: literal(configurationExpectation(configuration)), runPrefix: literal(resolve(runPrefixDerived(id, configuration))), archiveSha256: literal(awsEc2ScenarioTaskContent.archiveSha256) })),
  };
  const volumes = [value.rootVolume, ...(value.attachedVolume.mode === "create-per-run" ? [value.attachedVolume] : [])];
  volumes.forEach((volume, index) => {
    const n = index + 1;
    body[`BlockDeviceMapping.${n}.DeviceName`] = index === 0 ? "/dev/sda1" : value.attachedVolume.mode === "create-per-run" ? value.attachedVolume.deviceName : "";
    body[`BlockDeviceMapping.${n}.Ebs.VolumeType`] = volume.volumeType;
    body[`BlockDeviceMapping.${n}.Ebs.VolumeSize`] = String(volume.sizeGiB);
    body[`BlockDeviceMapping.${n}.Ebs.Encrypted`] = String(volume.encrypted);
    body[`BlockDeviceMapping.${n}.Ebs.DeleteOnTermination`] = String(index === 0 || (value.attachedVolume.mode === "create-per-run" && value.attachedVolume.deleteOnRetire));
  });
  launchTags(id, configuration).forEach((tag, index) => {
    for (let specification = 1; specification <= 2; specification += 1) {
      body[`TagSpecification.${specification}.ResourceType`] = specification === 1 ? "instance" : "volume";
      body[`TagSpecification.${specification}.Tag.${index + 1}.Key`] = tag.Key;
      body[`TagSpecification.${specification}.Tag.${index + 1}.Value`] = typeof tag.Value === "object" ? expected(configurationDigestDerived(configuration)) : tag.Value;
    }
  });
  return signedQuery("RunInstances", body as Record<string, string>);
}
const describeRequest = () => signedQuery("DescribeInstances", { Action: "DescribeInstances", Version: "2016-11-15", "InstanceId.1": instanceId });
const attachRequest = () => signedQuery("AttachVolume", { Action: "AttachVolume", Version: "2016-11-15", Device: "/dev/sdf", InstanceId: instanceId, VolumeId: "vol-0123456789abcdef0" });

function launchAccount(
  id: string,
  configuration: AwsEc2Configuration | ScenarioBinding,
  attachedVolumeId: string | null,
  ownership: "none" | "run" | "external",
  step = "02-launch",
  previousStep = "01-provision-allocations",
) {
  const deliverySha256 = expected(deliveryDigestDerived(id, configuration));
  const runPrefix = expected(runPrefixDerived(id, configuration));
  const expectedInstance = launchedInstance(id, configuration, attachedVolumeId);
  const expectedTags = expectedInstance.Tags.map((tag) => tag.Key === "sdlc:configuration-digest" ? { ...tag, Value: expected(configurationDigestDerived(configuration)) } : tag);
  const witnessedInstance = { ...expectedInstance, Tags: expectedTags };
  const native = { Reservations: [{ ReservationId: "r-scenario", Instances: [witnessedInstance] }], $metadata: responseMetadata };
  return {
    version: 1, actIdentity: `ec2-${id}-${step}`, runId: `scenario-ec2-${id}`,
    allocationState: expected({ kind: "binding", binding: priorAccount(previousStep, ["allocationState"]) }),
    runState: {
      version: 1,
      configurationDigest: expected({ kind: "binding", binding: priorAccount("01-provision-allocations", ["allocationState", "configurationDigest"]) }),
      clientToken: clientToken(id), instanceId, rootVolumeId, attachedVolumeId, attachedVolumeOwnership: ownership,
      carriage: { version: 1, bucket: "task-evidence", runPrefix, archiveSha256: awsEc2ScenarioTaskContent.archiveSha256, treeSha256: awsEc2ScenarioTaskContent.treeSha256, runnerSha256: runnerDigestExpectation, deliverySha256, lastEnvironmentSequence: 0, lastCommandSequence: 0 },
      launchAssociationDigest: sha256(canonical({ instanceId, rootVolumeId, attachedVolumeId, clientToken: clientToken(id) })),
      lastProviderState: "pending", pauseWitnessedAt: null, commandSequence: 0,
    },
    providerTestimony: { kind: "witnessed", standing: "pending", observedAt, native },
    environmentStatus: expected({ kind: "binding", binding: priorAccount(previousStep, ["environmentStatus"]) }),
    retention: null, outcome: { kind: "witnessed" },
  };
}

function executableLaunch(id: string, attachedVolume: AwsEc2Configuration["attachedVolume"], configuration = scenarioConfiguration(attachedVolume)): ProviderScenarioDescriptor {
  const attachedVolumeId = attachedVolume.mode === "create-per-run" ? createdVolumeId : attachedVolume.mode === "existing" ? attachedVolume.volumeId : null;
  const ownership = attachedVolume.mode === "create-per-run" ? "run" : attachedVolume.mode === "existing" ? "external" : "none";
  const puts = [
    s3PutRequest(id, configuration, "task/archive", { kind: "task-archive" }),
    s3PutRequest(id, configuration, "runner/task-runner", { kind: "runner-file", binding: "linux-amd64-runner-path" }),
    s3PutRequest(id, configuration, "delivery.json", deliveryDocumentDerived(id, configuration)),
    { ...s3PutRequest(id, configuration, "guest/carriage.mjs", literal(null)), body: { base64: Buffer.from(awsGuestCarriageProgram(validAwsEc2Configuration(attachedVolume))).toString("base64"), utf8: Buffer.from(awsGuestCarriageProgram(validAwsEc2Configuration(attachedVolume))).toString("utf8") } },
  ];
  const launchReadyBytes = new TextEncoder().encode(canonical({ instanceId, rootVolumeId, attachedVolumeId }));
  const launchReady = { ...s3PutRequest(id, configuration, "launch-ready.json", literal(null)), body: { base64: Buffer.from(launchReadyBytes).toString("base64"), utf8: Buffer.from(launchReadyBytes).toString("utf8") } };
  const script = [
    ...puts.map(() => ({ request: {}, response: xml(""), externalEffect: {} })),
    { request: {}, response: xml(runInstancesXml(id, configuration, attachedVolumeId)), externalEffect: {} },
    { request: {}, response: xml(describeInstancesXml(id, configuration, attachedVolumeId)), externalEffect: {} },
    ...(attachedVolume.mode === "existing" ? [{ request: {}, response: xml(`<AttachVolumeResponse xmlns="http://ec2.amazonaws.com/doc/2016-11-15/"><requestId>request-attach</requestId><volumeId>${attachedVolume.volumeId}</volumeId><instanceId>${instanceId}</instanceId><device>${attachedVolume.deviceName}</device><status>attaching</status></AttachVolumeResponse>`), externalEffect: {} }] : []),
    { request: {}, response: xml(describeInstancesXml(id, configuration, attachedVolumeId)), externalEffect: {} },
    { request: {}, response: xml(""), externalEffect: {} },
  ];
  const base = qualification(id, "success", configuration);
  base.id = `ec2-${id}`;
  base.traces = [id, "credential-redaction"];
  base.world.script.push(...script);
  base.acts.push(document({
    step: "02-launch",
    demand: demand(`ec2-${id}`, "02-launch", "launch", configuration, "01-provision-allocations"),
    expectedAccount: launchAccount(id, configuration, attachedVolumeId, ownership),
    expectedWorld: { requests: [...qualificationRequests, ...(attachedVolume.mode === "existing" ? [signedQuery("DescribeVolumes", { Action: "DescribeVolumes", Version: "2016-11-15", "VolumeId.1": attachedVolume.volumeId })] : []), ...puts, runInstancesRequest(id, configuration), describeRequest(), ...(attachedVolume.mode === "existing" ? [attachRequest()] : []), describeRequest(), launchReady], effects: { ec2: {}, iam: {}, s3: {} }, environmentCount: 1 },
  }));
  return document(base);
}

function executableReplay(id: "launch-exact-replay" | "launch-idempotency-mismatch"): ProviderScenarioDescriptor {
  const configuration = scenarioConfiguration();
  const base = executableLaunch(id, attachedVolumeFixtures[0]!, configuration);
  const mismatch = id === "launch-idempotency-mismatch";
  base.world.script.push(...document([
    mismatch
      ? { request: {}, response: { kind: "service-error", status: 400, code: "IdempotentParameterMismatch", headers: { "content-type": "text/xml" }, body: `<Response><Errors><Error><Code>IdempotentParameterMismatch</Code><Message>mismatch</Message></Error></Errors><RequestID>request-mismatch</RequestID></Response>` }, externalEffect: {} }
      : { request: {}, response: xml(runInstancesXml(id, configuration, null)), externalEffect: {} },
    ...(!mismatch
      ? [
          { request: {}, response: xml(describeInstancesXml(id, configuration, null)), externalEffect: {} },
          { request: {}, response: xml(describeInstancesXml(id, configuration, null)), externalEffect: {} },
          { request: {}, response: xml(""), externalEffect: {} },
        ]
      : []),
  ]));
  const prior = "02-launch";
  const previousRequests = base.acts[1]!.expectedWorld.requests;
  const bytes = new TextEncoder().encode(canonical({ instanceId, rootVolumeId, attachedVolumeId: null }));
  const replayLaunchReady = { ...s3PutRequest(id, configuration, "launch-ready.json", literal(null)), body: { base64: Buffer.from(bytes).toString("base64"), utf8: Buffer.from(bytes).toString("utf8") } };
  const replayRequests = [runInstancesRequest(id, configuration), ...(!mismatch ? [describeRequest(), describeRequest(), replayLaunchReady] : [])];
  base.acts.push(document({
    step: "03-launch",
    demand: demand(`ec2-${id}`, "03-launch", "launch", configuration, prior),
    expectedAccount: mismatch
      ? {
          version: 1,
          actIdentity: `ec2-${id}-03-launch`,
          runId: `scenario-ec2-${id}`,
          allocationState: expected({ kind: "binding", binding: priorAccount(prior, ["allocationState"]) }),
          runState: expected({ kind: "binding", binding: priorAccount(prior, ["runState"]) }),
          providerTestimony: { kind: "silent" },
          environmentStatus: expected({ kind: "binding", binding: priorAccount(prior, ["environmentStatus"]) }),
          retention: null,
          outcome: { kind: "refusal", name: "aws-idempotency-conflict", detail: { code: "IdempotentParameterMismatch", requestId: null } },
        }
      : launchAccount(id, configuration, null, "none", "03-launch", prior),
    expectedWorld: { requests: [...previousRequests, ...replayRequests], effects: { ec2: {}, iam: {}, s3: {} }, environmentCount: 1 },
  }));
  return document(base);
}

function executableLostRecovery(): ProviderScenarioDescriptor {
  const id = "launch-lost-recovery";
  const configuration = scenarioConfiguration();
  const base = executableLaunch(id, attachedVolumeFixtures[0]!, configuration);
  const launchStep = base.acts[1]!;
  base.world.script.splice(
    9,
    1,
    ...document([
      { request: {}, response: { kind: "connection-loss", phase: "after-apply", appliedEffect: {} }, externalEffect: {} },
      { request: {}, response: { kind: "connection-loss", phase: "after-apply", appliedEffect: {} }, externalEffect: {} },
      { request: {}, response: { kind: "connection-loss", phase: "after-apply", appliedEffect: {} }, externalEffect: {} },
      { request: {}, response: { kind: "connection-loss", phase: "after-apply", appliedEffect: {} }, externalEffect: {} },
      { request: {}, response: xml(describeInstancesXml(id, configuration, null)), externalEffect: {} },
    ]),
  );
  const run = runInstancesRequest(id, configuration);
  const recovery = signedQuery("DescribeInstances", {
    Action: "DescribeInstances",
    Version: "2016-11-15",
    "Filter.1.Name": "client-token",
    "Filter.1.Value.1": clientToken(id),
    ...Object.fromEntries(launchTags(id, configuration).flatMap((tag, index) => [
      [`Filter.${index + 2}.Name`, `tag:${tag.Key}`],
      [`Filter.${index + 2}.Value.1`, tag.Key === "sdlc:configuration-digest" ? expected(configurationDigestDerived(configuration)) : tag.Value],
    ])),
  } as Record<string, string>);
  const requests = launchStep.expectedWorld.requests;
  launchStep.expectedWorld.requests = document([...requests.slice(0, 9), run, run, run, run, recovery, ...requests.slice(10)]);
  return document(base);
}

function s3ListRequest(id: string, configuration: AwsEc2Configuration | ScenarioBinding) {
  return {
    operation: "ListObjectsV2", method: "GET", path: "/task-evidence/",
    query: { "list-type": "2", prefix: expected(joined(runPrefixDerived(id, configuration), "/status/")) }, body: null,
    authorization: { algorithm: "AWS4-HMAC-SHA256", accessKeyId: credentials.accessKeyId, date: awsDate, region: "us-east-1", service: "s3", signedHeaders: ["amz-sdk-invocation-id", "amz-sdk-request", "host", "x-amz-content-sha256", "x-amz-date", "x-amz-user-agent"], signaturePresent: true },
    signingDate: awsDate, conditional: { ifNoneMatch: null }, metadata: {},
  };
}

function s3GetStatusRequest(id: string, configuration: AwsEc2Configuration | ScenarioBinding) {
  return {
    operation: "GetObject", method: "GET",
    path: expected(joined("/task-evidence/", runPrefixDerived(id, configuration), "/status/00000000000000000001.json")),
    query: { "x-id": "GetObject" }, body: null,
    authorization: { algorithm: "AWS4-HMAC-SHA256", accessKeyId: credentials.accessKeyId, date: awsDate, region: "us-east-1", service: "s3", signedHeaders: ["amz-sdk-invocation-id", "amz-sdk-request", "host", "x-amz-checksum-mode", "x-amz-content-sha256", "x-amz-date", "x-amz-user-agent"], signaturePresent: true },
    signingDate: awsDate, conditional: { ifNoneMatch: null }, metadata: {},
  };
}

function executableObserve(mode: "running" | "gone-without-exit" | "exit-while-running"): ProviderScenarioDescriptor {
  const id = `observe-${mode}`;
  const configuration = scenarioConfiguration();
  const base = executableLaunch(id, attachedVolumeFixtures[0]!);
  const missing = mode === "gone-without-exit";
  const report = mode === "exit-while-running" ? {
    deliveryClaimed: { at: "2026-11-21T00:00:00.000Z" },
    entryStarted: { at: "2026-11-21T00:00:01.000Z" },
    entryExited: { at: "2026-11-21T00:00:02.000Z", exitEvidence: { kind: "code", code: 0 }, output: { kind: "document", document: { scenario: `ec2-${id}` } } },
    commandAcknowledgements: [],
  } : silentEnvironment;
  const describeBody = missing
    ? `<DescribeInstancesResponse xmlns="http://ec2.amazonaws.com/doc/2016-11-15/"><requestId>request-describe</requestId><reservationSet></reservationSet></DescribeInstancesResponse>`
    : describeInstancesXml(id, configuration, null, "running");
  const listBody = mode === "exit-while-running"
    ? resolve(joined("<?xml version=\"1.0\" encoding=\"UTF-8\"?><ListBucketResult xmlns=\"http://s3.amazonaws.com/doc/2006-03-01/\"><Name>task-evidence</Name><Prefix></Prefix><KeyCount>1</KeyCount><MaxKeys>1000</MaxKeys><IsTruncated>false</IsTruncated><Contents><Key>", runPrefixDerived(id, configuration), "/status/00000000000000000001.json</Key></Contents></ListBucketResult>"))
    : `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>task-evidence</Name><Prefix></Prefix><KeyCount>0</KeyCount><MaxKeys>1000</MaxKeys><IsTruncated>false</IsTruncated></ListBucketResult>`;
  const metadata = { "x-amz-meta-run-digest": runDigestValue(id), "x-amz-meta-configuration-digest": resolve(configurationDigestDerived(configuration)), "x-amz-meta-archive-sha256": awsEc2ScenarioTaskContent.archiveSha256, "x-amz-meta-tree-sha256": awsEc2ScenarioTaskContent.treeSha256, "x-amz-meta-runner-sha256": resolve(artifact("linux-amd64-runner-sha256")) };
  base.world.script.push(
    { request: {}, response: xml(describeBody), externalEffect: {} },
    { request: {}, response: document({ kind: "success", status: 200, headers: { "content-type": "application/xml" }, body: listBody }), externalEffect: {} },
    ...(mode === "exit-while-running" ? [{ request: {}, response: document({ kind: "success", status: 200, headers: metadata, body: JSON.stringify(report) }), externalEffect: {} }] : []),
  );
  const launched = launchedInstance(id, configuration, null, "running");
  const native = missing
    ? { Reservations: [], $metadata: responseMetadata }
    : { Reservations: [{ ReservationId: "r-scenario", Instances: [{ ...launched, Tags: launched.Tags.map((tag) => tag.Key === "sdlc:configuration-digest" ? { ...tag, Value: expected(configurationDigestDerived(configuration)) } : tag) }] }], $metadata: responseMetadata };
  base.acts.push(document({
    step: "03-observe",
    demand: demand(`ec2-${id}`, "03-observe", "observe", configuration, "02-launch"),
    expectedAccount: {
      version: 1, actIdentity: `ec2-${id}-03-observe`, runId: `scenario-ec2-${id}`,
      allocationState: expected({ kind: "binding", binding: priorAccount("02-launch", ["allocationState"]) }),
      runState: missing ? expected({ kind: "binding", binding: priorAccount("02-launch", ["runState"]) }) : { ...launchAccount(id, configuration, null, "none").runState, lastProviderState: "running", carriage: expected({ kind: "binding", binding: priorAccount("02-launch", ["runState", "carriage"]) }) },
      providerTestimony: { kind: "witnessed", standing: missing ? "gone" : "live", observedAt, native },
      environmentStatus: report, retention: null, outcome: { kind: "witnessed" },
    },
    expectedWorld: { requests: [...base.acts[1]!.expectedWorld.requests, describeRequest(), s3ListRequest(id, configuration), ...(mode === "exit-while-running" ? [s3GetStatusRequest(id, configuration)] : [])], effects: { ec2: {}, iam: {}, s3: {} }, environmentCount: 1 },
  }));
  return document(base);
}

const stopRequest = () => signedQuery("StopInstances", { Action: "StopInstances", Version: "2016-11-15", "InstanceId.1": instanceId, Hibernate: "true" });
const stopXml = (reportedInstanceId = instanceId) => `<StopInstancesResponse xmlns="http://ec2.amazonaws.com/doc/2016-11-15/"><requestId>request-stop</requestId><instancesSet><item><instanceId>${reportedInstanceId}</instanceId><currentState><code>64</code><name>stopping</name></currentState><previousState><code>16</code><name>running</name></previousState></item></instancesSet></StopInstancesResponse>`;
const startRequest = () => signedQuery("StartInstances", { Action: "StartInstances", Version: "2016-11-15", "InstanceId.1": instanceId });
const startXml = `<StartInstancesResponse xmlns="http://ec2.amazonaws.com/doc/2016-11-15/"><requestId>request-start</requestId><instancesSet><item><instanceId>${instanceId}</instanceId><currentState><code>0</code><name>pending</name></currentState><previousState><code>80</code><name>stopped</name></previousState></item></instancesSet></StartInstancesResponse>`;
const terminateRequest = () => signedQuery("TerminateInstances", { Action: "TerminateInstances", Version: "2016-11-15", "InstanceId.1": instanceId });
const terminateXml = `<TerminateInstancesResponse xmlns="http://ec2.amazonaws.com/doc/2016-11-15/"><requestId>request-terminate</requestId><instancesSet><item><instanceId>${instanceId}</instanceId><currentState><code>32</code><name>shutting-down</name></currentState><previousState><code>16</code><name>running</name></previousState></item></instancesSet></TerminateInstancesResponse>`;

function witnessedNative(id: string, configuration: AwsEc2Configuration, attachedVolumeId: string | null, state: "running" | "stopped" | "terminated") {
  const value = launchedInstance(id, configuration, attachedVolumeId, state);
  return { Reservations: [{ ReservationId: "r-scenario", Instances: [{ ...value, Tags: value.Tags.map((tag) => tag.Key === "sdlc:configuration-digest" ? { ...tag, Value: expected(configurationDigestDerived(configuration)) } : tag) }] }], $metadata: responseMetadata };
}

function executablePauseResume(): ProviderScenarioDescriptor {
  const id = "pause-resume";
  const configuration = scenarioConfiguration();
  const base = executableLaunch(id, attachedVolumeFixtures[0]!);
  base.id = "ec2-pause-resume";
  base.traces = ["pause-hibernated", "resume-same-instance", "credential-redaction"];
  base.world.script.push(
    { request: {}, response: xml(describeInstancesXml(id, configuration, null, "running")), externalEffect: {} },
    { request: {}, response: xml(stopXml()), externalEffect: {} },
    { request: {}, response: xml(describeInstancesXml(id, configuration, null, "stopped")), externalEffect: {} },
    { request: {}, response: xml(describeInstancesXml(id, configuration, null, "stopped")), externalEffect: {} },
    { request: {}, response: xml(startXml), externalEffect: {} },
    { request: {}, response: xml(describeInstancesXml(id, configuration, null, "running")), externalEffect: {} },
    { request: {}, response: xml(`<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>task-evidence</Name><KeyCount>0</KeyCount><IsTruncated>false</IsTruncated></ListBucketResult>`), externalEffect: {} },
  );
  const launchRequests = base.acts[1]!.expectedWorld.requests;
  const pauseState = { ...launchAccount(id, configuration, null, "none").runState, lastProviderState: "stopped", pauseWitnessedAt: observedAt };
  base.acts.push(document({
    step: "03-pause", demand: demand("ec2-pause-resume", "03-pause", "pause", configuration, "02-launch"),
    expectedAccount: { version: 1, actIdentity: "ec2-pause-resume-03-pause", runId: "scenario-ec2-pause-resume", allocationState: expected({ kind: "binding", binding: priorAccount("02-launch", ["allocationState"]) }), runState: pauseState, providerTestimony: { kind: "witnessed", standing: "paused", observedAt, native: witnessedNative(id, configuration, null, "stopped") }, environmentStatus: expected({ kind: "binding", binding: priorAccount("02-launch", ["environmentStatus"]) }), retention: { kind: "paused", expiresAt: { $expect: { kind: "iso-8601", anchor: "step-start", offsetSeconds: 3600, toleranceMilliseconds: 30_000 } } }, outcome: { kind: "witnessed" } },
    expectedWorld: { requests: [...launchRequests, describeRequest(), stopRequest(), describeRequest()], effects: { ec2: {}, iam: {}, s3: {} }, environmentCount: 1 },
  }));
  base.acts.push(document({
    step: "04-resume", demand: demand("ec2-pause-resume", "04-resume", "resume", configuration, "03-pause"),
    expectedAccount: { version: 1, actIdentity: "ec2-pause-resume-04-resume", runId: "scenario-ec2-pause-resume", allocationState: expected({ kind: "binding", binding: priorAccount("03-pause", ["allocationState"]) }), runState: { ...pauseState, pauseWitnessedAt: null, lastProviderState: "running" }, providerTestimony: { kind: "witnessed", standing: "live", observedAt, native: witnessedNative(id, configuration, null, "running") }, environmentStatus: silentEnvironment, retention: null, outcome: { kind: "witnessed" } },
    expectedWorld: { requests: [...launchRequests, describeRequest(), stopRequest(), describeRequest(), describeRequest(), startRequest(), describeRequest(), s3ListRequest(id, configuration)], effects: { ec2: {}, iam: {}, s3: {} }, environmentCount: 1 },
  }));
  return document(base);
}

function commandPutRequest(id: string, configuration: AwsEc2Configuration, command: unknown) {
  const bytes = new TextEncoder().encode(canonical(command));
  return { ...s3PutRequest(id, configuration, "commands/00000000000000000001.json", literal(null)), body: { base64: Buffer.from(bytes).toString("base64"), utf8: Buffer.from(bytes).toString("utf8") } };
}

function statusListXml(id: string, configuration: AwsEc2Configuration, present: boolean) {
  return present
    ? resolve(joined(`<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>task-evidence</Name><KeyCount>1</KeyCount><IsTruncated>false</IsTruncated><Contents><Key>`, runPrefixDerived(id, configuration), `/status/00000000000000000001.json</Key></Contents></ListBucketResult>`))
    : `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>task-evidence</Name><KeyCount>0</KeyCount><IsTruncated>false</IsTruncated></ListBucketResult>`;
}

function executableCancel(kind: "acknowledged" | "forced"): ProviderScenarioDescriptor {
  const id = `cancel-${kind}`;
  const configuration = { ...scenarioConfiguration(), lifecycle: { ...scenarioConfiguration().lifecycle, cancelGraceMilliseconds: 1 } };
  const base = executableLaunch(id, attachedVolumeFixtures[0]!, configuration);
  const actIdentity = `ec2-${id}-03-cancel`;
  const commandId = sha256(`cancel\0${actIdentity}`);
  const command = { version: 1, commandId, command: "cancel", graceMilliseconds: 1 };
  const report = kind === "acknowledged" ? { ...silentEnvironment, commandAcknowledgements: [{ commandId, command: "cancel", acknowledgedAt: "2026-11-21T00:00:00.000Z", outcome: "accepted", detail: null }] } : silentEnvironment;
  const metadata = { "x-amz-meta-run-digest": runDigestValue(id), "x-amz-meta-configuration-digest": resolve(configurationDigestDerived(configuration)), "x-amz-meta-archive-sha256": awsEc2ScenarioTaskContent.archiveSha256, "x-amz-meta-tree-sha256": awsEc2ScenarioTaskContent.treeSha256, "x-amz-meta-runner-sha256": resolve(artifact("linux-amd64-runner-sha256")) };
  base.world.script.push(
    { request: {}, response: xml(""), externalEffect: {} },
    { request: {}, response: xml(statusListXml(id, configuration, kind === "acknowledged")), externalEffect: {} },
    ...(kind === "acknowledged" ? [{ request: {}, response: document({ kind: "success", status: 200, headers: metadata, body: JSON.stringify(report) }), externalEffect: {} }] : []),
    { request: {}, response: xml(terminateXml), externalEffect: {} },
    { request: {}, response: xml(describeInstancesXml(id, configuration, null, "terminated")), externalEffect: {} },
  );
  const launchRequests = base.acts[1]!.expectedWorld.requests;
  const runState = launchAccount(id, configuration, null, "none").runState;
  const requests = [...launchRequests, commandPutRequest(id, configuration, command), s3ListRequest(id, configuration), ...(kind === "acknowledged" ? [s3GetStatusRequest(id, configuration)] : []), terminateRequest(), describeRequest()];
  base.acts.push(document({
    step: "03-cancel", demand: demand(`ec2-${id}`, "03-cancel", "cancel", configuration, "02-launch"),
    expectedAccount: { version: 1, actIdentity, runId: `scenario-ec2-${id}`, allocationState: expected({ kind: "binding", binding: priorAccount("02-launch", ["allocationState"]) }), runState: { ...runState, carriage: { ...runState.carriage, lastCommandSequence: 1 }, commandSequence: 1, lastProviderState: "terminated" }, providerTestimony: { kind: "witnessed", standing: "terminal", observedAt, native: witnessedNative(id, configuration, null, "terminated") }, environmentStatus: report, retention: null, outcome: { kind: "witnessed" } },
    expectedWorld: { requests, effects: { ec2: {}, iam: {}, s3: {} }, environmentCount: 1 },
  }));
  return document(base);
}

const deleteVolumeRequest = (volumeId: string) => signedQuery("DeleteVolume", { Action: "DeleteVolume", Version: "2016-11-15", VolumeId: volumeId });
const describeVolumeRequest = (volumeId: string) => signedQuery("DescribeVolumes", { Action: "DescribeVolumes", Version: "2016-11-15", "VolumeId.1": volumeId });
const volumeAvailableXml = (volumeId: string) => `<DescribeVolumesResponse xmlns="http://ec2.amazonaws.com/doc/2016-11-15/"><requestId>request-volume</requestId><volumeSet><item><volumeId>${volumeId}</volumeId><status>available</status><availabilityZone>us-east-1a</availabilityZone></item></volumeSet></DescribeVolumesResponse>`;

function executableRetire(kind: "delete-run-volume" | "retain-run-volume" | "external-volume" | "partial-cleanup"): ProviderScenarioDescriptor {
  const id = `retire-${kind}`;
  const createdVolume = attachedVolumeFixtures[1]!;
  const externalVolume = attachedVolumeFixtures[2]!;
  if (createdVolume.mode !== "create-per-run" || externalVolume.mode !== "existing") throw new Error("ec2-volume-fixture-order");
  const attachedVolume: AwsEc2Configuration["attachedVolume"] = kind === "external-volume"
    ? externalVolume
    : { ...createdVolume, deleteOnRetire: kind !== "retain-run-volume" };
  const configuration = scenarioConfiguration(attachedVolume);
  const attachedVolumeId = attachedVolume.mode === "existing" ? attachedVolume.volumeId : createdVolumeId;
  const ownership = attachedVolume.mode === "existing" ? "external" : "run";
  const base = executableLaunch(id, attachedVolume, configuration);
  const partial = kind === "partial-cleanup";
  const deleteRunVolume = attachedVolume.mode === "create-per-run" && attachedVolume.deleteOnRetire;
  base.world.script.push(
    { request: {}, response: xml(describeInstancesXml(id, configuration, attachedVolumeId, "pending")), externalEffect: {} },
    { request: {}, response: xml(terminateXml), externalEffect: {} },
    { request: {}, response: xml(describeInstancesXml(id, configuration, attachedVolumeId, "terminated")), externalEffect: {} },
    ...(deleteRunVolume ? partial
      ? [
          { request: {}, response: { kind: "connection-loss", phase: "after-apply", appliedEffect: {} }, externalEffect: {} },
          { request: {}, response: { kind: "connection-loss", phase: "after-apply", appliedEffect: {} }, externalEffect: {} },
        ]
      : [
          { request: {}, response: xml(`<DeleteVolumeResponse xmlns="http://ec2.amazonaws.com/doc/2016-11-15/"><requestId>request-delete</requestId></DeleteVolumeResponse>`), externalEffect: {} },
          { request: {}, response: { kind: "service-error", status: 400, code: "InvalidVolume.NotFound", headers: { "content-type": "text/xml" }, body: `<Response><Errors><Error><Code>InvalidVolume.NotFound</Code><Message>missing</Message></Error></Errors><RequestID>request-volume-missing</RequestID></Response>` }, externalEffect: {} },
        ] : []),
    ...(attachedVolume.mode === "existing" ? [{ request: {}, response: xml(volumeAvailableXml(attachedVolumeId)), externalEffect: {} }] : []),
  );
  const launchRequests = base.acts[1]!.expectedWorld.requests;
  const cleanupRequests = [describeRequest(), terminateRequest(), describeRequest(), ...(deleteRunVolume ? [deleteVolumeRequest(attachedVolumeId), ...(partial ? [deleteVolumeRequest(attachedVolumeId)] : [describeVolumeRequest(attachedVolumeId)])] : []), ...(attachedVolume.mode === "existing" ? [describeVolumeRequest(attachedVolumeId)] : [])];
  const priorState = launchAccount(id, configuration, attachedVolumeId, ownership).runState;
  base.acts.push(document({
    step: "03-retire", demand: demand(`ec2-${id}`, "03-retire", "retire", configuration, "02-launch"),
    expectedAccount: partial
      ? { version: 1, actIdentity: `ec2-${id}-03-retire`, runId: `scenario-ec2-${id}`, allocationState: expected({ kind: "binding", binding: priorAccount("02-launch", ["allocationState"]) }), runState: expected({ kind: "binding", binding: priorAccount("02-launch", ["runState"]) }), providerTestimony: { kind: "silent" }, environmentStatus: expected({ kind: "binding", binding: priorAccount("02-launch", ["environmentStatus"]) }), retention: null, outcome: { kind: "lost-answer", operation: "DeleteVolume", detail: { code: "TimeoutError", requestId: null } } }
      : { version: 1, actIdentity: `ec2-${id}-03-retire`, runId: `scenario-ec2-${id}`, allocationState: expected({ kind: "binding", binding: priorAccount("02-launch", ["allocationState"]) }), runState: { ...priorState, lastProviderState: "terminated" }, providerTestimony: { kind: "witnessed", standing: "terminal", observedAt, native: witnessedNative(id, configuration, attachedVolumeId, "terminated") }, environmentStatus: expected({ kind: "binding", binding: priorAccount("02-launch", ["environmentStatus"]) }), retention: null, outcome: { kind: "witnessed" } },
    expectedWorld: { requests: [...launchRequests, ...cleanupRequests], effects: { ec2: {}, iam: {}, s3: {} }, environmentCount: 1 },
  }));
  return document(base);
}

function executableOrdinaryStopRefusal(): ProviderScenarioDescriptor {
  const id = "pause-ordinary-stop";
  const configuration = scenarioConfiguration();
  const base = executableLaunch(id, attachedVolumeFixtures[0]!);
  base.world.script.push(
    { request: {}, response: xml(describeInstancesXml(id, configuration, null, "running")), externalEffect: {} },
    { request: {}, response: xml(stopXml("i-ordinary-stop")), externalEffect: {} },
  );
  const stopResponse = { StoppingInstances: [{ InstanceId: "i-ordinary-stop", CurrentState: { Code: 64, Name: "stopping" }, PreviousState: { Code: 16, Name: "running" } }], $metadata: responseMetadata };
  base.acts.push(document({
    step: "03-pause", demand: demand(`ec2-${id}`, "03-pause", "pause", configuration, "02-launch"),
    expectedAccount: { version: 1, actIdentity: `ec2-${id}-03-pause`, runId: `scenario-ec2-${id}`, allocationState: expected({ kind: "binding", binding: priorAccount("02-launch", ["allocationState"]) }), runState: expected({ kind: "binding", binding: priorAccount("02-launch", ["runState"]) }), providerTestimony: { kind: "silent" }, environmentStatus: expected({ kind: "binding", binding: priorAccount("02-launch", ["environmentStatus"]) }), retention: null, outcome: { kind: "refusal", name: "ec2-hibernation-unwitnessed", detail: stopResponse } },
    expectedWorld: { requests: [...base.acts[1]!.expectedWorld.requests, describeRequest(), stopRequest()], effects: { ec2: {}, iam: {}, s3: {} }, environmentCount: 1 },
  }));
  return document(base);
}

export const awsEc2ScenarioCatalogue: ProviderScenarioDescriptor[] = [
  qualification("qualification-success", "success"),
  qualification("qualification-root-unencrypted", "root-unencrypted"),
  qualification("qualification-hibernation-unsupported", "hibernation-unsupported"),
  qualification("qualification-existing-volume-in-use", "existing-volume-in-use"),
  executableLaunch("launch-no-volume", attachedVolumeFixtures[0]!),
  executableLaunch("launch-create-volume", attachedVolumeFixtures[1]!),
  executableLaunch("launch-existing-volume", attachedVolumeFixtures[2]!),
  executableReplay("launch-exact-replay"),
  executableLostRecovery(),
  executableReplay("launch-idempotency-mismatch"),
  executableObserve("running"),
  executableObserve("gone-without-exit"),
  executableObserve("exit-while-running"),
  executablePauseResume(),
  executableOrdinaryStopRefusal(),
  executableCancel("acknowledged"),
  executableCancel("forced"),
  executableRetire("delete-run-volume"),
  executableRetire("retain-run-volume"),
  executableRetire("external-volume"),
  executableRetire("partial-cleanup"),
];
