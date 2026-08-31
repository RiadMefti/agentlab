import type { FactoryPreparationPhase } from "@agentlab/contracts";

export interface FactoryPreparationRecoveryInput {
  readonly taskId: string;
  readonly executionId: string;
  readonly phase: FactoryPreparationPhase;
  readonly attempt: number;
}

/** Proves that neither a provider process nor its disposable workspace remains live after a crash. */
export interface FactoryPreparationRecoveryProbe {
  confirmInactive(input: FactoryPreparationRecoveryInput): Promise<boolean>;
}
