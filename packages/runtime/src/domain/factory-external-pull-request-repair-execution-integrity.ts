import type {
  FactoryExternalPullRequestRepairAdmissionPolicy,
  FactoryExternalPullRequestRepairBundle,
  FactoryExternalPullRequestRepairExecutionEvent,
  FactoryExternalPullRequestRepairExecutionPolicy,
  FactoryExternalPullRequestRepairExecutionRun
} from "@agentlab/contracts";

import { factoryUsageFits } from "./factory-authority-limits.js";
import type { FactoryExternalPullRequestRepairExecutionCandidate } from "./factory-external-pull-request-repair-execution-repository.js";
import { assertExternalPullRequestRepairDecision } from "./factory-external-pull-request-repair-admission-integrity.js";
import type { CanonicalFactoryDocument, FactoryDocumentCodec } from "./factory-documents.js";
import { repositoryPathMatches } from "./repository-path-policy.js";
import { factoryTimestampAddSeconds } from "./factory-timestamp.js";

type AdmissionPolicyDocument =
  CanonicalFactoryDocument<FactoryExternalPullRequestRepairAdmissionPolicy>;
type ExecutionPolicyDocument =
  CanonicalFactoryDocument<FactoryExternalPullRequestRepairExecutionPolicy>;
type RunDocument = CanonicalFactoryDocument<FactoryExternalPullRequestRepairExecutionRun>;
type EventDocument = CanonicalFactoryDocument<FactoryExternalPullRequestRepairExecutionEvent>;
type BundleDocument = CanonicalFactoryDocument<FactoryExternalPullRequestRepairBundle>;

export function assertExternalPullRequestRepairExecutionCandidate(
  admissionPolicy: AdmissionPolicyDocument,
  executionPolicy: ExecutionPolicyDocument,
  candidate: FactoryExternalPullRequestRepairExecutionCandidate,
  documents: FactoryDocumentCodec,
  trustedNow: string
): void {
  if (
    documents.externalPullRequestRepairDecision(candidate.decision.value).digest !==
      candidate.decision.digest ||
    documents.externalPullRequestRepairAuthorization(candidate.authorization.value).digest !==
      candidate.authorization.digest
  ) {
    throw new Error("External repair execution candidate contains a non-canonical admission.");
  }
  assertExternalPullRequestRepairDecision(
    admissionPolicy,
    { feedbackRun: candidate.feedbackRun, feedbackRecord: candidate.feedbackRecord },
    candidate.decision,
    candidate.authorization,
    documents,
    trustedNow
  );
  const authorization = candidate.authorization.value;
  if (
    candidate.decision.value.status !== "authorized" ||
    documents.externalPullRequestRepairExecutionPolicy(executionPolicy.value).digest !==
      executionPolicy.digest ||
    authorization.repositoryId !== executionPolicy.value.repositoryId ||
    authorization.admissionPolicyDigest !== admissionPolicy.digest ||
    authorization.repairExecutionPolicyDigest !== executionPolicy.digest ||
    admissionPolicy.value.repairExecutionPolicyDigest !== executionPolicy.digest ||
    executionPolicy.value.costPolicyDigest !== authorization.costPolicyDigest ||
    executionPolicy.value.roleIdentityPolicyDigest !== authorization.roleIdentityPolicyDigest ||
    executionPolicy.value.gateProfileDigest !== authorization.gateProfileDigest ||
    !sameStrings(
      executionPolicy.value.repairerProfile.skillDigests,
      authorization.skillPackageDigests
    ) ||
    executionPolicy.value.maximumChangedFiles > admissionPolicy.value.maximumChangedFiles ||
    executionPolicy.value.maximumChangedLines > admissionPolicy.value.maximumChangedLines
  ) {
    throw new Error("External repair execution policy exceeds its immutable admission authority.");
  }
}

