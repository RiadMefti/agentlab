import type {
  FactoryPullRequestDispatchEvent,
  FactoryPullRequestDispatchRun,
  FactoryPullRequestProposal
} from "@agentlab/contracts";

import type { CanonicalFactoryDocument } from "./factory-documents.js";

export function assertPullRequestDispatchRun(
  run: CanonicalFactoryDocument<FactoryPullRequestDispatchRun>,
  proposal: CanonicalFactoryDocument<FactoryPullRequestProposal>
): void {
  if (
    run.value.proposalDigest !== proposal.digest ||
    run.value.proposal.taskId !== proposal.value.taskId ||
    run.value.proposal.contractDigest !== proposal.value.contractDigest ||
    run.value.proposal.createdAt !== proposal.value.createdAt ||
    run.value.taskId !== proposal.value.taskId ||
    run.value.contractDigest !== proposal.value.contractDigest ||
    run.value.createdAt !== proposal.value.createdAt
  ) {
    throw new Error("Pull-request dispatch does not bind its exact canonical proposal.");
  }
}

export function assertPullRequestDispatchRegistration(
  run: CanonicalFactoryDocument<FactoryPullRequestDispatchRun>,
  event: CanonicalFactoryDocument<FactoryPullRequestDispatchEvent>
): void {
  if (
    event.value.kind !== "registered" ||
    event.value.dispatchId !== run.value.dispatchId ||
    event.value.dispatchDigest !== run.digest ||
    event.value.taskId !== run.value.taskId ||
    event.value.contractDigest !== run.value.contractDigest ||
    event.value.sequence !== 1 ||
    event.value.previousEventDigest !== null ||
    event.value.occurredAt !== run.value.createdAt ||
    event.value.correlationId !== run.value.correlationId
  ) {
    throw new Error("Initial dispatch event does not register its exact immutable run.");
  }
  assertPullRequestDispatchEvent(run, event, []);
}

export function assertPullRequestDispatchEvent(
  run: CanonicalFactoryDocument<FactoryPullRequestDispatchRun>,
  event: CanonicalFactoryDocument<FactoryPullRequestDispatchEvent>,
  history: readonly CanonicalFactoryDocument<FactoryPullRequestDispatchEvent>[]
): void {
  if (
    event.value.dispatchId !== run.value.dispatchId ||
    event.value.dispatchDigest !== run.digest ||
    event.value.taskId !== run.value.taskId ||
    event.value.contractDigest !== run.value.contractDigest ||
    !isExactBrokerActor(event.value, run.value.brokerId)
  ) {
    throw new Error("Dispatch event violates its run identity or broker authority.");
  }
  const previous = history.at(-1);
  if (
    event.value.sequence !== history.length + 1 ||
    event.value.previousEventDigest !== (previous?.digest ?? null) ||
    event.value.from !== (previous?.value.to ?? null)
  ) {
    throw new Error("Dispatch event does not extend the exact journal head.");
  }
  if (event.value.occurredAt < (previous?.value.occurredAt ?? run.value.createdAt)) {
    throw new Error("Dispatch event timestamp predates its predecessor.");
  }
  if (event.value.kind === "registered") {
    if (history.length !== 0 || event.value.occurredAt !== run.value.createdAt) {
      throw new Error("Dispatch registration must be the first event at run creation time.");
    }
    return;
  }
  if (event.value.kind === "remote-observed") {
    assertRemoteRecord(run.value, event.value);
  }
}

function assertRemoteRecord(
  run: FactoryPullRequestDispatchRun,
  event: Extract<FactoryPullRequestDispatchEvent, { readonly kind: "remote-observed" }>
): void {
  const proposal = run.proposal;
  const record = event.record;
  if (
    record.taskId !== run.taskId ||
    record.contractDigest !== run.contractDigest ||
    record.proposalDigest !== run.proposalDigest ||
    record.repositoryId !== proposal.repositoryId ||
    record.baseRevision !== proposal.baseRevision ||
    record.branchName !== proposal.branchName ||
    record.brokerId !== run.brokerId ||
    record.headRevision === record.baseRevision
  ) {
    throw new Error("Observed draft PR does not match its exact authorized dispatch.");
  }
}

function isExactBrokerActor(event: FactoryPullRequestDispatchEvent, brokerId: string): boolean {
  return (
    event.actor.kind === "broker" &&
    event.actor.role === "pr-broker" &&
    event.actor.id === brokerId &&
    event.actor.sessionId === null
  );
}
