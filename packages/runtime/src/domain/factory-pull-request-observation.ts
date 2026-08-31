import type { FactoryPullRequestObservation } from "@agentlab/contracts";

export type FactoryPullRequestDisposition = "clear" | "pending" | "actionable" | "unsafe";

export interface FactoryPullRequestAssessment {
  readonly disposition: FactoryPullRequestDisposition;
  readonly reasonCodes: readonly string[];
}

const passingConclusions = new Set(["success", "neutral", "skipped"]);

/** Deterministic facts-only assessment; it never interprets feedback text as an instruction. */
export function assessFactoryPullRequestObservation(
  observation: FactoryPullRequestObservation
): FactoryPullRequestAssessment {
  const unsafe: string[] = [];
  if (observation.state !== "open") unsafe.push("pull-request-closed");
  if (observation.merged) unsafe.push("pull-request-already-merged");
  if (!observation.draft) unsafe.push("pull-request-not-draft");
  if (observation.remoteHeadRevision !== observation.recordedHeadRevision) {
    unsafe.push("pull-request-head-drift");
  }
  if (observation.remoteBaseRevision !== observation.authorizedBaseRevision) {
    unsafe.push("pull-request-base-drift");
  }
  if (unsafe.length > 0) return assessment("unsafe", unsafe);

  const latestReviews = latestExactHeadFactoryPullRequestReviews(observation);
  const changesRequested = latestReviews.some((review) => review.decision === "changes-requested");
  const failingCheck = observation.trustedChecks.some(
    (check) => check.status === "completed" && !passingConclusions.has(check.conclusion)
  );
  if (changesRequested || failingCheck) {
    return assessment("actionable", [
      ...(changesRequested ? ["review-changes-requested"] : []),
      ...(failingCheck ? ["trusted-check-failed"] : [])
    ]);
  }

  const pendingCheck = observation.trustedChecks.some((check) => check.status !== "completed");
  const unclassifiedFeedback =
    observation.conversationComments.length > 0 ||
    observation.reviewComments.some(
      (comment) => comment.headRevision === observation.remoteHeadRevision
    ) ||
    latestReviews.some(
      (review) => review.decision === "commented" || review.untrustedBody.trim().length > 0
    );
  if (pendingCheck || unclassifiedFeedback) {
    return assessment("pending", [
      ...(pendingCheck ? ["trusted-check-pending"] : []),
      ...(unclassifiedFeedback ? ["untrusted-feedback-awaiting-classification"] : [])
    ]);
  }
  return assessment("clear", []);
}

export function latestExactHeadFactoryPullRequestReviews(
  observation: FactoryPullRequestObservation
) {
  const latest = new Map<
    string,
    {
      readonly submittedAt: string;
      readonly reviews: FactoryPullRequestObservation["reviews"][number][];
    }
  >();
  for (const review of observation.reviews) {
    if (review.headRevision !== observation.remoteHeadRevision || review.submittedAt === null) {
      continue;
    }
    const prior = latest.get(review.author.externalId);
    if (prior === undefined || review.submittedAt > prior.submittedAt) {
      latest.set(review.author.externalId, { submittedAt: review.submittedAt, reviews: [review] });
    } else if (review.submittedAt === prior.submittedAt) {
      prior.reviews.push(review);
    }
  }
  return [...latest.values()].flatMap(({ reviews }) => reviews);
}

function assessment(
  disposition: FactoryPullRequestDisposition,
  reasonCodes: readonly string[]
): FactoryPullRequestAssessment {
  return { disposition, reasonCodes: [...new Set(reasonCodes)].sort() };
}
