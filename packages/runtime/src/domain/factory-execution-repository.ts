import type {
  FactoryExecutionEvent,
  FactoryExecutionJournalState,
  FactoryExecutionRun,
  FactoryPullRequestRepairRun,
  Sha256Digest
} from "@agentlab/contracts";

import type { CanonicalFactoryDocument } from "./factory-documents.js";

export type FactoryExecutionJournalRun = FactoryExecutionRun | FactoryPullRequestRepairRun;

export interface FactoryExecutionJournalSnapshot<Run extends FactoryExecutionJournalRun> {
  readonly run: Run;
  readonly runDigest: Sha256Digest;
  readonly state: FactoryExecutionJournalState;
  readonly sequence: number;
  readonly lastEvent: FactoryExecutionEvent;
  readonly lastEventDigest: Sha256Digest;
}

export type FactoryExecutionSnapshot = FactoryExecutionJournalSnapshot<FactoryExecutionRun>;

/** Common append primitive shared by initial and separately authorized repair journals. */
export interface FactoryExecutionJournalRepository<Run extends FactoryExecutionJournalRun> {
  register(
    run: CanonicalFactoryDocument<Run>,
    initialEvent: CanonicalFactoryDocument<FactoryExecutionEvent>
  ): Promise<FactoryExecutionJournalSnapshot<Run>>;
  append(
    event: CanonicalFactoryDocument<FactoryExecutionEvent>
  ): Promise<FactoryExecutionJournalSnapshot<Run> | null>;
}

/** Append-only execution journal. Run headers and event history are immutable after insertion. */
export interface FactoryExecutionRepository extends FactoryExecutionJournalRepository<FactoryExecutionRun> {
  findByTaskId(taskId: string): Promise<FactoryExecutionSnapshot | null>;
  listRecoverable(limit: number): Promise<readonly FactoryExecutionSnapshot[]>;
  listEvents(taskId: string): Promise<readonly FactoryExecutionEvent[]>;
  close(): void;
}
