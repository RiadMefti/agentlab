import type {
  FactoryAutonomousMergeAuthorization,
  FactoryAutonomousMergeEvent,
  FactoryAutonomousMergePolicy,
  FactoryAutonomousMergeRecord,
  FactoryAutonomousMergeRun
} from "@agentlab/contracts";

import type { FactoryAutonomousMergeCandidate } from "./factory-autonomous-merge-repository.js";
import type { CanonicalFactoryDocument, FactoryDocumentCodec } from "./factory-documents.js";

type PolicyDocument = CanonicalFactoryDocument<FactoryAutonomousMergePolicy>;
type AuthorizationDocument = CanonicalFactoryDocument<FactoryAutonomousMergeAuthorization>;
type RunDocument = CanonicalFactoryDocument<FactoryAutonomousMergeRun>;
type EventDocument = CanonicalFactoryDocument<FactoryAutonomousMergeEvent>;
type RecordDocument = CanonicalFactoryDocument<FactoryAutonomousMergeRecord>;

export function assertFactoryAutonomousMergeRun(
  policy: PolicyDocument,
  candidate: FactoryAutonomousMergeCandidate,
  run: RunDocument,
  documents: Pick<FactoryDocumentCodec, "autonomousMergePolicy">
): void {
  const authorization = candidate.authorization;
  if (
    documents.autonomousMergePolicy(run.value.mergePolicy).digest !== run.value.mergePolicyDigest ||
    run.value.mergePolicyDigest !== policy.digest ||
    run.value.authorizationId !== authorization.value.authorizationId ||
    run.value.authorizationDigest !== authorization.digest ||
    run.value.taskId !== authorization.value.taskId ||
    run.value.contractDigest !== authorization.value.contractDigest ||
    run.value.repositoryId !== authorization.value.repositoryId ||
    run.value.pullRequestNumber !== authorization.value.pullRequestNumber ||
    run.value.pullRequestUrl !== authorization.value.pullRequestUrl ||
    run.value.expectedBaseRevision !== authorization.value.expectedBaseRevision ||
    run.value.expectedHeadRevision !== authorization.value.expectedHeadRevision ||
    authorization.value.mergePolicyDigest !== policy.digest ||
    run.value.createdAt < authorization.value.issuedAt ||
    run.value.createdAt >= authorization.value.expiresAt ||
    run.value.deadlineAt > authorization.value.expiresAt
  ) {
    throw new Error("Autonomous merge run changed its exact authorization lineage.");
  }
}

export function assertFactoryAutonomousMergeRegistration(
  run: RunDocument,
  event: EventDocument
): void {
  if (
    event.value.kind !== "registered" ||
    event.value.mergeRunId !== run.value.mergeRunId ||
    event.value.runDigest !== run.digest ||
    event.value.sequence !== 1 ||
    event.value.previousEventDigest !== null ||
    event.value.occurredAt !== run.value.createdAt ||
    event.value.correlationId !== run.value.correlationId ||
    !isMergerActor(run, event)
  ) {
    throw new Error("Autonomous merge registration changed its immutable run.");
  }
}

export function assertFactoryAutonomousMergeEvent(
  run: RunDocument,
  event: EventDocument,
  history: readonly EventDocument[]
): void {
  const previous = history.at(-1);
  if (
    previous === undefined ||
    event.value.mergeRunId !== run.value.mergeRunId ||
    event.value.runDigest !== run.digest ||
    event.value.sequence !== previous.value.sequence + 1 ||
    event.value.previousEventDigest !== previous.digest ||
    event.value.from !== previous.value.to ||
    event.value.occurredAt < previous.value.occurredAt ||
    event.value.correlationId !== run.value.correlationId ||
    !isMergerActor(run, event)
  ) {
    throw new Error("Autonomous merge event chain failed lineage validation.");
  }
}

export function assertFactoryAutonomousMergeRecord(
  run: RunDocument,
  authorization: AuthorizationDocument,
  event: EventDocument,
  record: RecordDocument,
  history: readonly EventDocument[]
): void {
  const merged = history.findLast(({ value }) => value.kind === "merged");
  if (
    event.value.kind !== "evidence-recorded" ||
    merged?.value.kind !== "merged" ||
    event.value.recordDigest !== record.digest ||
    record.value.mergeRunId !== run.value.mergeRunId ||
    record.value.runDigest !== run.digest ||
    record.value.authorizationDigest !== authorization.digest ||
    record.value.taskId !== run.value.taskId ||
    record.value.contractDigest !== run.value.contractDigest ||
    record.value.repositoryId !== run.value.repositoryId ||
    record.value.pullRequestNumber !== run.value.pullRequestNumber ||
    record.value.pullRequestUrl !== run.value.pullRequestUrl ||
    record.value.expectedHeadRevision !== run.value.expectedHeadRevision ||
    record.value.mergedRevision !== merged.value.mergedRevision ||
    record.value.mergeQueueEntryId !== merged.value.mergeQueueEntryId ||
    record.value.mergedAt !== merged.value.mergedAt ||
    record.value.mergerId !== run.value.mergePolicy.mergerId
  ) {
    throw new Error("Autonomous merge record changed its queue-backed merge lineage.");
  }
}

function isMergerActor(run: RunDocument, event: EventDocument): boolean {
  return (
    event.value.actor.kind === "broker" &&
    event.value.actor.role === "merger" &&
    event.value.actor.id === run.value.mergePolicy.mergerId &&
    event.value.actor.sessionId === null
  );
}
