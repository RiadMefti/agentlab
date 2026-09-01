import type {
  FactoryExternalPullRequestDiscoveryEvent,
  FactoryExternalPullRequestDiscoveryRun,
  FactoryExternalPullRequestDiscoverySnapshot
} from "@agentlab/contracts";

import type { CanonicalFactoryDocument, FactoryDocumentCodec } from "./factory-documents.js";

type RunDocument = CanonicalFactoryDocument<FactoryExternalPullRequestDiscoveryRun>;
type EventDocument = CanonicalFactoryDocument<FactoryExternalPullRequestDiscoveryEvent>;
type SnapshotDocument = CanonicalFactoryDocument<FactoryExternalPullRequestDiscoverySnapshot>;

type Documents = Pick<
  FactoryDocumentCodec,
  "externalPullRequestDiscoveryPolicy" | "schedulePolicy" | "externalPullRequestCandidate"
>;

export function assertExternalPullRequestDiscoveryRun(
  run: RunDocument,
  documents: Documents
): void {
  if (
    documents.externalPullRequestDiscoveryPolicy(run.value.discoveryPolicy).digest !==
      run.value.discoveryPolicyDigest ||
    documents.schedulePolicy(run.value.schedulePolicy).digest !== run.value.schedulePolicyDigest ||
    run.value.discoveryPolicy.maximumPullRequestsPerTick >
      run.value.schedulePolicy.maximumCandidatesPerTick
  ) {
    throw new Error("External PR discovery run contains a non-canonical or oversized policy pin.");
  }
}

export function assertExternalPullRequestDiscoveryRegistration(
  run: RunDocument,
  event: EventDocument
): void {
  if (
    event.value.kind !== "registered" ||
    event.value.runId !== run.value.runId ||
    event.value.runDigest !== run.digest ||
    event.value.correlationId !== run.value.correlationId ||
    event.value.occurredAt !== run.value.createdAt ||
    event.value.actor.kind !== "control-plane" ||
    event.value.actor.id !== run.value.observerId ||
    event.value.actor.role !== "maintenance-scout" ||
    event.value.actor.sessionId !== run.value.runId
  ) {
    throw new Error("External PR discovery registration does not match its immutable run.");
  }
}

export function assertExternalPullRequestDiscoveryEvent(
  run: RunDocument,
  event: EventDocument,
  history: readonly EventDocument[]
): void {
  const previous = history.at(-1);
  if (
    previous === undefined ||
    event.value.runId !== run.value.runId ||
    event.value.runDigest !== run.digest ||
    event.value.correlationId !== run.value.correlationId ||
    event.value.actor.kind !== "control-plane" ||
    event.value.actor.id !== run.value.observerId ||
    event.value.actor.role !== "maintenance-scout" ||
    event.value.actor.sessionId !== run.value.runId ||
    event.value.sequence !== previous.value.sequence + 1 ||
    event.value.previousEventDigest !== previous.digest ||
    event.value.from !== previous.value.to ||
    event.value.occurredAt < previous.value.occurredAt
  ) {
    throw new Error("External PR discovery event chain failed immutable lineage validation.");
  }
}

export function assertExternalPullRequestDiscoverySnapshot(
  run: RunDocument,
  snapshot: SnapshotDocument,
  event: EventDocument,
  documents: Documents
): void {
  if (
    event.value.kind !== "snapshot-recorded" ||
    snapshot.value.runId !== run.value.runId ||
    snapshot.value.runDigest !== run.digest ||
    snapshot.value.repositoryId !== run.value.repositoryId ||
    snapshot.value.observerId !== run.value.observerId ||
    snapshot.value.discoveryPolicyDigest !== run.value.discoveryPolicyDigest ||
    snapshot.value.scheduledFor !== run.value.scheduledFor ||
    snapshot.value.observedAt !== event.value.occurredAt ||
    snapshot.value.pullRequests.length > run.value.discoveryPolicy.maximumPullRequestsPerTick ||
    event.value.snapshotDigest !== snapshot.digest ||
    event.value.snapshotArtifact.digest !== snapshot.digest
  ) {
    throw new Error("External PR discovery snapshot changed its run or artifact identity.");
  }
  for (const candidate of snapshot.value.pullRequests) {
    documents.externalPullRequestCandidate(candidate);
    if (candidate.repositoryId !== run.value.repositoryId) {
      throw new Error("External PR discovery snapshot contains another repository.");
    }
  }
}
