import type {
  FactoryAutonomousMergePolicy,
  FactoryPullRequestObservation
} from "@agentlab/contracts";

import { assessFactoryPullRequestObservation } from "./factory-pull-request-observation.js";
import { factoryTimestampDifferenceSeconds } from "./factory-timestamp.js";

export type FactoryAutonomousMergeAssessment =
  | { readonly status: "eligible"; readonly reasonCodes: readonly [] }
  | { readonly status: "denied"; readonly reasonCodes: readonly string[] };

/** Pure fail-closed selection over an exact broker-authenticated draft-head observation. */
export function assessFactoryAutonomousMerge(
  observation: FactoryPullRequestObservation,
  policy: FactoryAutonomousMergePolicy,
  now: string
): FactoryAutonomousMergeAssessment {
  const reasons = new Set<string>();
  const pullRequestAssessment = assessFactoryPullRequestObservation(observation);
  if (pullRequestAssessment.disposition !== "clear") {
    for (const reason of pullRequestAssessment.reasonCodes) reasons.add(reason);
    if (pullRequestAssessment.reasonCodes.length === 0) reasons.add("pull-request-not-clear");
  }
  if (observation.repositoryId !== policy.repositoryId) {
    reasons.add("merge-policy-repository-mismatch");
  }
  const ageSeconds = factoryTimestampDifferenceSeconds(observation.observedAt, now);
  if (ageSeconds < 0) reasons.add("pull-request-observation-from-future");
  if (ageSeconds > policy.maximumObservationAgeSeconds) {
    reasons.add("pull-request-observation-stale");
  }
  const expected = policy.requiredStatusChecks
    .map(({ context, producerId }) => `${context}\0${producerId}`)
    .toSorted();
  const actual = observation.trustedChecks
    .map(({ name, producerId }) => `${name}\0${producerId}`)
    .toSorted();
  if (!sameStrings(expected, actual)) reasons.add("trusted-check-set-mismatch");
  if (
    observation.trustedChecks.some(
      (check) => check.status !== "completed" || check.conclusion !== "success"
    )
  ) {
    reasons.add("trusted-check-not-successful");
  }
  const reasonCodes = [...reasons].toSorted();
  return reasonCodes.length === 0
    ? { status: "eligible", reasonCodes: [] }
    : { status: "denied", reasonCodes };
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
