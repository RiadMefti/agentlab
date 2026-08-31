import type { GitObjectId } from "@agentlab/contracts";

export interface FactoryWorkspaceRecoveryInput {
  readonly taskId: string;
  readonly workspaceId: string;
  readonly attempt: number;
  readonly repositoryRoot: string;
  readonly baseRevision: GitObjectId;
  readonly processExecutionIds: readonly string[];
}

export type FactoryWorkspaceRecoveryReason =
  | "process-not-inactive"
  | "process-state-uncertain"
  | "repository-identity-uncertain"
  | "workspace-operation-uncertain"
  | "workspace-identity-uncertain"
  | "workspace-cleanup-unconfirmed";

export type FactoryWorkspaceRecoveryResult =
  | { readonly status: "inactive" }
  | {
      readonly status: "uncertain";
      readonly reasonCode: FactoryWorkspaceRecoveryReason;
    };

/** Proves journal-owned processes inactive, then removes only the exact journal-owned worktree. */
export interface FactoryWorkspaceRecoveryReconciler {
  reconcile(input: FactoryWorkspaceRecoveryInput): Promise<FactoryWorkspaceRecoveryResult>;
}
