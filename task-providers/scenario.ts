import type {
  JSONValue,
  TaskEnactmentAccount,
  TaskEnactmentDemand,
} from "@sdlcworks/components/task";

export type ScenarioBinding = {
  $scenario: {
    source: "artifact" | "world" | "account";
    name: string;
    step: string | null;
    path: string[];
  };
};

export type ScenarioTemplate<T> =
  | ScenarioBinding
  | (T extends null | boolean | number | string
      ? T
      : T extends Array<infer U>
        ? Array<ScenarioTemplate<U>>
        : T extends object
          ? { [K in keyof T]: ScenarioTemplate<T[K]> }
          : never);

export type ScenarioDerivedInput =
  | { kind: "literal"; value: ScenarioResolvable<JSONValue> }
  | { kind: "binding"; binding: ScenarioBinding }
  | { kind: "account"; step: string; path: string }
  | { kind: "runner-file"; binding: "linux-amd64-runner-path" | "linux-arm64-runner-path" }
  | { kind: "task-archive" }
  | { kind: "slice"; of: { kind: "runner-file"; binding: "linux-amd64-runner-path" | "linux-arm64-runner-path" } | { kind: "task-archive" }; offsetBytes: number; lengthBytes: number }
  | ScenarioDerived;

export type ScenarioDerivedName =
  | "aws-configuration-digest"
  | "aws-run-prefix"
  | "aws-delivery-sha256"
  | "aws-delivery-document"
  | "recorded-body"
  | "kubernetes-delivery-sha256"
  | "kubernetes-delivery-payload"
  | "kubernetes-object-identity-digest"
  | "kubernetes-run-suffix"
  | "kubernetes-run-id-digest"
  | `aws-lambda-${string}`
  | `aws-codebuild-${string}`
  | `aws-ec2-${string}`;

export type ScenarioDerived = {
  kind: "derived";
  name: ScenarioDerivedName;
  inputs: Record<string, ScenarioDerivedInput>;
};

export type ScenarioJoinedPart =
  | string
  | ScenarioBinding
  | ScenarioDerived
  | { kind: "binding"; binding: ScenarioBinding }
  | { kind: "account"; step: string; path: string };

export type ScenarioJoined = {
  kind: "joined";
  parts: ScenarioJoinedPart[];
};

export type ScenarioResolution = {
  $resolve: ScenarioBinding | ScenarioDerived | ScenarioJoined;
};

export type ScenarioResolvable<T> =
  | ScenarioBinding
  | ScenarioResolution
  | (T extends null | boolean | number | string
      ? T
      : T extends Array<infer U>
        ? Array<ScenarioResolvable<U>>
        : T extends object
          ? { [K in keyof T]: ScenarioResolvable<T[K]> }
          : never);

export type ScenarioExpectation<T> =
  | {
      $expect: {
        kind: "iso-8601";
        anchor: "step-start";
        offsetSeconds: number;
        toleranceMilliseconds: number;
      };
    }
  | {
      $expect: {
        kind: "aws-amz-date";
        anchor: "step-start";
        offsetSeconds: number;
        toleranceMilliseconds: number;
      };
    }
  | { $expect: { kind: "binding"; binding: ScenarioBinding } }
  | {
      $expect: ScenarioDerived;
    }
  | {
      $expect: ScenarioJoined;
    }
  | (T extends null | boolean | number | string
      ? T
      : T extends Array<infer U>
        ? Array<ScenarioExpectation<U>>
        : T extends object
          ? { [K in keyof T]: ScenarioExpectation<T[K]> }
          : never);

export type ScenarioDemand = ScenarioTemplate<
  TaskEnactmentDemand<JSONValue, JSONValue, JSONValue, JSONValue>
>;
export type ScenarioAccountExpectation = ScenarioExpectation<
  TaskEnactmentAccount<JSONValue, JSONValue>
>;

export type ScenarioWorld = {
  kind: "aws-http" | "kubernetes-https";
  initialState: ScenarioTemplate<JSONValue>;
  script: Array<{
    request: ScenarioExpectation<JSONValue>;
    response:
      | {
          kind: "success";
          status: number;
          headers: ScenarioResolvable<Record<string, string>>;
          body: ScenarioResolvable<JSONValue>;
        }
      | {
          kind: "service-error";
          status: number;
          code: string;
          headers: ScenarioResolvable<Record<string, string>>;
          body: ScenarioResolvable<JSONValue>;
        }
      | {
          kind: "connection-loss";
          phase: "before-apply" | "after-apply";
          appliedEffect: ScenarioResolvable<JSONValue>;
        };
    externalEffect: ScenarioTemplate<JSONValue>;
  }>;
};

export type ProviderScenarioDescriptor = {
  version: 1;
  id: string;
  providerMember: "aws-ec2" | "aws-lambda" | "aws-codebuild" | "kubernetes";
  traces: string[];
  forbiddenAccountScalars: string[];
  taskContent: {
    entry: string;
    files: Record<string, string>;
    archiveSha256: string;
    treeSha256: string;
  };
  world: ScenarioWorld;
  acts: Array<{
    step: string;
    demand: ScenarioDemand;
    expectedAccount: ScenarioAccountExpectation;
    expectedWorld: {
      requests: Array<ScenarioExpectation<JSONValue>>;
      effects: ScenarioExpectation<JSONValue>;
      environmentCount: number;
    };
  }>;
};
