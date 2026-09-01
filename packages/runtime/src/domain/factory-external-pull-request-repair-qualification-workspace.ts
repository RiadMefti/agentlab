import type {
  FactoryArtifactReference,
  FactoryChangeSet,
  GitObjectId,
  Sha256Digest
} from "@agentlab/contracts";

import type { FactoryWorkspace } from "./factory-workspace.js";

export class FactoryExternalPullRequestRepairQualificationWorkspaceCleanupUnconfirmedError extends Error {
  public constructor(message: string, cause: unknown) {
    super(message, { cause });
  }
}

export interface FactoryExternalPullRequestRepairQualificationWorkspace {
  readonly workspace: FactoryWorkspace;
  readonly patch: string;
  readonly patchDigest: Sha256Digest;
  readonly patchArtifact: FactoryArtifactReference;
  readonly changeSet: FactoryChangeSet;
  assertUnchanged(): Promise<void>;
  close(): Promise<void>;
}

export interface FactoryExternalPullRequestRepairQualificationWorkspaceManager {
  prepare(input: {
    readonly qualificationRunId: string;
    readonly workspaceId: string;
    readonly repositoryRoot: string;
    readonly expectedHeadRevision: GitObjectId;
    readonly patch: string;
    readonly expectedPatchDigest: Sha256Digest;
    readonly expectedChangeSet: FactoryChangeSet;
    readonly maximumPatchBytes: number;
  }): Promise<FactoryExternalPullRequestRepairQualificationWorkspace>;
}
