import type {
  FactoryExternalPullRequestRepairAdmissionPolicy,
  FactoryExternalPullRequestRepairAuthorization,
  FactoryExternalPullRequestRepairDecision
} from "@agentlab/contracts";

import { factoryTimestampAddSeconds, factoryTimestampMilliseconds } from "./factory-timestamp.js";
import { assertExternalPullRequestFeedbackRun } from "./factory-external-pull-request-feedback-integrity.js";
import { assessExternalPullRequestRepairAdmission } from "./factory-external-pull-request-repair-admission-policy.js";
import type { FactoryExternalPullRequestRepairAdmissionCandidate } from "./factory-external-pull-request-repair-admission-repository.js";
import type { CanonicalFactoryDocument, FactoryDocumentCodec } from "./factory-documents.js";

type PolicyDocument = CanonicalFactoryDocument<FactoryExternalPullRequestRepairAdmissionPolicy>;
type AuthorizationDocument =
  CanonicalFactoryDocument<FactoryExternalPullRequestRepairAuthorization>;
type DecisionDocument = CanonicalFactoryDocument<FactoryExternalPullRequestRepairDecision>;

type Documents = Pick<
  FactoryDocumentCodec,
  | "externalPullRequestFeedbackPolicy"
  | "externalPullRequestFeedbackRecord"
  | "externalPullRequestFeedbackRun"
  | "externalPullRequestRepairAdmissionPolicy"
  | "externalPullRequestRepairAuthorization"
  | "externalPullRequestReviewBundle"
  | "externalPullRequestReviewRun"
>;

export function assertExternalPullRequestRepairAdmissionCandidate(
  candidate: FactoryExternalPullRequestRepairAdmissionCandidate,
  documents: Documents
): void {
  const run = candidate.feedbackRun;
  const record = candidate.feedbackRecord;
  assertExternalPullRequestFeedbackRun(run, documents);
  if (
    documents.externalPullRequestFeedbackRun(run.value).digest !== run.digest ||
    documents.externalPullRequestFeedbackRecord(record.value).digest !== record.digest ||
    record.value.publicationRunId !== run.value.publicationRunId ||
    record.value.runDigest !== run.digest ||
    record.value.repositoryId !== run.value.repositoryId ||
    record.value.pullRequestNumber !== run.value.pullRequestNumber ||
    record.value.bundleDigest !== run.value.bundleDigest ||
    record.value.headRevision !== run.value.expectedHeadRevision
  ) {
    throw new Error("External repair admission candidate failed completed-feedback lineage.");
  }
}

export function assertExternalPullRequestRepairAuthorization(
  policy: PolicyDocument,
  candidate: FactoryExternalPullRequestRepairAdmissionCandidate,
  authorization: AuthorizationDocument,
  documents: Documents
): void {
  assertExternalPullRequestRepairAdmissionCandidate(candidate, documents);
  const run = candidate.feedbackRun;
  const record = candidate.feedbackRecord;
  const value = authorization.value;
  if (
    documents.externalPullRequestRepairAdmissionPolicy(policy.value).digest !== policy.digest ||
    value.feedbackPublicationRunDigest !== run.digest ||
    value.feedbackRecordDigest !== record.digest ||
    value.feedbackPublicationRunId !== run.value.publicationRunId ||
    value.reviewRunId !== run.value.reviewRunId ||
    value.reviewRunDigest !== run.value.reviewRunDigest ||
    value.bundleDigest !== run.value.bundleDigest ||
    value.pullRequestNumber !== run.value.pullRequestNumber ||
    value.admissionPolicyDigest !== policy.digest ||
    value.repositoryId !== policy.value.repositoryId ||
    value.reviewPolicyDigest !== policy.value.reviewPolicyDigest ||
    value.feedbackPolicyDigest !== policy.value.feedbackPolicyDigest ||
    value.repairExecutionPolicyDigest !== policy.value.repairExecutionPolicyDigest ||
    value.costPolicyDigest !== policy.value.costPolicyDigest ||
    value.roleIdentityPolicyDigest !== policy.value.roleIdentityPolicyDigest ||
    value.gateProfileDigest !== policy.value.gateProfileDigest ||
    !sameStrings(value.skillPackageDigests, policy.value.skillPackageDigests) ||
    value.expectedBaseRevision !== run.value.expectedBaseRevision ||
    value.expectedHeadRevision !== run.value.expectedHeadRevision ||
    value.patchDigest !== run.value.bundle.patchDigest ||
    value.fromFork !== run.value.reviewRun.candidate.fromFork ||
    value.headRepositoryId !== run.value.reviewRun.candidate.head.repositoryId ||
    value.headBranchName !== run.value.reviewRun.candidate.head.branchName ||
    value.expiresAt !==
      factoryTimestampAddSeconds(value.createdAt, policy.value.authorizationTtlSeconds)
  ) {
    throw new Error("External repair authorization changed its reviewed policy or feedback root.");
  }
  const findings = new Map(
    run.value.bundle.reviews.flatMap((review) =>
      review.findings.map(
        (finding) => [`${review.reviewerId}\0${finding.id}`, finding.severity] as const
      )
    )
  );
  if (
    value.selectedFindings.length > policy.value.maximumFindings ||
    value.selectedFindings.some(
      (selector) =>
        findings.get(`${selector.reviewerId}\0${selector.findingId}`) !== selector.severity
    )
  ) {
    throw new Error("External repair authorization selects absent or excessive findings.");
  }
}

