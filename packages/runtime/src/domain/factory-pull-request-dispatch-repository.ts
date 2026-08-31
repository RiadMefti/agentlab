import type {
  FactoryPullRequestDispatchEvent,
  FactoryPullRequestDispatchRun,
  FactoryPullRequestDispatchState,
  FactoryPullRequestRecord,
  Sha256Digest
} from "@agentlab/contracts";

import type { CanonicalFactoryDocument } from "./factory-documents.js";

export interface FactoryPullRequestDispatchSnapshot {
  readonly run: FactoryPullRequestDispatchRun;
  readonly runDigest: Sha256Digest;
  readonly state: FactoryPullRequestDispatchState;
  readonly sequence: number;
  readonly lastEvent: FactoryPullRequestDispatchEvent;
  readonly lastEventDigest: Sha256Digest;
  readonly record: FactoryPullRequestRecord | null;
  readonly evidenceBundleDigest: Sha256Digest | null;
  readonly taskEventDigest: Sha256Digest | null;
}

/** Append-only authority journal for one exact remote draft-PR dispatch. */
export interface FactoryPullRequestDispatchRepository {
  register(
    run: CanonicalFactoryDocument<FactoryPullRequestDispatchRun>,
    initialEvent: CanonicalFactoryDocument<FactoryPullRequestDispatchEvent>
  ): Promise<FactoryPullRequestDispatchSnapshot>;
  findByTaskId(taskId: string): Promise<FactoryPullRequestDispatchSnapshot | null>;
  listRecoverable(limit: number): Promise<readonly FactoryPullRequestDispatchSnapshot[]>;
  listEvents(taskId: string): Promise<readonly FactoryPullRequestDispatchEvent[]>;
  append(
    event: CanonicalFactoryDocument<FactoryPullRequestDispatchEvent>
  ): Promise<FactoryPullRequestDispatchSnapshot | null>;
  close(): void;
}
