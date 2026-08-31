import {
  factoryIdentifierSchema,
  factoryTimestampSchema,
  type FactoryAgentRunRequest,
  type FactoryExecutionEvent,
  type FactoryTaskState,
  type Sha256Digest
} from "@agentlab/contracts";
import { z } from "zod";

import type { FactoryDocumentCodec } from "../domain/factory-documents.js";
import type {
  FactoryExecutionRepository,
  FactoryExecutionSnapshot
} from "../domain/factory-execution-repository.js";
import type { FactoryTaskSnapshot } from "../domain/factory-task-repository.js";

export interface FactoryExecutionJournalDependencies {
  readonly executions: FactoryExecutionRepository;
  readonly documents: FactoryDocumentCodec;
  readonly now: () => string;
  readonly createId: () => string;
  readonly controlPlaneActorId: string;
}

type FinishedTaskState = Extract<
  FactoryTaskState,
  "pr-proposed" | "needs-attention" | "failed" | "quarantined"
>;

/** Serializes caller-owned execution coordinates into the durable journal before side effects. */
export class FactoryExecutionJournalSession {
  readonly #actor: FactoryExecutionEvent["actor"];

  private constructor(
    private readonly dependencies: FactoryExecutionJournalDependencies,
    private snapshotValue: FactoryExecutionSnapshot
  ) {
    this.#actor = policyActor(dependencies.controlPlaneActorId);
  }

  public static async start(
    dependencies: FactoryExecutionJournalDependencies,
    task: FactoryTaskSnapshot,
    correlationId: string
  ): Promise<FactoryExecutionJournalSession> {
    const parsedCorrelationId = z.uuid().parse(correlationId);
    if ((await dependencies.executions.findByTaskId(task.contract.taskId)) !== null) {
      throw new Error("Factory task already has an execution journal.");
    }
    const createdAt = timestamp(dependencies);
    const run = dependencies.documents.executionRun({
      schemaVersion: "agentlab.execution-run.v1",
      runId: uuid(dependencies),
      taskId: task.contract.taskId,
      contractDigest: task.contractDigest,
      repository: task.contract.repository,
      maximumAttempts: task.contract.budget.maxRepairAttempts + 1,
      createdAt,
      correlationId: parsedCorrelationId
    });
    const registered = dependencies.documents.executionEvent({
      schemaVersion: "agentlab.execution-event.v1",
      eventId: uuid(dependencies),
      runId: run.value.runId,
      runDigest: run.digest,
      taskId: run.value.taskId,
      contractDigest: run.value.contractDigest,
      sequence: 1,
      previousEventDigest: null,
      kind: "registered",
      from: null,
      to: "ready",
      actor: policyActor(dependencies.controlPlaneActorId),
      occurredAt: createdAt,
      reasonCode: "execution-registered",
      summary: null,
      correlationId: parsedCorrelationId
    });
    const snapshot = await dependencies.executions.register(run, registered);
    return new FactoryExecutionJournalSession(dependencies, snapshot);
  }

  public static resume(
    dependencies: FactoryExecutionJournalDependencies,
    snapshot: FactoryExecutionSnapshot
  ): FactoryExecutionJournalSession {
    return new FactoryExecutionJournalSession(dependencies, snapshot);
  }

  public get snapshot(): FactoryExecutionSnapshot {
    return this.snapshotValue;
  }

