import {
  factoryExternalPullRequestRepairAdmissionPolicySchema,
  type FactoryExternalPullRequestRepairAdmissionPolicy,
  type Sha256Digest
} from "@agentlab/contracts";

import type { CanonicalFactoryDocument } from "../../packages/runtime/src/domain/factory-documents.js";
import type { FactoryExternalPullRequestRepairAdmissionCandidate } from "../../packages/runtime/src/domain/factory-external-pull-request-repair-admission-repository.js";
import { testDigest } from "./factory.js";
import {
  completedExternalPullRequestFeedbackDocuments,
  testExternalPullRequestFeedbackFixture
} from "./factory-external-pull-request-feedback.js";

export function testExternalPullRequestRepairAdmissionFixture(
  options: {
    readonly allowForks?: boolean;
    readonly minimumFindingSeverity?: "medium" | "high" | "critical";
    readonly repairExecutionPolicyDigest?: Sha256Digest;
    readonly costPolicyDigest?: Sha256Digest;
    readonly roleIdentityPolicyDigest?: Sha256Digest;
    readonly gateProfileDigest?: Sha256Digest;
    readonly skillPackageDigests?: readonly [Sha256Digest, ...Sha256Digest[]];
  } = {}
) {
  const feedback = testExternalPullRequestFeedbackFixture({
    reviewDecision: "changes-requested"
  });
  const completedFeedback = completedExternalPullRequestFeedbackDocuments(feedback);
  const policy = factoryExternalPullRequestRepairAdmissionPolicySchema.parse({
    schemaVersion: "agentlab.external-pull-request-repair-admission-policy.v1",
    id: "agentlab/external-pull-request-repair-admission",
    version: "1.0.0",
    repositoryId: feedback.policy.repositoryId,
    reviewPolicyDigest: feedback.policy.reviewPolicyDigest,
    feedbackPolicyDigest: feedback.policyDocument.digest,
    repairExecutionPolicyDigest: options.repairExecutionPolicyDigest ?? testDigest("3"),
    costPolicyDigest: options.costPolicyDigest ?? testDigest("4"),
    roleIdentityPolicyDigest: options.roleIdentityPolicyDigest ?? testDigest("5"),
    gateProfileDigest: options.gateProfileDigest ?? testDigest("6"),
    skillPackageDigests: options.skillPackageDigests ?? [testDigest("7"), testDigest("8")],
    allowedAuthorAssociations: ["owner", "member", "collaborator", "contributor"],
    allowForks: options.allowForks ?? true,
    minimumFindingSeverity: options.minimumFindingSeverity ?? "medium",
    maximumFindings: 8,
    maximumChangedFiles: 20,
    maximumChangedLines: 500,
    maximumReviewAgeHours: 24,
    authorizationTtlSeconds: 900,
    maximumCandidatesPerTick: 3,
    maximumRiskTier: "R1"
  });
  const policyDocument = feedback.review.documents.externalPullRequestRepairAdmissionPolicy(policy);
  const candidate: FactoryExternalPullRequestRepairAdmissionCandidate = {
    feedbackRun: feedback.run,
    feedbackRecord: completedFeedback.record
  };
  return { feedback, completedFeedback, policy, policyDocument, candidate };
}

export type ExternalPullRequestRepairAdmissionFixture = ReturnType<
  typeof testExternalPullRequestRepairAdmissionFixture
>;
export type ExternalPullRequestRepairAdmissionPolicy =
  FactoryExternalPullRequestRepairAdmissionPolicy;
export type ExternalPullRequestRepairAdmissionPolicyDocument =
  CanonicalFactoryDocument<FactoryExternalPullRequestRepairAdmissionPolicy>;
