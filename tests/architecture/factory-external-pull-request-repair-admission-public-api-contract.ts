import {
  createConfiguredLocalFactoryExternalPullRequestRepairAdmission,
  createLocalFactoryExternalPullRequestRepairAdmission,
  loadLocalFactoryExternalPullRequestRepairAdmissionConfig,
  type FactoryExternalPullRequestRepairAdmissionCommandPort,
  type LocalFactoryExternalPullRequestRepairAdmissionConfig,
  type LocalFactoryExternalPullRequestRepairAdmissionOptions,
  type LocalFactoryExternalPullRequestRepairAdmissionRuntime
} from "@agentlab/runtime/factory-external-pull-request-repair-admission";
// @ts-expect-error Admission authority must not be exported by the interactive runtime.
import { createLocalFactoryExternalPullRequestRepairAdmission as forbiddenInteractive } from "@agentlab/runtime";
// @ts-expect-error The GitHub broker must not expose external repair admission.
import { createLocalFactoryExternalPullRequestRepairAdmission as forbiddenBroker } from "@agentlab/runtime/factory-broker";
// @ts-expect-error Model-bearing workers must not issue their own repair authority.
import { createLocalFactoryExternalPullRequestRepairAdmission as forbiddenWorker } from "@agentlab/runtime/factory-worker";
// @ts-expect-error Deterministic admission must not expose feedback publication.
import { createLocalFactoryExternalPullRequestFeedback as forbiddenFeedback } from "@agentlab/runtime/factory-external-pull-request-repair-admission";
// @ts-expect-error Deterministic admission must not expose provider-backed review.
import { createLocalFactoryExternalPullRequestReview as forbiddenReview } from "@agentlab/runtime/factory-external-pull-request-repair-admission";

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

export type FactoryExternalPullRequestRepairAdmissionPublicApiAssertions = [
  Assert<Equal<keyof FactoryExternalPullRequestRepairAdmissionCommandPort, "preflight" | "tick">>,
  Assert<Equal<keyof LocalFactoryExternalPullRequestRepairAdmissionRuntime, "commands" | "close">>,
  Assert<
    Equal<
      typeof createLocalFactoryExternalPullRequestRepairAdmission,
      (
        options: LocalFactoryExternalPullRequestRepairAdmissionOptions
      ) => LocalFactoryExternalPullRequestRepairAdmissionRuntime
    >
  >,
  Assert<
    Equal<
      typeof createConfiguredLocalFactoryExternalPullRequestRepairAdmission,
      (
        config: LocalFactoryExternalPullRequestRepairAdmissionConfig
      ) => LocalFactoryExternalPullRequestRepairAdmissionRuntime
    >
  >,
  Assert<
    Equal<
      typeof loadLocalFactoryExternalPullRequestRepairAdmissionConfig,
      (pathInput: string) => Promise<LocalFactoryExternalPullRequestRepairAdmissionConfig>
    >
  >
];

void forbiddenInteractive;
void forbiddenBroker;
void forbiddenWorker;
void forbiddenFeedback;
void forbiddenReview;
