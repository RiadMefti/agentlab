import {
  createConfiguredLocalFactoryExternalPullRequestRepairQualification,
  createLocalFactoryExternalPullRequestRepairQualification,
  loadLocalFactoryExternalPullRequestRepairQualificationConfig,
  type FactoryExternalPullRequestRepairQualificationCommandPort,
  type LocalFactoryExternalPullRequestRepairQualificationConfig,
  type LocalFactoryExternalPullRequestRepairQualificationOptions,
  type LocalFactoryExternalPullRequestRepairQualificationRuntime
} from "@agentlab/runtime/factory-external-pull-request-repair-qualification";
// @ts-expect-error Qualification must not be exported by the interactive runtime.
import { createLocalFactoryExternalPullRequestRepairQualification as forbiddenInteractive } from "@agentlab/runtime";
// @ts-expect-error The GitHub broker must not expose credentialless qualification.
import { createLocalFactoryExternalPullRequestRepairQualification as forbiddenBroker } from "@agentlab/runtime/factory-broker";
// @ts-expect-error The general worker must not consume external repair bundles.
import { createLocalFactoryExternalPullRequestRepairQualification as forbiddenWorker } from "@agentlab/runtime/factory-worker";
// @ts-expect-error Qualification must not expose the feedback credential boundary.
import { createLocalFactoryExternalPullRequestFeedback as forbiddenFeedback } from "@agentlab/runtime/factory-external-pull-request-repair-qualification";
// @ts-expect-error Qualification must not expose remote PR publication.
import { createLocalFactoryBroker as forbiddenRemoteBroker } from "@agentlab/runtime/factory-external-pull-request-repair-qualification";

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

export type FactoryExternalPullRequestRepairQualificationPublicApiAssertions = [
  Assert<
    Equal<keyof FactoryExternalPullRequestRepairQualificationCommandPort, "preflight" | "tick">
  >,
  Assert<
    Equal<keyof LocalFactoryExternalPullRequestRepairQualificationRuntime, "commands" | "close">
  >,
  Assert<
    Equal<
      typeof createLocalFactoryExternalPullRequestRepairQualification,
      (
        options: LocalFactoryExternalPullRequestRepairQualificationOptions
      ) => LocalFactoryExternalPullRequestRepairQualificationRuntime
    >
  >,
  Assert<
    Equal<
      typeof createConfiguredLocalFactoryExternalPullRequestRepairQualification,
      (
        config: LocalFactoryExternalPullRequestRepairQualificationConfig
      ) => LocalFactoryExternalPullRequestRepairQualificationRuntime
    >
  >,
  Assert<
    Equal<
      typeof loadLocalFactoryExternalPullRequestRepairQualificationConfig,
      (pathInput: string) => Promise<LocalFactoryExternalPullRequestRepairQualificationConfig>
    >
  >
];

void forbiddenInteractive;
void forbiddenBroker;
void forbiddenWorker;
void forbiddenFeedback;
void forbiddenRemoteBroker;
