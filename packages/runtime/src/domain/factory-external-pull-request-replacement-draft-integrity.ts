import type {
  FactoryExternalPullRequestReplacementDraftEvent,
  FactoryExternalPullRequestReplacementDraftPolicy,
  FactoryExternalPullRequestReplacementDraftRecord,
  FactoryExternalPullRequestReplacementDraftRun
} from "@agentlab/contracts";

import type { FactoryExternalPullRequestReplacementDraftCandidate } from "./factory-external-pull-request-replacement-draft-repository.js";
import type { CanonicalFactoryDocument, FactoryDocumentCodec } from "./factory-documents.js";

type PolicyDocument = CanonicalFactoryDocument<FactoryExternalPullRequestReplacementDraftPolicy>;
type RunDocument = CanonicalFactoryDocument<FactoryExternalPullRequestReplacementDraftRun>;
type EventDocument = CanonicalFactoryDocument<FactoryExternalPullRequestReplacementDraftEvent>;
type RecordDocument = CanonicalFactoryDocument<FactoryExternalPullRequestReplacementDraftRecord>;

type Documents = Pick<
  FactoryDocumentCodec,
  | "externalPullRequestRepairQualificationRun"
  | "externalPullRequestRepairQualificationBundle"
  | "externalPullRequestRepairBundle"
  | "externalPullRequestReplacementDraftPolicy"
>;

export function assertExternalPullRequestReplacementDraftRun(
  policy: PolicyDocument,
  candidate: FactoryExternalPullRequestReplacementDraftCandidate,
  run: RunDocument,
  documents: Documents
): void {
  const qualificationRun = candidate.qualificationRun;
  const qualification = candidate.qualificationBundle;
  const repair = candidate.repairBundle;
  if (
    documents.externalPullRequestReplacementDraftPolicy(run.value.publicationPolicy).digest !==
      run.value.publicationPolicyDigest ||
    run.value.publicationPolicyDigest !== policy.digest ||
    documents.externalPullRequestRepairQualificationRun(qualificationRun.value).digest !==
      qualificationRun.digest ||
    documents.externalPullRequestRepairQualificationBundle(qualification.value).digest !==
      qualification.digest ||
    documents.externalPullRequestRepairBundle(repair.value).digest !== repair.digest ||
    qualification.value.decision !== "qualified" ||
    run.value.repositoryId !== qualification.value.repositoryId ||
    run.value.originalPullRequestNumber !== qualification.value.pullRequestNumber ||
    run.value.qualificationRunId !== qualification.value.qualificationRunId ||
    run.value.qualificationRunId !== qualificationRun.value.qualificationRunId ||
    run.value.qualificationRunDigest !== qualification.value.runDigest ||
    run.value.qualificationRunDigest !== qualificationRun.digest ||
    run.value.qualificationBundleDigest !== qualification.digest ||
    run.value.repairBundleDigest !== qualification.value.repairBundleDigest ||
    run.value.repairBundleDigest !== repair.digest ||
    run.value.qualificationPolicyDigest !== qualification.value.qualificationPolicyDigest ||
    run.value.expectedBaseRevision !== qualificationRun.value.expectedBaseRevision ||
    run.value.expectedHeadRevision !== qualificationRun.value.expectedHeadRevision ||
    run.value.repairedPatchDigest !== qualification.value.repairedPatchArtifact.digest ||
    run.value.repairedPatchDigest !== repair.value.patchArtifact.digest ||
    JSON.stringify(run.value.changeSet) !== JSON.stringify(qualification.value.changeSet) ||
    JSON.stringify(run.value.changeSet) !== JSON.stringify(repair.value.changeSet)
  ) {
    throw new Error("Replacement-draft run changed its qualified repair lineage.");
  }
}

