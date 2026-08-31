import { factoryIdentifierSchema, sha256DigestSchema } from "@agentlab/contracts";
import { z } from "zod";

import type { ConversationRepository } from "../domain/conversation-repository.js";
import { activeFactoryExecutionSnapshotCoordinates } from "../domain/factory-execution-integrity.js";
import type {
  FactoryPullRequestRepairExecutionRepository,
  FactoryPullRequestRepairExecutionSnapshot
} from "../domain/factory-pull-request-repair-execution-repository.js";
import type {
  FactoryEvidenceRepository,
  FactoryTaskRepository,
  FactoryTaskSnapshot
} from "../domain/factory-task-repository.js";
import {
  isFactoryTaskTransitionAllowed,
  isTerminalFactoryTaskState
} from "../domain/factory-task-state.js";
import type { FactoryWorkspaceRecoveryReconciler } from "../domain/factory-workspace-recovery.js";
import type { FactoryControlPlane } from "./factory-control-plane.js";
import {
  FactoryExecutionJournalSession,
  type FactoryExecutionJournalDependencies
} from "./factory-execution-journal.js";

const recoveryCommandSchema = z
  .object({
    taskId: z.uuid(),
    authorizationDigest: sha256DigestSchema,
    correlationId: z.uuid()
  })
  .strict();

export interface FactoryPullRequestRepairRecoveryServiceDependencies extends FactoryExecutionJournalDependencies<
  FactoryPullRequestRepairExecutionSnapshot["run"]
> {
  readonly executions: FactoryPullRequestRepairExecutionRepository;
  readonly tasks: Pick<FactoryTaskRepository, "findById">;
  readonly evidence: Pick<FactoryEvidenceRepository, "latestEvidence">;
  readonly conversations: Pick<ConversationRepository, "findById">;
  readonly controlPlane: Pick<FactoryControlPlane, "transition">;
  readonly workspaces: FactoryWorkspaceRecoveryReconciler;
}

export interface FactoryPullRequestRepairRecoveryOutcome {
  readonly execution: FactoryPullRequestRepairExecutionSnapshot;
  readonly task: FactoryTaskSnapshot;
}

/** Abandons an interrupted repair only after exact process and worktree inactivity proof. */
export class FactoryPullRequestRepairRecoveryService {
  readonly #actorId: string;

  public constructor(
    private readonly dependencies: FactoryPullRequestRepairRecoveryServiceDependencies
  ) {
    this.#actorId = factoryIdentifierSchema.parse(dependencies.controlPlaneActorId);
  }

  public async recover(input: unknown): Promise<FactoryPullRequestRepairRecoveryOutcome> {
    const command = recoveryCommandSchema.parse(input);
    let execution = await this.dependencies.executions.findByAuthorizationDigest(
      command.authorizationDigest
    );
    if (execution?.run.taskId !== command.taskId) {
      throw new Error("Factory task has no matching PR repair execution.");
    }
    let task = await this.#requireTask(command.taskId);
    if (
      execution.run.contractDigest !== task.contractDigest ||
      execution.run.repository.id !== task.contract.repository.id ||
      execution.run.repository.baseRevision !== task.contract.repository.baseRevision
    ) {
      throw new Error("PR repair execution does not match its immutable task contract.");
    }
    if (execution.state === "completed") return { execution, task };

    if (execution.state !== "abandoned") {
      const active = activeFactoryExecutionSnapshotCoordinates(execution);
      if (active !== null) {
        const conversation = await this.dependencies.conversations.findById(
          task.contract.conversationId
        );
        const repositoryRoot =
          conversation?.lifecycleState === "active" ? conversation.workspacePath : null;
        if (repositoryRoot === null) {
          throw new Error("PR repair recovery requires its active owning conversation.");
        }
        const result = await this.dependencies.workspaces.reconcile({
          taskId: task.contract.taskId,
          workspaceId: active.workspaceId,
          attempt: active.attempt,
          repositoryRoot,
          baseRevision: task.contract.repository.baseRevision,
          processExecutionIds: active.operationId === null ? [] : [active.operationId]
        });
        if (result.status !== "inactive") {
          throw new Error(`PR repair recovery is uncertain: ${result.reasonCode}.`);
        }
      }
      const journal = FactoryExecutionJournalSession.resume(this.dependencies, execution);
      await journal.abandon("pr-repair-interrupted", command.correlationId);
      execution = journal.snapshot;
    }

    task = await this.#terminalize(task);
    return { execution, task };
  }

  async #terminalize(task: FactoryTaskSnapshot): Promise<FactoryTaskSnapshot> {
    if (isTerminalFactoryTaskState(task.state)) return task;
    const nextState = isFactoryTaskTransitionAllowed(task.state, "needs-attention")
      ? "needs-attention"
      : isFactoryTaskTransitionAllowed(task.state, "quarantined")
        ? "quarantined"
        : null;
    if (nextState === null) {
      throw new Error(`Interrupted PR repair cannot terminalize task state ${task.state}.`);
    }
    const latest = await this.dependencies.evidence.latestEvidence(task.contract.taskId);
    return this.dependencies.controlPlane.transition({
      taskId: task.contract.taskId,
      expectedState: task.state,
      nextState,
      actor: {
        kind: "control-plane",
        role: "policy-engine",
        id: this.#actorId,
        sessionId: null
      },
      reasonCode: "pr-repair-interrupted",
      evidenceBundleDigest: latest?.digest ?? null
    });
  }

  async #requireTask(taskId: string): Promise<FactoryTaskSnapshot> {
    const task = await this.dependencies.tasks.findById(taskId);
    if (task === null) throw new Error(`Factory task ${taskId} does not exist.`);
    return task;
  }
}