  public async startAttempt(attempt: number): Promise<string> {
    const workspaceId = uuid(this.dependencies);
    await this.#append({
      kind: "attempt-started",
      from: "ready",
      to: "workspace-active",
      attempt,
      workspaceId,
      reasonCode: "execution-attempt-started"
    });
    return workspaceId;
  }

  public async startAgent(
    request: FactoryAgentRunRequest,
    requestDigest: Sha256Digest
  ): Promise<void> {
    const active = this.#activeAttempt();
    if (request.attempt !== active.attempt) {
      throw new Error("Agent request attempt does not match its active execution workspace.");
    }
    await this.#append({
      kind: "operation-started",
      from: "workspace-active",
      to: "operation-active",
      ...active,
      operationKind: "agent",
      operationId: request.executionId,
      role: request.role,
      gateId: null,
      requestDigest,
      reasonCode: `${request.role}-operation-started`
    });
  }

  public async startGate(gateId: string): Promise<string> {
    const operationId = uuid(this.dependencies);
    await this.#append({
      kind: "operation-started",
      from: "workspace-active",
      to: "operation-active",
      ...this.#activeAttempt(),
      operationKind: "gate",
      operationId,
      role: null,
      gateId: factoryIdentifierSchema.parse(gateId),
      requestDigest: null,
      reasonCode: "gate-operation-started"
    });
    return operationId;
  }

  public async finishOperation(
    result: "succeeded" | "failed" | "timed-out" | "error",
    recordDigest: Sha256Digest
  ): Promise<void> {
    const started = this.snapshotValue.lastEvent;
    if (started.kind !== "operation-started") {
      throw new Error("Execution journal has no active operation to finish.");
    }
    await this.#append({
      kind: "operation-finished",
      from: "operation-active",
      to: "workspace-active",
      attempt: started.attempt,
      workspaceId: started.workspaceId,
      operationKind: started.operationKind,
      operationId: started.operationId,
      role: started.role,
      gateId: started.gateId,
      requestDigest: started.requestDigest,
      result,
      recordDigest,
      reasonCode: "execution-operation-finished"
    });
  }

  public async closeAttempt(disposition: "continue" | "finish"): Promise<void> {
    const active = this.#activeAttempt();
    await this.#append({
      kind: "attempt-closed",
      from: "workspace-active",
      to: "ready",
      ...active,
      disposition,
      reasonCode: "execution-workspace-closed"
    });
  }

  public async finish(taskState: FinishedTaskState): Promise<void> {
    await this.#append({
      kind: "execution-finished",
      from: "ready",
      to: "completed",
      taskState,
      reasonCode: "execution-finished"
    });
  }

  public async abandon(reasonCode: string, correlationId: string): Promise<void> {
    const last = this.snapshotValue.lastEvent;
    const active = this.#activeAttemptOrNull();
    await this.#append(
      {
        kind: "execution-abandoned",
        from: last.to,
        to: "abandoned",
        attempt: active?.attempt ?? null,
        workspaceId: active?.workspaceId ?? null,
        operationId: active?.operationId ?? null,
        reasonCode: factoryIdentifierSchema.parse(reasonCode)
      },
      z.uuid().parse(correlationId)
    );
  }

  async #append(
    fields: Readonly<Record<string, unknown>>,
    correlationId = this.snapshotValue.run.correlationId
  ): Promise<void> {
    const event = this.dependencies.documents.executionEvent({
      schemaVersion: "agentlab.execution-event.v1",
      eventId: uuid(this.dependencies),
      runId: this.snapshotValue.run.runId,
      runDigest: this.snapshotValue.runDigest,
      taskId: this.snapshotValue.run.taskId,
      contractDigest: this.snapshotValue.run.contractDigest,
      sequence: this.snapshotValue.sequence + 1,
      previousEventDigest: this.snapshotValue.lastEventDigest,
      actor: this.#actor,
      occurredAt: timestamp(this.dependencies),
      summary: null,
      correlationId,
      ...fields
    });
    const appended = await this.dependencies.executions.append(event);
    if (appended === null) throw new Error("Execution journal lost its append race.");
    this.snapshotValue = appended;
  }

  #activeAttempt(): { readonly attempt: number; readonly workspaceId: string } {
    const active = this.#activeAttemptOrNull();
    if (active?.operationId !== null) {
      throw new Error("Execution journal has no idle active workspace.");
    }
    return { attempt: active.attempt, workspaceId: active.workspaceId };
  }

  #activeAttemptOrNull(): {
    readonly attempt: number;
    readonly workspaceId: string;
    readonly operationId: string | null;
  } | null {
    const last = this.snapshotValue.lastEvent;
    if (last.to !== "workspace-active" && last.to !== "operation-active") return null;
    return {
      attempt: last.attempt,
      workspaceId: last.workspaceId,
      operationId: last.kind === "operation-started" ? last.operationId : null
    };
  }
}

function policyActor(id: string) {
  return {
    kind: "control-plane",
    role: "policy-engine",
    id: factoryIdentifierSchema.parse(id),
    sessionId: null
  } as const;
}

function uuid(dependencies: FactoryExecutionJournalDependencies): string {
  return z.uuid().parse(dependencies.createId());
}

function timestamp(dependencies: FactoryExecutionJournalDependencies): string {
  return factoryTimestampSchema.parse(dependencies.now());
}
