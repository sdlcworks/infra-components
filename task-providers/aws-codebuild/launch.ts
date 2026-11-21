import { StartBuildCommand } from "@aws-sdk/client-codebuild";
import {
  taskProviderLostAnswer,
  taskProviderRefusal,
  type TaskEnactmentAccount,
  type TaskRealizationContext,
} from "@sdlcworks/components/task";
import {
  awsConfigurationDigest,
  classifyAwsError,
  selectRunner,
  sha256,
  stageAwsDelivery,
} from "../aws-common";
import {
  codeBuildCarriageProgram,
  renderCodeBuildBuildspec,
} from "./buildspec";
import type { AwsCodeBuildDependencies } from "./client";
import { recoverBuild } from "./recovery";
import type {
  AwsCodeBuildAllocationState,
  AwsCodeBuildConfiguration,
  AwsCodeBuildCredentials,
  AwsCodeBuildRunState,
} from "./schema";
type Context = TaskRealizationContext<
  AwsCodeBuildConfiguration,
  AwsCodeBuildCredentials,
  AwsCodeBuildAllocationState,
  AwsCodeBuildRunState
>;
const account = (
  c: Context,
  x: any,
): TaskEnactmentAccount<AwsCodeBuildAllocationState, AwsCodeBuildRunState> => ({
  version: 1,
  actIdentity: c.actIdentity,
  runId: c.runId,
  allocationState: c.allocationState,
  runState: c.runState,
  providerTestimony: { kind: "silent" },
  environmentStatus: c.environmentStatus,
  retention: null,
  outcome: { kind: "witnessed" },
  ...x,
});
const vars = (s: AwsCodeBuildRunState) =>
  [
    { name: "SDLC_TASK_PROTOCOL", value: "1", type: "PLAINTEXT" as const },
    {
      name: "SDLC_TASK_RUN_DIGEST",
      value: sha256(s.runId),
      type: "PLAINTEXT" as const,
    },
    {
      name: "SDLC_TASK_PROJECT_DIGEST",
      value: s.projectShapeDigest,
      type: "PLAINTEXT" as const,
    },
    {
      name: "SDLC_TASK_DELIVERY_URI",
      value: `s3://${s.carriage.bucket}/${s.carriage.runPrefix}/delivery.json`,
      type: "PLAINTEXT" as const,
    },
    {
      name: "SDLC_TASK_DELIVERY_DIGEST",
      value: s.deliveryDigest,
      type: "PLAINTEXT" as const,
    },
    {
      name: "SDLC_TASK_ARCHIVE_SHA256",
      value: s.carriage.archiveSha256,
      type: "PLAINTEXT" as const,
    },
    {
      name: "SDLC_TASK_TREE_SHA256",
      value: s.carriage.treeSha256,
      type: "PLAINTEXT" as const,
    },
    {
      name: "SDLC_TASK_CARRIAGE_PATH",
      value: `/${s.carriage.runPrefix}/guest/carriage.mjs`,
      type: "PLAINTEXT" as const,
    },
  ].sort((a, b) => a.name.localeCompare(b.name));
