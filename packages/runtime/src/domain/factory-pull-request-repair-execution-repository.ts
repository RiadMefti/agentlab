import type {
  FactoryExecutionEvent,
  FactoryPullRequestRepairRun,
  Sha256Digest
} from "@agentlab/contracts";

import type {
  FactoryExecutionJournalRepository,
  FactoryExecutionJournalSnapshot
} from "./factory-execution-repository.js";

export type FactoryPullRequestRepairExecutionSnapshot =
  FactoryExecutionJournalSnapshot<FactoryPullRequestRepairRun>;

/** Append-only journal for one authorization-bound post-PR repair execution. */
export interface FactoryPullRequestRepairExecutionRepository extends FactoryExecutionJournalRepository<FactoryPullRequestRepairRun> {
  findByAuthorizationDigest(
    authorizationDigest: Sha256Digest
  ): Promise<FactoryPullRequestRepairExecutionSnapshot | null>;
  listByTaskId(taskId: string): Promise<readonly FactoryPullRequestRepairExecutionSnapshot[]>;
  listRecoverable(limit: number): Promise<readonly FactoryPullRequestRepairExecutionSnapshot[]>;
  listEvents(runId: string): Promise<readonly FactoryExecutionEvent[]>;
  close(): void;
}