export function assertExternalPullRequestRepairDecision(
  policy: PolicyDocument,
  candidate: FactoryExternalPullRequestRepairAdmissionCandidate,
  decision: DecisionDocument,
  authorization: AuthorizationDocument | null,
  documents: Documents,
  trustedNow: string
): void {
  assertExternalPullRequestRepairAdmissionCandidate(candidate, documents);
  const run = candidate.feedbackRun;
  const record = candidate.feedbackRecord;
  const value = decision.value;
  const currentMilliseconds = factoryTimestampMilliseconds(trustedNow);
  const decisionMilliseconds = factoryTimestampMilliseconds(value.createdAt);
  const feedbackMilliseconds = factoryTimestampMilliseconds(record.value.observedAt);
  const expected = assessExternalPullRequestRepairAdmission(candidate, policy.value, trustedNow);
  if (
    value.repositoryId !== run.value.repositoryId ||
    value.pullRequestNumber !== run.value.pullRequestNumber ||
    value.reviewRunId !== run.value.reviewRunId ||
    value.reviewRunDigest !== run.value.reviewRunDigest ||
    value.bundleDigest !== run.value.bundleDigest ||
    value.feedbackPublicationRunId !== run.value.publicationRunId ||
    value.feedbackPublicationRunDigest !== run.digest ||
    value.feedbackRecordDigest !== record.digest ||
    value.admissionPolicyDigest !== policy.digest ||
    decisionMilliseconds < feedbackMilliseconds ||
    decisionMilliseconds > currentMilliseconds ||
    currentMilliseconds - decisionMilliseconds >= policy.value.authorizationTtlSeconds * 1_000 ||
    value.status !== expected.status ||
    !sameStrings(value.reasonCodes, expected.reasonCodes)
  ) {
    throw decisionIntegrityError();
  }
  if (expected.status === "denied") {
    if (
      authorization !== null ||
      value.authorizationDigest !== null ||
      value.selectedFindingCount !== 0
    ) {
      throw decisionIntegrityError();
    }
    return;
  }
  if (authorization === null) throw decisionIntegrityError();
  assertExternalPullRequestRepairAuthorization(policy, candidate, authorization, documents);
  if (
    value.authorizationDigest !== authorization.digest ||
    value.selectedFindingCount !== authorization.value.selectedFindings.length ||
    value.createdAt !== authorization.value.createdAt ||
    value.correlationId !== authorization.value.correlationId ||
    currentMilliseconds >= factoryTimestampMilliseconds(authorization.value.expiresAt) ||
    !sameFindingSelectors(authorization.value.selectedFindings, expected.selectedFindings)
  ) {
    throw decisionIntegrityError();
  }
}

function decisionIntegrityError(): Error {
  return new Error(
    "External repair decision changed its candidate, authorization, or deterministic policy result."
  );
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameFindingSelectors(
  left: readonly {
    readonly reviewerId: string;
    readonly findingId: string;
    readonly severity: string;
  }[],
  right: readonly {
    readonly reviewerId: string;
    readonly findingId: string;
    readonly severity: string;
  }[]
): boolean {
  if (left.length !== right.length) return false;
  return left.every((value, index) => {
    const expected = right[index];
    return (
      value.reviewerId === expected?.reviewerId &&
      value.findingId === expected.findingId &&
      value.severity === expected.severity
    );
  });
}
