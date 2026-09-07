import type {
  FactoryExternalPullRequestDiscoveryEvent,
  FactoryExternalPullRequestDiscoveryRun,
  FactoryExternalPullRequestDiscoverySnapshot,
  FactoryExternalPullRequestDiscoveryState,
  Sha256Digest
} from "@agentlab/contracts";

import type { CanonicalFactoryDocument } from "./factory-documents.js";

export interface FactoryExternalPullRequestDiscoveryJournalSnapshot {
  readonly run: FactoryExternalPullRequestDiscoveryRun;
  readonly runDigest: Sha256Digest;
  readonly state: FactoryExternalPullRequestDiscoveryState;
  readonly sequence: number;
  readonly lastEvent: FactoryExternalPullRequestDiscoveryEvent;
  readonly lastEventDigest: Sha256Digest;
  readonly discoverySnapshot: FactoryExternalPullRequestDiscoverySnapshot | null;
}

export interface FactoryExternalPullRequestDiscoveryRepository {
  register(
    run: CanonicalFactoryDocument<FactoryExternalPullRequestDiscoveryRun>,
    event: CanonicalFactoryDocument<FactoryExternalPullRequestDiscoveryEvent>
  ): Promise<FactoryExternalPullRequestDiscoveryJournalSnapshot>;
  findBySlot(input: {
    readonly repositoryId: string;
    readonly schedulePolicyDigest: Sha256Digest;
    readonly scheduledFor: string;
  }): Promise<FactoryExternalPullRequestDiscoveryJournalSnapshot | null>;
  append(
    event: CanonicalFactoryDocument<FactoryExternalPullRequestDiscoveryEvent>
  ): Promise<FactoryExternalPullRequestDiscoveryJournalSnapshot | null>;
  recordSnapshot(
    event: CanonicalFactoryDocument<FactoryExternalPullRequestDiscoveryEvent>,
    snapshot: CanonicalFactoryDocument<FactoryExternalPullRequestDiscoverySnapshot>
  ): Promise<FactoryExternalPullRequestDiscoveryJournalSnapshot | null>;
  close(): void;
}