export function assertExternalPullRequestRepairExecutionRun(
  admissionPolicy: AdmissionPolicyDocument,
  executionPolicy: ExecutionPolicyDocument,
  candidate: FactoryExternalPullRequestRepairExecutionCandidate,
  run: RunDocument,
  documents: FactoryDocumentCodec,
  trustedNow: string
): void {
  assertExternalPullRequestRepairExecutionCandidate(
    admissionPolicy,
    executionPolicy,
    candidate,
    documents,
    trustedNow
  );
  const value = run.value;
  const authorization = candidate.authorization.value;
  if (
    documents.externalPullRequestRepairExecutionRun(value).digest !== run.digest ||
    documents.externalPullRequestRepairExecutionPolicy(value.repairExecutionPolicy).digest !==
      value.repairExecutionPolicyDigest ||
    value.repairExecutionPolicyDigest !== executionPolicy.digest ||
    value.repositoryId !== authorization.repositoryId ||
    value.pullRequestNumber !== authorization.pullRequestNumber ||
    value.authorizationId !== authorization.authorizationId ||
    value.authorizationDigest !== candidate.authorization.digest ||
    value.admissionDecisionDigest !== candidate.decision.digest ||
    value.feedbackPublicationRunDigest !== candidate.feedbackRun.digest ||
    value.feedbackRecordDigest !== candidate.feedbackRecord.digest ||
    value.reviewRunDigest !== authorization.reviewRunDigest ||
    value.reviewBundleDigest !== authorization.bundleDigest ||
    value.admissionPolicyDigest !== admissionPolicy.digest ||
    value.expectedBaseRevision !== authorization.expectedBaseRevision ||
    value.expectedHeadRevision !== authorization.expectedHeadRevision ||
    value.originalPatchDigest !== authorization.patchDigest ||
    !sameFindingSelectors(value.selectedFindings, authorization.selectedFindings) ||
    value.deadlineAt !==
      factoryTimestampAddSeconds(value.createdAt, executionPolicy.value.operationDeadlineSeconds)
  ) {
    throw new Error("External repair execution run changed its policy or admission lineage.");
  }
}

export function assertExternalPullRequestRepairExecutionRegistration(
  run: RunDocument,
  event: EventDocument
): void {
  if (
    event.value.kind !== "registered" ||
    event.value.repairRunId !== run.value.runId ||
    event.value.runDigest !== run.digest ||
    event.value.sequence !== 1 ||
    event.value.previousEventDigest !== null ||
    event.value.occurredAt !== run.value.createdAt ||
    event.value.correlationId !== run.value.correlationId ||
    !sameActor(event.value.actor, run.value.runId)
  ) {
    throw new Error("External repair execution registration changed its immutable run.");
  }
}

export function assertExternalPullRequestRepairExecutionEvent(
  run: RunDocument,
  event: EventDocument,
  history: readonly EventDocument[]
): void {
  const previous = history.at(-1);
  if (
    previous === undefined ||
    event.value.repairRunId !== run.value.runId ||
    event.value.runDigest !== run.digest ||
    event.value.sequence !== previous.value.sequence + 1 ||
    event.value.previousEventDigest !== previous.digest ||
    event.value.from !== previous.value.to ||
    event.value.occurredAt < previous.value.occurredAt ||
    event.value.correlationId !== run.value.correlationId ||
    !sameActor(event.value.actor, run.value.runId)
  ) {
    throw new Error("External repair execution event chain failed immutable lineage validation.");
  }
}

export function assertExternalPullRequestRepairBundle(
  run: RunDocument,
  bundle: BundleDocument,
  event: EventDocument
): void {
  const policy = run.value.repairExecutionPolicy;
  if (
    event.value.kind !== "bundle-recorded" ||
    bundle.value.repairRunId !== run.value.runId ||
    bundle.value.runDigest !== run.digest ||
    bundle.value.repositoryId !== run.value.repositoryId ||
    bundle.value.pullRequestNumber !== run.value.pullRequestNumber ||
    bundle.value.authorizationDigest !== run.value.authorizationDigest ||
    bundle.value.repairExecutionPolicyDigest !== run.value.repairExecutionPolicyDigest ||
    bundle.value.expectedHeadRevision !== run.value.expectedHeadRevision ||
    bundle.value.originalPatchDigest !== run.value.originalPatchDigest ||
    bundle.value.repairerRequestDigest !== event.value.requestDigest ||
    bundle.value.repairerRecordDigest !== event.value.repairerRecordDigest ||
    bundle.value.executionId !== event.value.executionId ||
    event.value.bundleDigest !== bundle.digest ||
    event.value.bundleArtifact.digest !== bundle.digest ||
    bundle.value.changeSet.changedFiles > policy.maximumChangedFiles ||
    bundle.value.changeSet.changedLines > policy.maximumChangedLines ||
    bundle.value.patchArtifact.sizeBytes > policy.maximumPatchBytes ||
    !factoryUsageFits(bundle.value.usage, policy.repairerProfile.budget) ||
    bundle.value.changeSet.changedPaths.some((path) =>
      policy.protectedPaths.some((pattern) => repositoryPathMatches(path, pattern))
    )
  ) {
    throw new Error("External repair bundle exceeds its exact run or policy authority.");
  }
}

function sameActor(actor: FactoryExternalPullRequestRepairExecutionEvent["actor"], runId: string) {
  return (
    actor.kind === "control-plane" &&
    actor.role === "policy-engine" &&
    actor.id === "agentlab/external-pull-request-repair-execution" &&
    actor.sessionId === runId
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
