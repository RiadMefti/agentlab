import {
  sha256DigestSchema,
  type FactoryPreparationState,
  type FactoryTaskState,
  type Sha256Digest
} from "@agentlab/contracts";
import { z } from "zod";

import type { FactoryExecutionRepository } from "../domain/factory-execution-repository.js";
import type {
  FactoryPreparationRepository,
  FactoryPreparationSnapshot
} from "../domain/factory-preparation-repository.js";
import {
  isFactoryPreparationActiveState,
  isFactoryPreparationRunningState
} from "../domain/factory-preparation-state.js";
import type {
  FactoryTaskRepository,
  FactoryTaskSnapshot
} from "../domain/factory-task-repository.js";
import { isTerminalFactoryTaskState } from "../domain/factory-task-state.js";
import type { FactoryWorkerOperator } from "./factory-worker-operator.js";

const taskRunCommandSchema = z
  .object({
    taskId: z.uuid(),
    correlationId: z.uuid(),
    expectedPolicyBundleDigest: sha256DigestSchema
  })
  .strict();

const postProposalStates = new Set<FactoryTaskState>([
  "pr-open",
  "merge-ready",
  "awaiting-merge-approval",
  "merge-queued",
  "merged",
  "canary",
  "released",
  "observing",
  "completed"
]);

const executionActiveStates = new Set<FactoryTaskState>([
  "executing",
  "verifying",
  "reviewing",
  "repairing"
]);

type FactoryWorkerTaskOperations = Pick<
  FactoryWorkerOperator,
  | "advancePreparation"
  | "recoverPreparation"
  | "materializePreparation"
  | "admitExecution"
  | "execute"
  | "recoverExecution"
>;

export interface FactoryWorkerTaskRunnerDependencies {
  readonly policyBundleDigest: Sha256Digest;
  readonly preparations: Pick<FactoryPreparationRepository, "findById">;
  readonly tasks: Pick<FactoryTaskRepository, "findById">;
  readonly executions: Pick<FactoryExecutionRepository, "findByTaskId">;
  readonly worker: FactoryWorkerTaskOperations;
}

export interface FactoryWorkerTaskRunReport {
  readonly schemaVersion: "agentlab.worker-task-run.v1";
  readonly status: "ready-for-broker" | "already-advanced" | "stopped";
  readonly taskId: string;
  readonly correlationId: string;
  readonly policyBundleDigest: Sha256Digest;
  readonly preparationState: FactoryPreparationState;
  readonly taskState: FactoryTaskState | null;
  readonly contractDigest: Sha256Digest | null;
  readonly reasonCodes: readonly string[];
}

/** Resumes one admitted task through the credentialless worker and stops before remote writes. */
export class FactoryWorkerTaskRunner {
  public constructor(private readonly dependencies: FactoryWorkerTaskRunnerDependencies) {}

