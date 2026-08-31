import type {
  FactoryPullRequestAuthorityRecord,
  FactoryPullRequestUpdateRecord,
  Sha256Digest
} from "@agentlab/contracts";

import type {
  CanonicalFactoryDocument,
  FactoryDocumentCodec
} from "../domain/factory-documents.js";
import { factoryPullRequestAuthorityCoordinates } from "../domain/factory-pull-request-authority-record.js";
import type {
  FactoryPullRequestDispatchRepository,
  FactoryPullRequestDispatchSnapshot
} from "../domain/factory-pull-request-dispatch-repository.js";
import type {
  FactoryPullRequestUpdateRepository,
  FactoryPullRequestUpdateSnapshot
} from "../domain/factory-pull-request-update-repository.js";
import type { FactoryTaskSnapshot } from "../domain/factory-task-repository.js";

export interface FactoryPullRequestLineage {
  readonly dispatch: FactoryPullRequestDispatchSnapshot;
  readonly updates: readonly FactoryPullRequestUpdateSnapshot[];
  readonly record: CanonicalFactoryDocument<FactoryPullRequestAuthorityRecord>;
  readonly currentPatchProposalDigest: Sha256Digest;
  readonly contractRepairAttempt: number;
}

export interface FactoryPullRequestLineageReaderDependencies {
  readonly dispatches: Pick<FactoryPullRequestDispatchRepository, "findByTaskId">;
  readonly updates: Pick<FactoryPullRequestUpdateRepository, "listByTaskId">;
  readonly documents: FactoryDocumentCodec;
}

/** Replays the immutable initial dispatch and every completed update into one current PR head. */
export class FactoryPullRequestLineageReader {
  public constructor(private readonly dependencies: FactoryPullRequestLineageReaderDependencies) {}

  public async current(task: FactoryTaskSnapshot): Promise<FactoryPullRequestLineage> {
    return this.#read(task, null);
  }

  public async before(
    task: FactoryTaskSnapshot,
    updateId: string
  ): Promise<FactoryPullRequestLineage> {
    return this.#read(task, updateId);
  }

