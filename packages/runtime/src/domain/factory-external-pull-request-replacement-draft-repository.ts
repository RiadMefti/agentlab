import type {
  FactoryExternalPullRequestRepairBundle,
  FactoryExternalPullRequestRepairQualificationBundle,
  FactoryExternalPullRequestRepairQualificationRun,
  FactoryExternalPullRequestReplacementDraftEvent,
  FactoryExternalPullRequestReplacementDraftPolicy,
  FactoryExternalPullRequestReplacementDraftRecord,
  FactoryExternalPullRequestReplacementDraftRun,
  FactoryExternalPullRequestReplacementDraftState,
  Sha256Digest
} from "@agentlab/contracts";

import type { CanonicalFactoryDocument } from "./factory-documents.js";

export interface FactoryExternalPullRequestReplacementDraftCandidate {
  readonly qualificationRun: CanonicalFactoryDocument<FactoryExternalPullRequestRepairQualificationRun>;
  readonly qualificationBundle: CanonicalFactoryDocument<FactoryExternalPullRequestRepairQualificationBundle>;
  readonly repairBundle: CanonicalFactoryDocument<FactoryExternalPullRequestRepairBundle>;
}

export interface FactoryExternalPullRequestReplacementDraftJournalSnapshot {
  readonly run: FactoryExternalPullRequestReplacementDraftRun;
  readonly runDigest: Sha256Digest;
  readonly state: FactoryExternalPullRequestReplacementDraftState;
  readonly sequence: number;
  readonly lastEvent: FactoryExternalPullRequestReplacementDraftEvent;
  readonly lastEventDigest: Sha256Digest;
  readonly history: readonly FactoryExternalPullRequestReplacementDraftEvent[];
  readonly record: FactoryExternalPullRequestReplacementDraftRecord | null;
}

/** Qualified-repair projection plus immutable remote-intent journal. */
export interface FactoryExternalPullRequestReplacementDraftRepository {
  listQualified(input: {
    readonly repositoryId: string;
    readonly qualificationPolicyDigest: Sha256Digest;
    readonly publicationPolicyDigest: Sha256Digest;
    readonly limit: number;
  }): Promise<readonly FactoryExternalPullRequestReplacementDraftCandidate[]>;
  listActive(input: {
    readonly repositoryId: string;
    readonly publicationPolicyDigest: Sha256Digest;
    readonly limit: number;
  }): Promise<readonly FactoryExternalPullRequestReplacementDraftJournalSnapshot[]>;
  findCandidate(
    qualificationBundleDigest: Sha256Digest
  ): Promise<FactoryExternalPullRequestReplacementDraftCandidate | null>;
  register(
    policy: CanonicalFactoryDocument<FactoryExternalPullRequestReplacementDraftPolicy>,
    run: CanonicalFactoryDocument<FactoryExternalPullRequestReplacementDraftRun>,
    event: CanonicalFactoryDocument<FactoryExternalPullRequestReplacementDraftEvent>,
    candidate: FactoryExternalPullRequestReplacementDraftCandidate
  ): Promise<FactoryExternalPullRequestReplacementDraftJournalSnapshot>;
  append(
    event: CanonicalFactoryDocument<FactoryExternalPullRequestReplacementDraftEvent>
  ): Promise<FactoryExternalPullRequestReplacementDraftJournalSnapshot | null>;
  record(
    event: CanonicalFactoryDocument<FactoryExternalPullRequestReplacementDraftEvent>,
    record: CanonicalFactoryDocument<FactoryExternalPullRequestReplacementDraftRecord>
  ): Promise<FactoryExternalPullRequestReplacementDraftJournalSnapshot | null>;
  close(): void;
}
