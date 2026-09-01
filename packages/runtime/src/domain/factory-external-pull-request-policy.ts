import type {
  FactoryExternalPullRequestCandidate,
  FactoryExternalPullRequestDiscoveryPolicy
} from "@agentlab/contracts";

import type { FactoryExternalPullRequestRemoteItem } from "./factory-external-pull-request-source.js";
import { factoryTimestampMilliseconds } from "./factory-timestamp.js";
import { repositoryPathMatches } from "./repository-path-policy.js";

const millisecondsPerDay = 86_400_000;

/** Deterministic classification only; its output is evidence and never a repair capability. */
export function classifyExternalPullRequest(input: {
  readonly pullRequest: FactoryExternalPullRequestRemoteItem;
  readonly policy: FactoryExternalPullRequestDiscoveryPolicy;
  readonly factoryOwned: boolean;
  readonly observedAt: string;
}): FactoryExternalPullRequestCandidate {
  const { pullRequest, policy } = input;
  if (input.factoryOwned) {
    return {
      ...pullRequest,
      disposition: "factory-owned",
      reasonCodes: ["factory-owned-pull-request"]
    };
  }
  if (pullRequest.draft && !policy.includeDrafts) {
    return {
      ...pullRequest,
      disposition: "deferred",
      reasonCodes: ["draft-pull-request-deferred"]
    };
  }

  const reasons: string[] = [];
  if (!policy.allowedBaseBranches.includes(pullRequest.base.branchName)) {
    reasons.push("base-branch-not-admitted");
  }
  if (pullRequest.head.repositoryId === null) reasons.push("head-repository-unavailable");
  if (!pullRequest.filesComplete) reasons.push("changed-file-inventory-incomplete");
  if (pullRequest.totalChangedFiles > policy.maximumChangedFilesForAgentReview) {
    reasons.push("changed-file-ceiling-exceeded");
  }
  if (pullRequest.changedLines > policy.maximumChangedLinesForAgentReview) {
    reasons.push("changed-line-ceiling-exceeded");
  }
  if (!policy.agentReviewAssociations.includes(pullRequest.author.association)) {
    reasons.push("author-association-not-admitted");
  }
  if (
    pullRequest.changedFiles.some(({ path, previousPath }) =>
      policy.protectedPaths.some(
        (pattern) =>
          repositoryPathMatches(path, pattern) ||
          (previousPath !== null && repositoryPathMatches(previousPath, pattern))
      )
    )
  ) {
    reasons.push("protected-path-change");
  }
  const ageMilliseconds =
    factoryTimestampMilliseconds(input.observedAt) -
    factoryTimestampMilliseconds(pullRequest.createdAt);
  if (ageMilliseconds > policy.maximumAgeDays * millisecondsPerDay) {
    reasons.push("pull-request-age-ceiling-exceeded");
  }
  return {
    ...pullRequest,
    disposition: reasons.length === 0 ? "agent-review-candidate" : "human-review-required",
    reasonCodes:
      reasons.length === 0 ? ["read-only-agent-review-candidate"] : [...new Set(reasons)].sort()
  };
}