export const isTrustedStartBuildResponse = (
  build:
    | {
        id?: string;
        arn?: string;
        projectName?: string;
        environment?: {
          environmentVariables?: Array<{
            name?: string;
            value?: string;
            type?: string;
          }>;
        };
      }
    | undefined,
  state: AwsCodeBuildRunState,
) => {
  if (!build) return false;
  const environmentVariables = build?.environment?.environmentVariables;
  if (!Array.isArray(environmentVariables)) return false;
  const normalized = environmentVariables.map((variable) =>
    typeof variable.name === "string" &&
    typeof variable.value === "string" &&
    variable.type === "PLAINTEXT"
      ? { name: variable.name, value: variable.value, type: variable.type }
      : null,
  );
  const validVariables = normalized.filter(
    (variable): variable is NonNullable<typeof variable> => variable !== null,
  );
  return Boolean(
    build.id &&
      build.arn &&
      build.projectName === state.projectName &&
      validVariables.length === normalized.length &&
      JSON.stringify(
        validVariables.sort((left, right) => left.name.localeCompare(right.name)),
      ) === JSON.stringify(vars(state)),
  );
};
export function createLaunch(d: AwsCodeBuildDependencies) {
  return async (c: Context) => {
    if (!c.allocationState)
      return account(c, {
        outcome: taskProviderRefusal(
          "aws-codebuild-allocation-state-required",
          null,
        ),
      });
    if (c.runState) {
      if (c.runState.launch === "accepted") return account(c, {});
      try {
        const found = await recoverBuild(d, c.runState);
        return found
          ? account(c, {
              runState: {
                ...c.runState,
                buildId: found.id,
                launch: "accepted",
              },
              providerTestimony: {
                kind: "witnessed",
                standing: "pending",
                observedAt: d.now().toISOString(),
                native: JSON.parse(JSON.stringify(found)),
              },
            })
          : account(c, {
              outcome: taskProviderLostAnswer("aws-codebuild-start-build", {
                projectName: c.runState.projectName,
              }),
            });
      } catch (e) {
        return account(c, { outcome: e });
      }
    }
    if (
      c.allocationState.configurationDigest !==
      awsConfigurationDigest(c.configuration)
    )
      return account(c, {
        outcome: taskProviderRefusal("aws-codebuild-configuration-drift", null),
      });
    try {
      const runner = selectRunner(
        c.allocationState.qualifiedConstraintEnvelope.architecture,
        c.runners,
      );
      const carriage = await stageAwsDelivery({
        s3: d.s3,
        carriage: c.configuration.statusCarriage,
        runId: c.runId,
        configuration: c.configuration,
        definition: c.definition,
        inputDocument: c.inputDocument,
        runner,
        guestProgram: codeBuildCarriageProgram,
        fetchContent: d.fetchContent,
      });
      const state: AwsCodeBuildRunState = {
        version: 1,
        runId: c.runId,
        configurationDigest: c.allocationState.configurationDigest,
        projectName: c.allocationState.project.name,
        projectArn: c.allocationState.project.arn,
        projectShapeDigest: c.allocationState.project.shapeDigest,
        idempotencyToken: sha256(`sdlc-task-codebuild-v1\0${c.runId}`),
        buildId: null,
        launch: "lost-answer",
        deliveryDigest: carriage.deliverySha256,
        carriage,
        lastProviderStatus: null,
      };
      const input = {
        projectName: state.projectName,
        idempotencyToken: state.idempotencyToken,
        sourceTypeOverride: "NO_SOURCE" as const,
        artifactsOverride: { type: "NO_ARTIFACTS" as const },
        autoRetryLimitOverride: 0,
        timeoutInMinutesOverride:
          c.configuration.project.expected.nativeLimits.timeoutMinutes,
        queuedTimeoutInMinutesOverride:
          c.configuration.project.expected.nativeLimits.queuedTimeoutMinutes,
        buildspecOverride: renderCodeBuildBuildspec(),
        environmentVariablesOverride: vars(state),
      };
      let out: any;
      try {
        out = await d.codebuild.send(new StartBuildCommand(input));
      } catch (e) {
        const classified = classifyAwsError("StartBuild", "mutation", e);
        return account(c, {
          runState: state,
          outcome:
            classified.kind === "refusal"
              ? classified
              : taskProviderLostAnswer("aws-codebuild-start-build", {
                  projectName: state.projectName,
                }),
        });
      }
      const b = out.build;
      if (!isTrustedStartBuildResponse(b, state))
        return account(c, {
          runState: state,
          outcome: taskProviderLostAnswer("aws-codebuild-start-build", {
            projectName: state.projectName,
          }),
        });
      return account(c, {
        runState: { ...state, buildId: b.id, launch: "accepted" },
        providerTestimony: {
          kind: "witnessed",
          standing: "pending",
          observedAt: d.now().toISOString(),
          native: JSON.parse(JSON.stringify(b)),
        },
      });
    } catch (e) {
      return account(c, {
        outcome:
          e && typeof e === "object" && "kind" in e
            ? e
            : classifyAwsError("StartBuild", "mutation", e),
      });
    }
  };
}
