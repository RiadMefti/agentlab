import type {
  FactoryPullRequestObservation,
  FactoryPullRequestRepairAuthorization
} from "@agentlab/contracts";

import {
  assessFactoryPullRequestObservation,
  latestExactHeadFactoryPullRequestReviews
} from "./factory-pull-request-observation.js";

type FailedCheck = FactoryPullRequestRepairAuthorization["failedChecks"][number];

export interface FactoryPullRequestRepairFeedback {
  readonly formalReviews: readonly {
    readonly reviewId: string;
    readonly authorLogin: string;
    readonly authorAssociation: string;
    readonly submittedAt: string | null;
    readonly untrustedBody: string;
  }[];
  readonly reviewComments: readonly {
    readonly commentId: string;
    readonly reviewId: string;
    readonly authorLogin: string;
    readonly path: string;
    readonly line: number | null;
    readonly side: "left" | "right" | null;
    readonly untrustedBody: string;
  }[];
  readonly failedChecks: FactoryPullRequestRepairAuthorization["failedChecks"];
}

export type FactoryPullRequestRepairSelection =
  | {
      readonly status: "selected";
      readonly reasonCodes: FactoryPullRequestRepairAuthorization["reasonCodes"];
      readonly selectedReviewIds: readonly string[];
      readonly selectedReviewCommentIds: readonly string[];
      readonly failedChecks: readonly FailedCheck[];
    }
  | {
      readonly status: "denied";
      readonly reasonCodes: readonly string[];
    };

const passingConclusions = new Set(["success", "neutral", "skipped"]);
const trustedHumanAssociations = new Set(["owner", "member", "collaborator"]);

/** Selects only structural actionable facts. Feedback text is never copied or interpreted. */
export function selectFactoryPullRequestRepair(
  observation: FactoryPullRequestObservation
): FactoryPullRequestRepairSelection {
  const assessment = assessFactoryPullRequestObservation(observation);
  if (assessment.disposition !== "actionable") {
    return {
      status: "denied",
      reasonCodes: uniqueSorted([
        `pull-request-observation-${assessment.disposition}`,
        ...assessment.reasonCodes
      ])
    };
  }

  const exactHeadChangeRequests = latestExactHeadFactoryPullRequestReviews(observation).filter(
    (review) => review.decision === "changes-requested"
  );
  const selectedReviews = exactHeadChangeRequests.filter(
    (review) =>
      review.author.kind === "human" && trustedHumanAssociations.has(review.author.association)
  );
  const selectedReviewIds = selectedReviews.map(({ reviewId }) => reviewId).sort(compareText);
  const selectedReviewIdSet = new Set(selectedReviewIds);
  const selectedReviewCommentIds = observation.reviewComments
    .filter(
      (comment) =>
        comment.headRevision === observation.remoteHeadRevision &&
        comment.reviewId !== null &&
        selectedReviewIdSet.has(comment.reviewId)
    )
    .map(({ commentId }) => commentId)
    .sort(compareText);
  const failedChecks = observation.trustedChecks
    .flatMap((check): FailedCheck[] => {
      if (
        check.status !== "completed" ||
        passingConclusions.has(check.conclusion) ||
        check.conclusion === "success" ||
        check.conclusion === "neutral" ||
        check.conclusion === "skipped"
      ) {
        return [];
      }
      return [
        {
          name: check.name,
          producerId: check.producerId,
          runId: check.runId,
          conclusion: check.conclusion
        }
      ];
    })
    .sort((left, right) =>
      compareText(
        `${left.name}\0${left.producerId}\0${left.runId}`,
        `${right.name}\0${right.producerId}\0${right.runId}`
      )
    );
  const reasonCodes = [
    ...(selectedReviewIds.length > 0 ? (["review-changes-requested"] as const) : []),
    ...(failedChecks.length > 0 ? (["trusted-check-failed"] as const) : [])
  ];
  if (reasonCodes.length === 0) {
    return {
      status: "denied",
      reasonCodes: [
        ...(exactHeadChangeRequests.length > 0 ? ["review-author-not-authorized"] : []),
        "pull-request-repair-cause-not-authorized"
      ].sort(compareText)
    };
  }
  return {
    status: "selected",
    reasonCodes,
    selectedReviewIds,
    selectedReviewCommentIds,
    failedChecks
  };
}

function uniqueSorted(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort(compareText);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
