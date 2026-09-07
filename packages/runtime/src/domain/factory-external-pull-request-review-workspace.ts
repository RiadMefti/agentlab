import type {
  FactoryExternalPullRequestCandidate,
  FactoryArtifactReference,
  Sha256Digest
} from "@agentlab/contracts";

import type { FactoryWorkspace } from "./factory-workspace.js";

export interface FactoryExternalPullRequestReviewWorkspace {
  readonly workspace: FactoryWorkspace;
  readonly patch: string;
  readonly patchDigest: Sha256Digest;
  readonly patchArtifact: FactoryArtifactReference;
  assertUnchanged(): Promise<void>;
  close(): Promise<void>;
}

/** Materializes only exact locally present Git objects and never fetches a remote. */
export interface FactoryExternalPullRequestReviewWorkspaceManager {
  prepare(input: {
    readonly reviewRunId: string;
    readonly workspaceId: string;
    readonly repositoryRoot: string;
    readonly candidate: FactoryExternalPullRequestCandidate;
    readonly maximumPatchBytes: number;
  }): Promise<FactoryExternalPullRequestReviewWorkspace>;
}
