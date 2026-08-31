import type { FactoryPreparationPhase, GitObjectId } from "@agentlab/contracts";

export interface FactoryPreparationRecoveryInput {
  readonly taskId: string;
  readonly executionId: string;
  readonly phase: FactoryPreparationPhase;
  readonly attempt: number;
  readonly repositoryRoot: string;
  readonly baseRevision: GitObjectId;
}

export type FactoryPreparationRecoveryResult =
  | { readonly status: "inactive" }
  | {
      readonly status: "uncertain";
      readonly reasonCode:
        | "preparation-process-not-inactive"
        | "preparation-process-state-uncertain"
        | "preparation-repository-identity-uncertain"
        | "preparation-workspace-operation-uncertain"
        | "preparation-workspace-identity-uncertain"
        | "preparation-workspace-cleanup-unconfirmed";
    };

/** Reconciles the exact journal-owned process/workspace and proves both inactive after a crash. */
export interface FactoryPreparationRecoveryReconciler {
  reconcile(input: FactoryPreparationRecoveryInput): Promise<FactoryPreparationRecoveryResult>;
}
