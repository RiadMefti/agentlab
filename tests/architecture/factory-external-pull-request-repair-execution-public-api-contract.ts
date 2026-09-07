import {
  createConfiguredLocalFactoryExternalPullRequestRepairExecution,
  createLocalFactoryExternalPullRequestRepairExecution,
  loadLocalFactoryExternalPullRequestRepairExecutionConfig,
  type FactoryExternalPullRequestRepairExecutionCommandPort,
  type LocalFactoryExternalPullRequestRepairExecutionConfig,
  type LocalFactoryExternalPullRequestRepairExecutionOptions,
  type LocalFactoryExternalPullRequestRepairExecutionRuntime
} from "@agentlab/runtime/factory-external-pull-request-repair-execution";
// @ts-expect-error Repair execution must not be exported by the interactive runtime.
import { createLocalFactoryExternalPullRequestRepairExecution as forbiddenInteractive } from "@agentlab/runtime";
// @ts-expect-error The GitHub broker must not expose credentialless repair execution.
import { createLocalFactoryExternalPullRequestRepairExecution as forbiddenBroker } from "@agentlab/runtime/factory-broker";
// @ts-expect-error The general worker must not consume external repair authorizations.
import { createLocalFactoryExternalPullRequestRepairExecution as forbiddenWorker } from "@agentlab/runtime/factory-worker";
// @ts-expect-error Repair execution must not expose the feedback credential boundary.
import { createLocalFactoryExternalPullRequestFeedback as forbiddenFeedback } from "@agentlab/runtime/factory-external-pull-request-repair-execution";
// @ts-expect-error Repair execution must not expose remote PR publication.
import { createLocalFactoryBroker as forbiddenRemoteBroker } from "@agentlab/runtime/factory-external-pull-request-repair-execution";

type Equal<Left, Right> = [Left] extends [Right]
  ? [Right] extends [Left]
    ? [keyof Left] extends [keyof Right]
      ? [keyof Right] extends [keyof Left]
        ? true
        : false
      : false
    : false
  : false;
type Assert<Value extends true> = Value;

export type FactoryExternalPullRequestRepairExecutionPublicApiAssertions = [
  Assert<Equal<keyof FactoryExternalPullRequestRepairExecutionCommandPort, "preflight" | "tick">>,
  Assert<Equal<keyof LocalFactoryExternalPullRequestRepairExecutionRuntime, "commands" | "close">>,
  Assert<
    Equal<
      typeof createLocalFactoryExternalPullRequestRepairExecution,
      (
        options: LocalFactoryExternalPullRequestRepairExecutionOptions
      ) => LocalFactoryExternalPullRequestRepairExecutionRuntime
    >
  >,
  Assert<
    Equal<
      typeof createConfiguredLocalFactoryExternalPullRequestRepairExecution,
      (
        config: LocalFactoryExternalPullRequestRepairExecutionConfig
      ) => LocalFactoryExternalPullRequestRepairExecutionRuntime
    >
  >,
  Assert<
    Equal<
      typeof loadLocalFactoryExternalPullRequestRepairExecutionConfig,
      (pathInput: string) => Promise<LocalFactoryExternalPullRequestRepairExecutionConfig>
    >
  >
];

void forbiddenInteractive;
void forbiddenBroker;
void forbiddenWorker;
void forbiddenFeedback;
void forbiddenRemoteBroker;
