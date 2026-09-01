import {
  createConfiguredLocalFactoryExternalPullRequestFeedback,
  createLocalFactoryExternalPullRequestFeedback,
  loadLocalFactoryExternalPullRequestFeedbackConfig,
  type FactoryExternalPullRequestFeedbackCommandPort,
  type LocalFactoryExternalPullRequestFeedbackConfig,
  type LocalFactoryExternalPullRequestFeedbackOptions,
  type LocalFactoryExternalPullRequestFeedbackRuntime
} from "@agentlab/runtime/factory-external-pull-request-feedback";
// @ts-expect-error Feedback publication must not be exported by the interactive runtime.
import { createLocalFactoryExternalPullRequestFeedback as forbiddenInteractive } from "@agentlab/runtime";
// @ts-expect-error The branch-writing broker must not expose external feedback publication.
import { createLocalFactoryExternalPullRequestFeedback as forbiddenBroker } from "@agentlab/runtime/factory-broker";
// @ts-expect-error Model-bearing workers must not expose GitHub feedback credentials.
import { createLocalFactoryExternalPullRequestFeedback as forbiddenWorker } from "@agentlab/runtime/factory-worker";
// @ts-expect-error The feedback boundary must not expose provider-backed review production.
import { createLocalFactoryExternalPullRequestReview as forbiddenReviewer } from "@agentlab/runtime/factory-external-pull-request-feedback";
// @ts-expect-error The feedback boundary must not expose draft, branch, merge, or release authority.
import { createLocalFactoryBroker as forbiddenDraftBroker } from "@agentlab/runtime/factory-external-pull-request-feedback";

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

export type FactoryExternalPullRequestFeedbackPublicApiAssertions = [
  Assert<Equal<keyof FactoryExternalPullRequestFeedbackCommandPort, "preflight" | "tick">>,
  Assert<Equal<keyof LocalFactoryExternalPullRequestFeedbackRuntime, "commands" | "close">>,
  Assert<
    Equal<
      typeof createLocalFactoryExternalPullRequestFeedback,
      (
        options: LocalFactoryExternalPullRequestFeedbackOptions
      ) => LocalFactoryExternalPullRequestFeedbackRuntime
    >
  >,
  Assert<
    Equal<
      typeof createConfiguredLocalFactoryExternalPullRequestFeedback,
      (
        config: LocalFactoryExternalPullRequestFeedbackConfig
      ) => LocalFactoryExternalPullRequestFeedbackRuntime
    >
  >,
  Assert<
    Equal<
      typeof loadLocalFactoryExternalPullRequestFeedbackConfig,
      (pathInput: string) => Promise<LocalFactoryExternalPullRequestFeedbackConfig>
    >
  >
];

void forbiddenInteractive;
void forbiddenBroker;
void forbiddenWorker;
void forbiddenReviewer;
void forbiddenDraftBroker;
