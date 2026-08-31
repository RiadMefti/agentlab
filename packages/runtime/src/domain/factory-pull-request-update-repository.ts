import type {
  FactoryPullRequestUpdateEvent,
  FactoryPullRequestUpdateRecord,
  FactoryPullRequestUpdateRun,
  FactoryPullRequestUpdateState,
  Sha256Digest
} from "@agentlab/contracts";

import type { CanonicalFactoryDocument } from "./factory-documents.js";

export interface FactoryPullRequestUpdateSnapshot {
  readonly run: FactoryPullRequestUpdateRun;
  readonly runDigest: Sha256Digest;
  readonly state: FactoryPullRequestUpdateState;
  readonly sequence: number;
  readonly lastEvent: FactoryPullRequestUpdateEvent;
  readonly lastEventDigest: Sha256Digest;
  readonly record: FactoryPullRequestUpdateRecord | null;
  readonly remoteUpdated: boolean | null;
  readonly evidenceBundleDigest: Sha256Digest | null;
  readonly taskEventDigest: Sha256Digest | null;
}

/** Append-only authority journal for one authorization-bound update of an existing draft PR. */
export interface FactoryPullRequestUpdateRepository {
  register(
    run: CanonicalFactoryDocument<FactoryPullRequestUpdateRun>,
    initialEvent: CanonicalFactoryDocument<FactoryPullRequestUpdateEvent>
  ): Promise<FactoryPullRequestUpdateSnapshot>;
  findByAuthorizationDigest(
    authorizationDigest: Sha256Digest
  ): Promise<FactoryPullRequestUpdateSnapshot | null>;
  findByRepairRunDigest(
    repairRunDigest: Sha256Digest
  ): Promise<FactoryPullRequestUpdateSnapshot | null>;
  listByTaskId(taskId: string): Promise<readonly FactoryPullRequestUpdateSnapshot[]>;
  listRecoverable(limit: number): Promise<readonly FactoryPullRequestUpdateSnapshot[]>;
  listEvents(updateId: string): Promise<readonly FactoryPullRequestUpdateEvent[]>;
  append(
    event: CanonicalFactoryDocument<FactoryPullRequestUpdateEvent>
  ): Promise<FactoryPullRequestUpdateSnapshot | null>;
  close(): void;
}
