import type {
  FactoryExecutionEvent,
  FactoryExecutionJournalState,
  FactoryExecutionRun,
  Sha256Digest
} from "@agentlab/contracts";

import type { CanonicalFactoryDocument } from "./factory-documents.js";

export interface FactoryExecutionSnapshot {
  readonly run: FactoryExecutionRun;
  readonly runDigest: Sha256Digest;
  readonly state: FactoryExecutionJournalState;
  readonly sequence: number;
  readonly lastEvent: FactoryExecutionEvent;
  readonly lastEventDigest: Sha256Digest;
}

/** Append-only execution journal. Run headers and event history are immutable after insertion. */
export interface FactoryExecutionRepository {
  register(
    run: CanonicalFactoryDocument<FactoryExecutionRun>,
    initialEvent: CanonicalFactoryDocument<FactoryExecutionEvent>
  ): Promise<FactoryExecutionSnapshot>;
  findByTaskId(taskId: string): Promise<FactoryExecutionSnapshot | null>;
  listRecoverable(limit: number): Promise<readonly FactoryExecutionSnapshot[]>;
  listEvents(taskId: string): Promise<readonly FactoryExecutionEvent[]>;
  append(
    event: CanonicalFactoryDocument<FactoryExecutionEvent>
  ): Promise<FactoryExecutionSnapshot | null>;
  close(): void;
}