  public async run(input: unknown): Promise<FactoryWorkerTaskRunReport> {
    const command = taskRunCommandSchema.parse(input);
    if (command.expectedPolicyBundleDigest !== this.dependencies.policyBundleDigest) {
      throw new Error("Factory worker policy bundle does not match the confirmed digest.");
    }

    let preparation = await this.#requirePreparation(command.taskId);
    this.#assertPreparationIdentity(preparation, command.taskId);
    if (isFactoryPreparationRunningState(preparation.state)) {
      preparation = await this.dependencies.worker.recoverPreparation(journalCommand(command));
      this.#assertPreparationIdentity(preparation, command.taskId);
    }

    let task = await this.dependencies.tasks.findById(command.taskId);
    this.#assertMaterializationPair(preparation, task);
    if (task !== null) {
      this.#assertTaskIdentity(task, preparation);
      const recovered = await this.#recoverExecutionIfNeeded(task, command);
      if (recovered !== null) {
        return this.#taskReport(preparation, recovered, command.correlationId, "stopped", [
          "execution-recovered",
          recovered.lastEvent.reasonCode
        ]);
      }
      const settled = this.#settledTaskReport(preparation, task, command.correlationId);
      if (settled !== null) return settled;
    }

    if (task === null) {
      preparation = await this.#finishPreparation(preparation, command);
      if (preparation.state !== "planned" && preparation.state !== "prepared") {
        return this.#preparationStoppedReport(preparation, command.correlationId);
      }
      if (preparation.state === "planned") {
        const materialized = await this.dependencies.worker.materializePreparation(
          journalCommand(command)
        );
        this.#assertPreparationIdentity(materialized.preparation, command.taskId);
        this.#assertTaskIdentity(materialized.task, materialized.preparation);
        if (
          materialized.preparation.state !== "prepared" ||
          materialized.task.state !== "planned"
        ) {
          throw new Error("Factory materialization did not produce a prepared, planned task.");
        }
        preparation = materialized.preparation;
        task = materialized.task;
      } else {
        task = await this.dependencies.tasks.findById(command.taskId);
        this.#assertMaterializationPair(preparation, task);
        if (task === null) throw new Error("Prepared factory task is missing its task ledger.");
        this.#assertTaskIdentity(task, preparation);
      }
    }

    const settled = this.#settledTaskReport(preparation, task, command.correlationId);
    if (settled !== null) return settled;
    if (task.state === "planned") {
      const admission = await this.dependencies.worker.admitExecution({ taskId: command.taskId });
      this.#assertTaskIdentity(admission.task, preparation);
      if (admission.status !== "queued") {
        return this.#taskReport(preparation, admission.task, command.correlationId, "stopped", [
          `execution-admission-${admission.status}`,
          ...(admission.decision?.reasonCodes ?? [])
        ]);
      }
      if (admission.task.state !== "queued") {
        throw new Error("Factory execution admission reported queued without a queued task.");
      }
      task = admission.task;
    }
    if (task.state !== "queued") {
      throw new Error(`Factory worker cannot execute task state ${task.state}.`);
    }

    const execution = await this.dependencies.worker.execute({
      taskId: command.taskId,
      correlationId: command.correlationId
    });
    this.#assertTaskIdentity(execution.task, preparation);
    if (execution.task.state !== execution.status) {
      throw new Error("Factory execution outcome disagrees with its durable task state.");
    }
    if (execution.status === "pr-proposed") {
      if (execution.patch === null || !execution.usageComplete) {
        throw new Error("Broker-ready execution is missing its patch or complete usage record.");
      }
      return this.#taskReport(
        preparation,
        execution.task,
        command.correlationId,
        "ready-for-broker",
        []
      );
    }
    return this.#taskReport(preparation, execution.task, command.correlationId, "stopped", [
      `execution-${execution.status}`,
      execution.task.lastEvent.reasonCode
    ]);
  }

  async #finishPreparation(
    initial: FactoryPreparationSnapshot,
    command: z.infer<typeof taskRunCommandSchema>
  ): Promise<FactoryPreparationSnapshot> {
    let preparation = initial;
    const maximumSteps = preparation.authority.maximumPreparationAttempts * 3 + 3;
    for (let step = 0; step < maximumSteps; step += 1) {
      if (!isFactoryPreparationActiveState(preparation.state) || preparation.state === "planned") {
        return preparation;
      }
      preparation = isFactoryPreparationRunningState(preparation.state)
        ? await this.dependencies.worker.recoverPreparation(journalCommand(command))
        : await this.dependencies.worker.advancePreparation(journalCommand(command));
      this.#assertPreparationIdentity(preparation, command.taskId);
    }
    throw new Error("Factory preparation exceeded its contract-derived transition ceiling.");
  }

  async #recoverExecutionIfNeeded(
    task: FactoryTaskSnapshot,
    command: z.infer<typeof taskRunCommandSchema>
  ): Promise<FactoryTaskSnapshot | null> {
    const execution = await this.dependencies.executions.findByTaskId(command.taskId);
    if (execution === null) {
      if (
        executionActiveStates.has(task.state) ||
        task.state === "pr-proposed" ||
        postProposalStates.has(task.state)
      ) {
        throw new Error(`Factory task state ${task.state} is missing its execution journal.`);
      }
      return null;
    }
    if (
      execution.run.taskId !== command.taskId ||
      execution.run.contractDigest !== task.contractDigest
    ) {
      throw new Error("Factory execution journal does not match its immutable task contract.");
    }
    if (execution.state === "completed") {
      if (
        task.state === "planned" ||
        task.state === "queued" ||
        executionActiveStates.has(task.state)
      ) {
        throw new Error("Completed factory execution disagrees with its durable task state.");
      }
      return null;
    }
    const recovered = await this.dependencies.worker.recoverExecution({
      taskId: command.taskId,
      correlationId: command.correlationId
    });
    if (
      recovered.execution.run.taskId !== command.taskId ||
      recovered.execution.run.contractDigest !== task.contractDigest ||
      recovered.execution.state !== "abandoned" ||
      recovered.task.contract.taskId !== command.taskId ||
      recovered.task.contractDigest !== task.contractDigest ||
      !isTerminalFactoryTaskState(recovered.task.state)
    ) {
      throw new Error("Factory execution recovery returned different durable coordinates.");
    }
    return recovered.task;
  }

  #settledTaskReport(
    preparation: FactoryPreparationSnapshot,
    task: FactoryTaskSnapshot,
    correlationId: string
  ): FactoryWorkerTaskRunReport | null {
    if (task.state === "planned" || task.state === "queued") return null;
    if (task.state === "pr-proposed") {
      return this.#taskReport(preparation, task, correlationId, "ready-for-broker", []);
    }
    if (postProposalStates.has(task.state)) {
      return this.#taskReport(preparation, task, correlationId, "already-advanced", [
        `task-already-${task.state}`
      ]);
    }
    if (isTerminalFactoryTaskState(task.state) || task.state === "awaiting-execution-approval") {
      return this.#taskReport(preparation, task, correlationId, "stopped", [
        `task-${task.state}`,
        task.lastEvent.reasonCode
      ]);
    }
    throw new Error(`Factory task state ${task.state} has no resumable worker checkpoint.`);
  }

  #preparationStoppedReport(
    preparation: FactoryPreparationSnapshot,
    correlationId: string
  ): FactoryWorkerTaskRunReport {
    return {
      schemaVersion: "agentlab.worker-task-run.v1",
      status: "stopped",
      taskId: preparation.request.taskId,
      correlationId,
      policyBundleDigest: this.dependencies.policyBundleDigest,
      preparationState: preparation.state,
      taskState: null,
      contractDigest: null,
      reasonCodes: uniqueSorted([
        `preparation-${preparation.state}`,
        preparation.lastEvent.reasonCode
      ])
    };
  }

  #taskReport(
    preparation: FactoryPreparationSnapshot,
    task: FactoryTaskSnapshot,
    correlationId: string,
    status: FactoryWorkerTaskRunReport["status"],
    reasonCodes: readonly string[]
  ): FactoryWorkerTaskRunReport {
    return {
      schemaVersion: "agentlab.worker-task-run.v1",
      status,
      taskId: task.contract.taskId,
      correlationId,
      policyBundleDigest: this.dependencies.policyBundleDigest,
      preparationState: preparation.state,
      taskState: task.state,
      contractDigest: task.contractDigest,
      reasonCodes: uniqueSorted(reasonCodes)
    };
  }

  async #requirePreparation(taskId: string): Promise<FactoryPreparationSnapshot> {
    const preparation = await this.dependencies.preparations.findById(taskId);
    if (preparation === null) throw new Error(`Factory preparation ${taskId} does not exist.`);
    return preparation;
  }

  #assertPreparationIdentity(preparation: FactoryPreparationSnapshot, taskId: string): void {
    if (
      preparation.request.taskId !== taskId ||
      preparation.authority.taskId !== taskId ||
      preparation.authority.policyBundleDigest !== this.dependencies.policyBundleDigest
    ) {
      throw new Error("Factory preparation does not match the confirmed task and policy.");
    }
  }

  #assertTaskIdentity(task: FactoryTaskSnapshot, preparation: FactoryPreparationSnapshot): void {
    if (
      preparation.state !== "prepared" ||
      preparation.lastEvent.kind !== "prepared" ||
      preparation.lastEvent.contractDigest !== task.contractDigest ||
      task.contract.taskId !== preparation.request.taskId ||
      task.contract.conversationId !== preparation.request.conversationId ||
      task.contract.repository.id !== preparation.request.repository.id ||
      task.contract.repository.baseRevision !== preparation.request.repository.baseRevision
    ) {
      throw new Error("Factory task ledger does not match its preparation journal.");
    }
  }

  #assertMaterializationPair(
    preparation: FactoryPreparationSnapshot,
    task: FactoryTaskSnapshot | null
  ): void {
    if ((preparation.state === "prepared") !== (task !== null)) {
      throw new Error("Factory preparation and task materialization are inconsistent.");
    }
  }
}

function uniqueSorted(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort();
}

function journalCommand(command: z.infer<typeof taskRunCommandSchema>): {
  readonly taskId: string;
  readonly correlationId: string;
} {
  return { taskId: command.taskId, correlationId: command.correlationId };
}
