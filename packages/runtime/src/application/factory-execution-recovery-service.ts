import { factoryIdentifierSchema } from "@agentlab/contracts";
import { z } from "zod";

import type { ConversationRepository } from "../domain/conversation-repository.js";
import type {
  FactoryExecutionRepository,
  FactoryExecutionSnapshot
} from "../domain/factory-execution-repository.js";
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
    correlationId: z.uuid()
  })
  .strict();

export interface FactoryExecutionRecoveryServiceDependencies extends FactoryExecutionJournalDependencies {
  readonly executions: FactoryExecutionRepository;
  readonly tasks: Pick<FactoryTaskRepository, "findById">;
  readonly evidence: Pick<FactoryEvidenceRepository, "latestEvidence">;
  readonly conversations: Pick<ConversationRepository, "findById">;
  readonly controlPlane: Pick<FactoryControlPlane, "transition">;
  readonly workspaces: FactoryWorkspaceRecoveryReconciler;
}

export interface FactoryExecutionRecoveryOutcome {
  readonly execution: FactoryExecutionSnapshot;
  readonly task: FactoryTaskSnapshot;
}

/** Recovers one interrupted execution only after exact process and worktree inactivity proof. */
export class FactoryExecutionRecoveryService {
  readonly #actorId: string;

  public constructor(private readonly dependencies: FactoryExecutionRecoveryServiceDependencies) {
    this.#actorId = factoryIdentifierSchema.parse(dependencies.controlPlaneActorId);
  }

  public async recover(input: unknown): Promise<FactoryExecutionRecoveryOutcome> {
    const command = recoveryCommandSchema.parse(input);
    let execution = await this.dependencies.executions.findByTaskId(command.taskId);
    if (execution === null) throw new Error(`Factory task ${command.taskId} has no execution run.`);
    let task = await this.#requireTask(command.taskId);
    if (execution.state === "completed") return { execution, task };

    if (execution.state !== "abandoned") {
      const active = activeCoordinates(execution);
      if (active !== null) {
        const conversation = await this.dependencies.conversations.findById(
          task.contract.conversationId
        );
        const repositoryRoot =
          conversation?.lifecycleState === "active" ? conversation.workspacePath : null;
        if (repositoryRoot === null) {
          throw new Error("Factory execution recovery requires its active owning conversation.");
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
          throw new Error(`Execution recovery is uncertain: ${result.reasonCode}.`);
        }
      }
      const journal = FactoryExecutionJournalSession.resume(this.dependencies, execution);
      await journal.abandon("execution-interrupted", command.correlationId);
      execution = journal.snapshot;
    }

    task = await this.#terminalize(task);
    return { execution, task };
  }

  async #terminalize(task: FactoryTaskSnapshot): Promise<FactoryTaskSnapshot> {
    if (isTerminalFactoryTaskState(task.state)) return task;
    const preferred =
      task.state === "reviewing" || task.state === "pr-proposed" ? "needs-attention" : "failed";
    const nextState = isFactoryTaskTransitionAllowed(task.state, preferred)
      ? preferred
      : isFactoryTaskTransitionAllowed(task.state, "quarantined")
        ? "quarantined"
        : null;
    if (nextState === null) {
      throw new Error(`Interrupted execution cannot safely terminalize task state ${task.state}.`);
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
      reasonCode: "execution-interrupted",
      evidenceBundleDigest: latest?.digest ?? null
    });
  }

  async #requireTask(taskId: string): Promise<FactoryTaskSnapshot> {
    const task = await this.dependencies.tasks.findById(taskId);
    if (task === null) throw new Error(`Factory task ${taskId} does not exist.`);
    return task;
  }
}

function activeCoordinates(snapshot: FactoryExecutionSnapshot): {
  readonly attempt: number;
  readonly workspaceId: string;
  readonly operationId: string | null;
} | null {
  if (snapshot.state === "ready") return null;
  const event = snapshot.lastEvent;
  if (
    event.kind !== "attempt-started" &&
    event.kind !== "operation-started" &&
    event.kind !== "operation-finished"
  ) {
    throw new Error("Recoverable execution has no exact active resource coordinates.");
  }
  return {
    attempt: event.attempt,
    workspaceId: event.workspaceId,
    operationId: event.kind === "operation-started" ? event.operationId : null
  };
}
