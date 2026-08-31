import type {
  FactoryPreparationRecoveryInput,
  FactoryPreparationRecoveryReconciler,
  FactoryPreparationRecoveryResult
} from "../../domain/factory-preparation-recovery.js";
import type { CommandRunner } from "../process/command-runner.js";
import {
  LocalFactoryWorkspaceRecovery,
  type LocalFactoryWorkspaceRecoveryOptions
} from "./local-factory-workspace-recovery.js";

export type LocalFactoryPreparationRecoveryOptions = LocalFactoryWorkspaceRecoveryOptions;

/** Preparation-specific adapter over the shared exact workspace/process reconciler. */
export class LocalFactoryPreparationRecovery implements FactoryPreparationRecoveryReconciler {
  readonly #workspaces: LocalFactoryWorkspaceRecovery;

  public constructor(runner: CommandRunner, options: LocalFactoryPreparationRecoveryOptions) {
    this.#workspaces = new LocalFactoryWorkspaceRecovery(runner, options);
  }

  public async reconcile(
    input: FactoryPreparationRecoveryInput
  ): Promise<FactoryPreparationRecoveryResult> {
    const result = await this.#workspaces.reconcile({
      taskId: input.taskId,
      workspaceId: input.executionId,
      attempt: input.attempt,
      repositoryRoot: input.repositoryRoot,
      baseRevision: input.baseRevision,
      processExecutionIds: [input.executionId]
    });
    return result.status === "inactive"
      ? result
      : { status: "uncertain", reasonCode: `preparation-${result.reasonCode}` };
  }
}
