import {
  createConfiguredLocalFactoryExternalPullRequestReview,
  createLocalFactoryExternalPullRequestReview,
  loadLocalFactoryExternalPullRequestReviewConfig,
  type FactoryExternalPullRequestReviewCommandPort,
  type LocalFactoryExternalPullRequestReviewConfig,
  type LocalFactoryExternalPullRequestReviewOptions,
  type LocalFactoryExternalPullRequestReviewRuntime
} from "@agentlab/runtime/factory-external-pull-request-review";
// @ts-expect-error External review production must not be exported by the interactive runtime.
import { createLocalFactoryExternalPullRequestReview as forbiddenInteractive } from "@agentlab/runtime";
// @ts-expect-error Review production must not be exported by the credential-bearing broker.
import { createLocalFactoryExternalPullRequestReview as forbiddenBroker } from "@agentlab/runtime/factory-broker";
// @ts-expect-error The general worker must not reach the external-review journal.
import { createLocalFactoryExternalPullRequestReview as forbiddenWorker } from "@agentlab/runtime/factory-worker";
// @ts-expect-error External review production must not expose remote discovery credentials.
import { createLocalFactoryExternalPullRequestDiscovery as forbiddenReader } from "@agentlab/runtime/factory-external-pull-request-review";
// @ts-expect-error External review production must not expose broker draft creation.
import { createLocalFactoryBroker as forbiddenWriter } from "@agentlab/runtime/factory-external-pull-request-review";

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

export type FactoryExternalPullRequestReviewPublicApiAssertions = [
  Assert<Equal<keyof FactoryExternalPullRequestReviewCommandPort, "preflight" | "tick">>,
  Assert<Equal<keyof LocalFactoryExternalPullRequestReviewRuntime, "commands" | "close">>,
  Assert<
    Equal<
      typeof createLocalFactoryExternalPullRequestReview,
      (
        options: LocalFactoryExternalPullRequestReviewOptions
      ) => LocalFactoryExternalPullRequestReviewRuntime
    >
  >,
  Assert<
    Equal<
      typeof createConfiguredLocalFactoryExternalPullRequestReview,
      (
        config: LocalFactoryExternalPullRequestReviewConfig
      ) => LocalFactoryExternalPullRequestReviewRuntime
    >
  >,
  Assert<
    Equal<
      typeof loadLocalFactoryExternalPullRequestReviewConfig,
      (pathInput: string) => Promise<LocalFactoryExternalPullRequestReviewConfig>
    >
  >
];

void forbiddenInteractive;
void forbiddenBroker;
void forbiddenWorker;
void forbiddenReader;
void forbiddenWriter;
