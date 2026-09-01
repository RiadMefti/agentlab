import type {
  FactoryExternalPullRequestFeedbackEvent,
  FactoryExternalPullRequestFeedbackRecord,
  FactoryExternalPullRequestFeedbackRun
} from "@agentlab/contracts";

import type { CanonicalFactoryDocument, FactoryDocumentCodec } from "./factory-documents.js";

type RunDocument = CanonicalFactoryDocument<FactoryExternalPullRequestFeedbackRun>;
type EventDocument = CanonicalFactoryDocument<FactoryExternalPullRequestFeedbackEvent>;
type RecordDocument = CanonicalFactoryDocument<FactoryExternalPullRequestFeedbackRecord>;

type Documents = Pick<
  FactoryDocumentCodec,
  | "externalPullRequestReviewRun"
  | "externalPullRequestReviewBundle"
  | "externalPullRequestFeedbackPolicy"
>;

export function assertExternalPullRequestFeedbackRun(run: RunDocument, documents: Documents): void {
  if (
    documents.externalPullRequestReviewRun(run.value.reviewRun).digest !==
      run.value.reviewRunDigest ||
    documents.externalPullRequestReviewBundle(run.value.bundle).digest !== run.value.bundleDigest ||
    documents.externalPullRequestFeedbackPolicy(run.value.feedbackPolicy).digest !==
      run.value.feedbackPolicyDigest ||
    run.value.bodyArtifact.digest === run.value.bundleDigest
  ) {
    throw new Error("External PR feedback run contains a non-canonical authority pin.");
  }
}

export function assertExternalPullRequestFeedbackRegistration(
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
    event.value.actor.kind !== "broker" ||
    event.value.actor.role !== "pr-broker" ||
    event.value.actor.id !== run.value.feedbackPolicy.publisherId ||
    event.value.actor.sessionId !== run.value.publicationRunId
  ) {
    throw new Error("External PR feedback registration does not match its immutable run.");
  }
}

export function assertExternalPullRequestFeedbackEvent(
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
    event.value.actor.kind !== "broker" ||
    event.value.actor.role !== "pr-broker" ||
    event.value.actor.id !== run.value.feedbackPolicy.publisherId ||
    event.value.actor.sessionId !== run.value.publicationRunId
  ) {
    throw new Error("External PR feedback event chain failed immutable lineage validation.");
  }
}

export function assertExternalPullRequestFeedbackRecord(
  run: RunDocument,
  event: EventDocument,
  record: RecordDocument
): void {
  if (
    event.value.kind !== "publication-recorded" ||
    event.value.recordDigest !== record.digest ||
    event.value.recordArtifact.digest !== record.digest ||
    record.value.publicationRunId !== run.value.publicationRunId ||
    record.value.runDigest !== run.digest ||
    record.value.bundleDigest !== run.value.bundleDigest ||
    record.value.repositoryId !== run.value.repositoryId ||
    record.value.pullRequestNumber !== run.value.pullRequestNumber ||
    record.value.headRevision !== run.value.expectedHeadRevision ||
    record.value.publisherId !== run.value.feedbackPolicy.publisherId ||
    record.value.publisherUserId !== run.value.feedbackPolicy.publisherUserId ||
    record.value.bodyDigest !== run.value.bodyArtifact.digest
  ) {
    throw new Error("External PR feedback record changed its publication authority.");
  }
}
