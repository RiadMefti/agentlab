import type { EvidenceItem } from "@agentlab/contracts";

import type { FactoryRepositoryGovernance } from "../domain/factory-pull-request-broker.js";

export function factoryRepositoryGovernanceDenials(
  governance: FactoryRepositoryGovernance
): readonly string[] {
  const reasons: string[] = [];
  if (!governance.requiresPullRequest) reasons.push("repository-pr-rule-missing");
  if (governance.requiredApprovals < 1) reasons.push("repository-approval-rule-too-weak");
  if (!governance.dismissesStaleReviews) reasons.push("repository-stale-review-rule-missing");
  if (!governance.requiresCodeOwnerReviews) {
    reasons.push("repository-code-owner-review-rule-missing");
  }
  if (!governance.requiresLastPushApproval) reasons.push("repository-last-push-rule-missing");
  if (!governance.enforcesAdmins) reasons.push("repository-admin-bypass-enabled");
  if (governance.allowsForcePushes) reasons.push("repository-force-push-enabled");
  if (governance.allowsDeletions) reasons.push("repository-branch-deletion-enabled");
  if (!governance.requiredStatusChecks.includes("verify")) {
    reasons.push("repository-verify-check-missing");
  }
  if (!governance.requiredStatusChecks.includes("factory-sandbox")) {
    reasons.push("repository-factory-sandbox-check-missing");
  }
  return reasons.sort();
}

export function requireExactPolicyItem(
  items: readonly EvidenceItem[],
  subjectDigest: string,
  policyEvaluationDigest?: string
): EvidenceItem {
  const item = items.find(
    (candidate) =>
      candidate.kind === "policy" &&
      candidate.result === "pass" &&
      candidate.subjectDigest === subjectDigest &&
      (policyEvaluationDigest === undefined ||
        candidate.artifact.digest === policyEvaluationDigest) &&
      candidate.producer.kind === "control-plane" &&
      candidate.producer.role === "policy-engine"
  );
  if (item === undefined) throw new Error("Policy allow evidence is missing from its own bundle.");
  return item;
}
