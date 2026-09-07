import type {
  FactoryExternalPullRequestReviewBundle,
  FactoryExternalPullRequestReviewEvent,
  FactoryExternalPullRequestReviewRun
} from "@agentlab/contracts";

import type { CanonicalFactoryDocument, FactoryDocumentCodec } from "./factory-documents.js";

type RunDocument = CanonicalFactoryDocument<FactoryExternalPullRequestReviewRun>;
type EventDocument = CanonicalFactoryDocument<FactoryExternalPullRequestReviewEvent>;
type BundleDocument = CanonicalFactoryDocument<FactoryExternalPullRequestReviewBundle>;

type Documents = Pick<
  FactoryDocumentCodec,
  | "externalPullRequestCandidate"
  | "externalPullRequestReviewPolicy"
  | "externalPullRequestReviewerRecord"
>;

export function assertExternalPullRequestReviewRun(run: RunDocument, documents: Documents): void {
  if (
    documents.externalPullRequestCandidate(run.value.candidate).digest !==
      run.value.candidateDigest ||
    documents.externalPullRequestReviewPolicy(run.value.reviewPolicy).digest !==
      run.value.reviewPolicyDigest ||
    run.value.discoveryPolicyDigest !== run.value.reviewPolicy.discoveryPolicyDigest
  ) {
    throw new Error("External PR review run contains a non-canonical authority pin.");
  }
}

export function assertExternalPullRequestReviewRegistration(
  run: RunDocument,
  event: EventDocument
): void {
  if (
    event.value.kind !== "registered" ||
    event.value.reviewRunId !== run.value.runId ||
    event.value.runDigest !== run.digest ||
    event.value.sequence !== 1 ||
    event.value.previousEventDigest !== null ||
    event.value.occurredAt !== run.value.createdAt ||
    event.value.correlationId !== run.value.correlationId ||
    event.value.actor.kind !== "control-plane" ||
    event.value.actor.id !== run.value.reviewPolicy.id ||
    event.value.actor.role !== "policy-engine" ||
    event.value.actor.sessionId !== run.value.runId
  ) {
    throw new Error("External PR review registration does not match its immutable run.");
  }
}

export function assertExternalPullRequestReviewEvent(
  run: RunDocument,
  event: EventDocument,
  history: readonly EventDocument[]
): void {
  const previous = history.at(-1);
  if (
    previous === undefined ||
    event.value.reviewRunId !== run.value.runId ||
    event.value.runDigest !== run.digest ||
    event.value.sequence !== previous.value.sequence + 1 ||
    event.value.previousEventDigest !== previous.digest ||
    event.value.from !== previous.value.to ||
    event.value.occurredAt < previous.value.occurredAt ||
    event.value.correlationId !== run.value.correlationId ||
    event.value.actor.kind !== "control-plane" ||
    event.value.actor.id !== run.value.reviewPolicy.id ||
    event.value.actor.role !== "policy-engine" ||
    event.value.actor.sessionId !== run.value.runId
  ) {
    throw new Error("External PR review event chain failed immutable lineage validation.");
  }
  if (event.value.kind === "reviewer-finished") {
    if (
      previous.value.kind !== "reviewer-started" ||
      previous.value.reviewerId !== event.value.reviewerId ||
      previous.value.executionId !== event.value.executionId ||
      previous.value.requestDigest !== event.value.requestDigest
    ) {
      throw new Error("External PR reviewer completion does not match its start event.");
    }
  }
  if (event.value.kind === "reviewer-started") {
    const reviewerId = event.value.reviewerId;
    const executionId = event.value.executionId;
    const profile = run.value.reviewPolicy.reviewerProfiles.find(({ id }) => id === reviewerId);
    if (
      profile === undefined ||
      history.some(
        (prior) =>
          (prior.value.kind === "reviewer-finished" && prior.value.reviewerId === reviewerId) ||
          (prior.value.kind === "reviewer-started" && prior.value.executionId === executionId)
      )
    ) {
      throw new Error("External PR reviewer identity is absent or has already been consumed.");
    }
  }
}

export function assertExternalPullRequestReviewBundle(
  run: RunDocument,
  bundle: BundleDocument,
  event: EventDocument,
  documents: Documents
): void {
  if (
    event.value.kind !== "bundle-recorded" ||
    bundle.value.reviewRunId !== run.value.runId ||
    bundle.value.runDigest !== run.digest ||
    bundle.value.repositoryId !== run.value.repositoryId ||
    bundle.value.pullRequestNumber !== run.value.pullRequestNumber ||
    bundle.value.candidateDigest !== run.value.candidateDigest ||
    bundle.value.reviewPolicyDigest !== run.value.reviewPolicyDigest ||
    bundle.value.reviews.length < run.value.reviewPolicy.minimumIndependentReviews ||
    event.value.bundleDigest !== bundle.digest ||
    event.value.bundleArtifact.digest !== bundle.digest
  ) {
    throw new Error("External PR review bundle changed its run or authority identity.");
  }
  for (const [index, result] of bundle.value.reviews.entries()) {
    const record = bundle.value.reviewerRecords[index];
    const profile = run.value.reviewPolicy.reviewerProfiles[index];
    if (
      record === undefined ||
      profile?.id !== result.reviewerId ||
      result.reviewerRecordDigest !== documents.externalPullRequestReviewerRecord(record).digest ||
      record.reviewRunId !== run.value.runId ||
      record.runDigest !== run.digest ||
      record.reviewerId !== result.reviewerId ||
      record.provider !== profile.provider ||
      record.model !== profile.model ||
      record.reasoning !== profile.reasoning ||
      record.executionId !== result.executionId ||
      record.requestDigest !== result.requestDigest ||
      record.status !== "succeeded" ||
      !record.usageComplete
    ) {
      throw new Error("External PR review bundle contains an invalid reviewer result.");
    }
  }
  if (bundle.value.reviews.length !== run.value.reviewPolicy.minimumIndependentReviews) {
    throw new Error("External PR review bundle does not contain the exact review quorum.");
  }
  const approvals = bundle.value.reviews.filter(({ verdict }) => verdict === "approved").length;
  const expected =
    approvals === bundle.value.reviews.length
      ? "approved"
      : approvals === 0
        ? "changes-requested"
        : "human-review-required";
  if (bundle.value.decision !== expected || !bundle.value.usageComplete) {
    throw new Error("External PR review bundle decision or usage is incomplete.");
  }
}