export function assertExternalPullRequestReplacementDraftRegistration(
  run: RunDocument,
  event: EventDocument
): void {
  if (
    event.value.kind !== "registered" ||
    event.value.publicationRunId !== run.value.publicationRunId ||
    event.value.runDigest !== run.digest ||
    event.value.sequence !== 1 ||
    event.value.previousEventDigest !== null ||
    event.value.occurredAt !== run.value.createdAt ||
    event.value.correlationId !== run.value.correlationId ||
    !isBrokerActor(run, event)
  ) {
    throw new Error("Replacement-draft registration changed its immutable run.");
  }
}

export function assertExternalPullRequestReplacementDraftEvent(
  run: RunDocument,
  event: EventDocument,
  history: readonly EventDocument[]
): void {
  const previous = history.at(-1);
  if (
    previous === undefined ||
    event.value.publicationRunId !== run.value.publicationRunId ||
    event.value.runDigest !== run.digest ||
    event.value.sequence !== previous.value.sequence + 1 ||
    event.value.previousEventDigest !== previous.digest ||
    event.value.from !== previous.value.to ||
    event.value.occurredAt < previous.value.occurredAt ||
    event.value.correlationId !== run.value.correlationId ||
    !isBrokerActor(run, event)
  ) {
    throw new Error("Replacement-draft event chain failed lineage validation.");
  }
  const intent = history.find(({ value }) => value.kind === "branch-publish-intent-recorded");
  if (
    event.value.kind !== "branch-publish-intent-recorded" &&
    "proposalDigest" in event.value &&
    (intent?.value.kind !== "branch-publish-intent-recorded" ||
      intent.value.proposalDigest !== event.value.proposalDigest)
  ) {
    throw new Error("Replacement-draft event changed its exact proposal.");
  }
  const published = history.find(({ value }) => value.kind === "branch-published");
  if (
    (event.value.kind === "pull-request-open-intent-recorded" ||
      event.value.kind === "pull-request-opened") &&
    published?.value.kind !== "branch-published"
  ) {
    throw new Error("Replacement-draft PR intent has no published branch.");
  }
  if (
    event.value.kind === "pull-request-open-intent-recorded" &&
    published?.value.kind === "branch-published" &&
    event.value.headRevision !== published.value.headRevision
  ) {
    throw new Error("Replacement-draft PR intent changed the published head.");
  }
}

export function assertExternalPullRequestReplacementDraftRecord(
  run: RunDocument,
  event: EventDocument,
  record: RecordDocument,
  history: readonly EventDocument[]
): void {
  const intent = history.find(({ value }) => value.kind === "branch-publish-intent-recorded");
  const published = history.find(({ value }) => value.kind === "branch-published");
  if (
    event.value.kind !== "pull-request-opened" ||
    intent?.value.kind !== "branch-publish-intent-recorded" ||
    published?.value.kind !== "branch-published" ||
    event.value.recordDigest !== record.digest ||
    event.value.recordArtifact.digest !== record.digest ||
    record.value.publicationRunId !== run.value.publicationRunId ||
    record.value.runDigest !== run.digest ||
    record.value.proposalDigest !== intent.value.proposalDigest ||
    record.value.qualificationBundleDigest !== run.value.qualificationBundleDigest ||
    record.value.repositoryId !== run.value.repositoryId ||
    record.value.originalPullRequestNumber !== run.value.originalPullRequestNumber ||
    record.value.baseRevision !== run.value.expectedBaseRevision ||
    record.value.headRevision !== published.value.headRevision ||
    record.value.brokerId !== run.value.publicationPolicy.brokerId ||
    record.value.publisherId !== run.value.publicationPolicy.publisherId
  ) {
    throw new Error("Replacement-draft record changed its remote intent lineage.");
  }
}

function isBrokerActor(run: RunDocument, event: EventDocument): boolean {
  return (
    event.value.actor.kind === "broker" &&
    event.value.actor.role === "pr-broker" &&
    event.value.actor.id === run.value.publicationPolicy.brokerId &&
    event.value.actor.sessionId === run.value.publicationRunId
  );
}