  async #read(
    task: FactoryTaskSnapshot,
    excludedUpdateId: string | null
  ): Promise<FactoryPullRequestLineage> {
    const dispatch = await this.dependencies.dispatches.findByTaskId(task.contract.taskId);
    if (dispatch?.state !== "completed" || dispatch.record === null) {
      throw new Error("Pull-request lineage requires a completed initial dispatch.");
    }
    const initialProposal = this.dependencies.documents.pullRequestProposal(dispatch.run.proposal);
    const initialRecord = this.dependencies.documents.pullRequestRecord(dispatch.record);
    if (
      initialProposal.digest !== dispatch.run.proposalDigest ||
      dispatch.run.taskId !== task.contract.taskId ||
      dispatch.run.contractDigest !== task.contractDigest ||
      initialProposal.value.repositoryId !== task.contract.repository.id ||
      initialProposal.value.baseRevision !== task.contract.repository.baseRevision ||
      initialRecord.value.taskId !== task.contract.taskId ||
      initialRecord.value.contractDigest !== task.contractDigest ||
      initialRecord.value.proposalDigest !== initialProposal.digest ||
      initialRecord.value.repositoryId !== task.contract.repository.id ||
      initialRecord.value.baseRevision !== task.contract.repository.baseRevision ||
      initialRecord.value.branchName !== initialProposal.value.branchName ||
      initialRecord.value.brokerId !== dispatch.run.brokerId
    ) {
      throw new Error("Initial pull-request dispatch violates its immutable task identity.");
    }

    let record: CanonicalFactoryDocument<FactoryPullRequestAuthorityRecord> =
      this.dependencies.documents.pullRequestAuthorityRecord(initialRecord.value);
    let currentPatchProposalDigest = initialProposal.value.patchProposalDigest;
    const allUpdates = [
      ...(await this.dependencies.updates.listByTaskId(task.contract.taskId))
    ].sort(
      (left, right) =>
        left.run.proposal.contractRepairAttempt - right.run.proposal.contractRepairAttempt
    );
    const excluded = allUpdates.filter(({ run }) => run.updateId === excludedUpdateId);
    if (excludedUpdateId !== null && excluded.length !== 1) {
      throw new Error("Pull-request update recovery cannot identify its exact pending journal.");
    }
    const updates = allUpdates.filter(({ run }) => run.updateId !== excludedUpdateId);
    let expectedAttempt = 1;
    for (const update of updates) {
      if (update.state !== "completed" || update.record === null) {
        throw new Error("Pull-request lineage contains an incomplete durable update.");
      }
      if (update.run.proposal.contractRepairAttempt !== expectedAttempt) {
        throw new Error("Pull-request update attempts are not contiguous.");
      }
      const next = this.dependencies.documents.pullRequestUpdateRecord(update.record);
      this.#assertUpdate(task, dispatch, update, record, next, expectedAttempt);
      record = this.dependencies.documents.pullRequestAuthorityRecord(next.value);
      currentPatchProposalDigest = update.run.proposal.repairedPatchProposalDigest;
      expectedAttempt += 1;
    }
    if (
      excluded[0] !== undefined &&
      excluded[0].run.proposal.contractRepairAttempt !== expectedAttempt
    ) {
      throw new Error("Pending pull-request update is not the next lineage attempt.");
    }
    return {
      dispatch,
      updates,
      record,
      currentPatchProposalDigest,
      contractRepairAttempt: expectedAttempt - 1
    };
  }

  #assertUpdate(
    task: FactoryTaskSnapshot,
    dispatch: FactoryPullRequestDispatchSnapshot,
    update: FactoryPullRequestUpdateSnapshot,
    prior: CanonicalFactoryDocument<FactoryPullRequestAuthorityRecord>,
    next: CanonicalFactoryDocument<FactoryPullRequestUpdateRecord>,
    attempt: number
  ): void {
    const proposal = this.dependencies.documents.pullRequestUpdateProposal(update.run.proposal);
    const priorCoordinates = factoryPullRequestAuthorityCoordinates(prior.value);
    const record = next.value;
    if (
      proposal.digest !== update.run.proposalDigest ||
      update.run.taskId !== task.contract.taskId ||
      update.run.contractDigest !== task.contractDigest ||
      update.run.brokerId !== dispatch.run.brokerId ||
      proposal.value.initialProposalDigest !== dispatch.run.proposalDigest ||
      proposal.value.priorPullRequestRecordDigest !== prior.digest ||
      proposal.value.priorHeadRevision !== priorCoordinates.headRevision ||
      proposal.value.repositoryId !== priorCoordinates.repositoryId ||
      proposal.value.pullRequestNumber !== priorCoordinates.number ||
      proposal.value.branchName !== priorCoordinates.branchName ||
      proposal.value.brokerId !== priorCoordinates.brokerId ||
      proposal.value.baseRevision !== task.contract.repository.baseRevision ||
      proposal.value.contractRepairAttempt !== attempt ||
      record.updateProposalDigest !== proposal.digest ||
      record.priorPullRequestRecordDigest !== prior.digest ||
      record.initialProposalDigest !== dispatch.run.proposalDigest ||
      record.taskId !== task.contract.taskId ||
      record.contractDigest !== task.contractDigest ||
      record.repositoryId !== priorCoordinates.repositoryId ||
      record.number !== priorCoordinates.number ||
      record.url !== priorCoordinates.url ||
      record.baseRevision !== priorCoordinates.baseRevision ||
      record.priorHeadRevision !== priorCoordinates.headRevision ||
      record.branchName !== priorCoordinates.branchName ||
      record.brokerId !== priorCoordinates.brokerId ||
      record.contractRepairAttempt !== attempt ||
      record.repairAuthorizationDigest !== proposal.value.repairAuthorizationDigest ||
      record.repairRunDigest !== proposal.value.repairRunDigest ||
      record.repairedPatchProposalDigest !== proposal.value.repairedPatchProposalDigest
    ) {
      throw new Error("Pull-request update breaks the authenticated head lineage.");
    }
  }
}
