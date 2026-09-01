import type {
  FactoryExternalPullRequestRepairAdmissionPolicy,
  FactoryExternalPullRequestRepairFindingSelector
} from "@agentlab/contracts";

import type { FactoryExternalPullRequestRepairAdmissionCandidate } from "./factory-external-pull-request-repair-admission-repository.js";
import { factoryTimestampMilliseconds } from "./factory-timestamp.js";

export type FactoryExternalPullRequestRepairAdmissionAssessment =
  | {
      readonly status: "authorized";
      readonly reasonCodes: readonly ["external-repair-authorized"];
      readonly selectedFindings: readonly FactoryExternalPullRequestRepairFindingSelector[];
    }
  | { readonly status: "denied"; readonly reasonCodes: readonly string[] };

/** Pure policy decision shared by the service and the durable write boundary. */
export function assessExternalPullRequestRepairAdmission(
  candidate: FactoryExternalPullRequestRepairAdmissionCandidate,
  policy: FactoryExternalPullRequestRepairAdmissionPolicy,
  now: string
): FactoryExternalPullRequestRepairAdmissionAssessment {
  const run = candidate.feedbackRun.value;
  const bundle = run.bundle;
  const pullRequest = run.reviewRun.candidate;
  const nowMs = factoryTimestampMilliseconds(now);
  const reviewMs = factoryTimestampMilliseconds(bundle.createdAt);
  const reasons = [
    ...(run.repositoryId === policy.repositoryId ? [] : ["repository-not-admitted"]),
    ...(run.reviewPolicyDigest === policy.reviewPolicyDigest ? [] : ["review-policy-not-admitted"]),
    ...(run.feedbackPolicyDigest === policy.feedbackPolicyDigest
      ? []
      : ["feedback-policy-not-admitted"]),
    ...(bundle.decision === "changes-requested" ? [] : ["review-does-not-request-changes"]),
    ...(bundle.reviews.every(({ verdict }) => verdict === "changes-requested")
      ? []
      : ["review-quorum-not-unanimous"]),
    ...(policy.allowedAuthorAssociations.includes(pullRequest.author.association)
      ? []
      : ["author-association-not-admitted"]),
    ...(!pullRequest.fromFork || policy.allowForks ? [] : ["fork-repair-not-admitted"]),
    ...(pullRequest.filesComplete ? [] : ["changed-files-incomplete"]),
    ...(pullRequest.totalChangedFiles <= policy.maximumChangedFiles
      ? []
      : ["changed-file-limit-exceeded"]),
    ...(pullRequest.changedLines <= policy.maximumChangedLines
      ? []
      : ["changed-line-limit-exceeded"]),
    ...(nowMs >= reviewMs ? [] : ["repair-admission-clock-regression"]),
    ...(nowMs - reviewMs <= policy.maximumReviewAgeHours * 60 * 60 * 1_000
      ? []
      : ["review-evidence-expired"])
  ];
  const minimum = severityRank(policy.minimumFindingSeverity);
  const selectedFindings = bundle.reviews
    .flatMap((review) =>
      review.findings.flatMap((finding): FactoryExternalPullRequestRepairFindingSelector[] =>
        severityRank(finding.severity) >= minimum && finding.severity !== "low"
          ? [
              {
                reviewerId: review.reviewerId,
                findingId: finding.id,
                severity: finding.severity
              }
            ]
          : []
      )
    )
    .sort((left, right) =>
      compareText(
        `${left.reviewerId}\0${left.findingId}`,
        `${right.reviewerId}\0${right.findingId}`
      )
    );
  if (selectedFindings.length === 0) reasons.push("repair-finding-not-admitted");
  if (selectedFindings.length > policy.maximumFindings) {
    reasons.push("repair-finding-limit-exceeded");
  }
  if (reasons.length > 0) return { status: "denied", reasonCodes: uniqueSorted(reasons) };
  return {
    status: "authorized",
    reasonCodes: ["external-repair-authorized"],
    selectedFindings
  };
}

function severityRank(severity: "low" | "medium" | "high" | "critical"): number {
  return { low: 0, medium: 1, high: 2, critical: 3 }[severity];
}

function uniqueSorted(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort(compareText);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
