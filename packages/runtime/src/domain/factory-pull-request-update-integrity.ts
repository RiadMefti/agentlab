import type {
  FactoryPullRequestUpdateEvent,
  FactoryPullRequestUpdateProposal,
  FactoryPullRequestUpdateRun
} from "@agentlab/contracts";

import type { CanonicalFactoryDocument, FactoryDocumentCodec } from "./factory-documents.js";

export function assertPullRequestUpdateRun(
  run: CanonicalFactoryDocument<FactoryPullRequestUpdateRun>,
  proposal: CanonicalFactoryDocument<FactoryPullRequestUpdateProposal>
): void {
  if (
    run.value.proposalDigest !== proposal.digest ||
    run.value.taskId !== proposal.value.taskId ||
    run.value.contractDigest !== proposal.value.contractDigest ||
    run.value.brokerId !== proposal.value.brokerId ||
    run.value.createdAt !== proposal.value.createdAt ||
    JSON.stringify(run.value.proposal) !== JSON.stringify(proposal.value)
  ) {
    throw new Error("Pull-request update run does not bind its exact canonical proposal.");
  }
}

export function assertPullRequestUpdateRegistration(
  run: CanonicalFactoryDocument<FactoryPullRequestUpdateRun>,
  event: CanonicalFactoryDocument<FactoryPullRequestUpdateEvent>
): void {
  if (
    event.value.kind !== "registered" ||
    event.value.sequence !== 1 ||
    event.value.previousEventDigest !== null ||
    event.value.occurredAt !== run.value.createdAt
  ) {
    throw new Error("Initial PR update event does not register its exact immutable run.");
  }
  assertPullRequestUpdateEvent(run, event, []);
}

export function assertPullRequestUpdateEvent(
  run: CanonicalFactoryDocument<FactoryPullRequestUpdateRun>,
  event: CanonicalFactoryDocument<FactoryPullRequestUpdateEvent>,
  history: readonly CanonicalFactoryDocument<FactoryPullRequestUpdateEvent>[]
): void {
  const previous = history.at(-1);
  if (
    event.value.updateId !== run.value.updateId ||
    event.value.updateDigest !== run.digest ||
    event.value.taskId !== run.value.taskId ||
    event.value.contractDigest !== run.value.contractDigest ||
    event.value.correlationId !== run.value.correlationId ||
    event.value.actor.kind !== "broker" ||
    event.value.actor.role !== "pr-broker" ||
    event.value.actor.id !== run.value.brokerId ||
    event.value.actor.sessionId !== null ||
    event.value.sequence !== history.length + 1 ||
    event.value.previousEventDigest !== (previous?.digest ?? null) ||
    event.value.from !== (previous?.value.to ?? null) ||
    (previous !== undefined && event.value.occurredAt < previous.value.occurredAt)
  ) {
    throw new Error("PR update event violates its immutable run or hash chain.");
  }
  const expectedKind = [
    "registered",
    "update-started",
    "remote-updated",
    "evidence-recorded",
    "task-recorded"
  ][history.length];
  if (event.value.kind !== expectedKind) {
    throw new Error("PR update event violates the durable lifecycle order.");
  }
  if (event.value.kind === "remote-updated") {
    const proposal = run.value.proposal;
    const record = event.value.record;
    if (
      record.taskId !== proposal.taskId ||
      record.contractDigest !== proposal.contractDigest ||
      record.initialProposalDigest !== proposal.initialProposalDigest ||
      record.updateProposalDigest !== run.value.proposalDigest ||
      record.priorPullRequestRecordDigest !== proposal.priorPullRequestRecordDigest ||
      record.repairAuthorizationDigest !== proposal.repairAuthorizationDigest ||
      record.repairRunDigest !== proposal.repairRunDigest ||
      record.repairedPatchProposalDigest !== proposal.repairedPatchProposalDigest ||
      record.repositoryId !== proposal.repositoryId ||
      record.number !== proposal.pullRequestNumber ||
      record.baseRevision !== proposal.baseRevision ||
      record.priorHeadRevision !== proposal.priorHeadRevision ||
      record.headRevision === record.priorHeadRevision ||
      record.branchName !== proposal.branchName ||
      record.brokerId !== proposal.brokerId ||
      record.contractRepairAttempt !== proposal.contractRepairAttempt
    ) {
      throw new Error("Remote PR update record does not match its exact immutable proposal.");
    }
  }
}

export function pullRequestUpdateRecordDigest(
  event: FactoryPullRequestUpdateEvent,
  documents: Pick<FactoryDocumentCodec, "pullRequestUpdateRecord">
): string | null {
  return event.kind === "remote-updated"
    ? documents.pullRequestUpdateRecord(event.record).digest
    : null;
}
