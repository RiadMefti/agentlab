import type { FactoryChangeSet, GitObjectId } from "@agentlab/contracts";

import type { ManagedRuntimeResource } from "./runtime-resource.js";

export interface FactoryWorkspace extends ManagedRuntimeResource {
  readonly id: string;
  readonly taskId: string;
  readonly attempt: number;
  readonly repositoryRoot: string;
  readonly root: string;
  readonly baseRevision: GitObjectId;
}

export interface FactoryWorkspacePatch {
  readonly patch: string;
  readonly changeSet: FactoryChangeSet;
}

export interface CreateFactoryWorkspaceInput {
  readonly taskId: string;
  readonly attempt: number;
  readonly repositoryRoot: string;
  readonly baseRevision: GitObjectId;
  /** Optional caller-pinned identity used when a durable journal must recover this exact workspace. */
  readonly workspaceId?: string;
}

export interface CollectFactoryWorkspaceInput {
  readonly maximumChangedFiles: number;
  readonly maximumChangedLines: number;
  readonly maximumPatchBytes: number;
}

export interface FactoryWorkspaceManager {
  create(input: CreateFactoryWorkspaceInput): Promise<FactoryWorkspace>;
  apply(workspace: FactoryWorkspace, patch: string, maximumPatchBytes: number): Promise<void>;
  collect(
    workspace: FactoryWorkspace,
    limits: CollectFactoryWorkspaceInput
  ): Promise<FactoryWorkspacePatch>;
}
