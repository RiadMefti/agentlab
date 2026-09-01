import type {
  FactoryArtifactReference,
  FactoryExternalPullRequestCandidate,
  Sha256Digest
} from "@agentlab/contracts";

import type { FactoryWorkspace, FactoryWorkspaceManager } from "./factory-workspace.js";

/** Signals that the exact repair worktree may still exist and must be reconciled from its journal. */
export class FactoryExternalPullRequestRepairWorkspaceCleanupUnconfirmedError extends Error {
  public constructor(message: string, cause: unknown) {
    super(message, { cause });
  }
}

export interface FactoryExternalPullRequestRepairWorkspace {
  readonly workspace: FactoryWorkspace;
  readonly sourcePatch: string;
  readonly sourcePatchDigest: Sha256Digest;
  readonly sourcePatchArtifact: FactoryArtifactReference;
  close(): Promise<void>;
}

/** Materializes and authenticates one exact PR head without fetching any remote object. */
export interface FactoryExternalPullRequestRepairWorkspaceManager {
  prepare(input: {
    readonly repairRunId: string;
    readonly workspaceId: string;
    readonly repositoryRoot: string;
    readonly candidate: FactoryExternalPullRequestCandidate;
    readonly expectedPatchDigest: Sha256Digest;
    readonly maximumPatchBytes: number;
  }): Promise<FactoryExternalPullRequestRepairWorkspace>;
  collect: FactoryWorkspaceManager["collect"];
}
