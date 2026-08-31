import {
  factoryIdentifierSchema,
  factoryTimestampSchema,
  type FactoryAgentRunRequest,
  type FactoryExecutionEvent,
  type FactoryExecutionRun,
  type FactoryTaskState,
  type Sha256Digest
} from "@agentlab/contracts";
import { z } from "zod";

import type {
  CanonicalFactoryDocument,
  FactoryDocumentCodec
} from "../domain/factory-documents.js";
import type {
  FactoryExecutionJournalRepository,
  FactoryExecutionJournalRun,
  FactoryExecutionJournalSnapshot,
  FactoryExecutionRepository
} from "../domain/factory-execution-repository.js";
import type { FactoryTaskSnapshot } from "../domain/factory-task-repository.js";

export interface FactoryExecutionJournalDependencies<
  Run extends FactoryExecutionJournalRun = FactoryExecutionRun
> {
  readonly executions: FactoryExecutionJournalRepository<Run>;
  readonly documents: FactoryDocumentCodec;
  readonly now: () => string;
  readonly createId: () => string;
  readonly controlPlaneActorId: string;
}

/** Minimum journal capability required by provider and deterministic-gate operations. */
export interface FactoryExecutionOperationJournal {
  startAgent(request: FactoryAgentRunRequest, requestDigest: Sha256Digest): Promise<void>;
  startGate(gateId: string): Promise<string>;
  finishOperation(
    result: "succeeded" | "failed" | "timed-out" | "error",
    recordDigest: Sha256Digest
  ): Promise<void>;
}

type FinishedTaskState = Extract<
  FactoryTaskState,
  "pr-proposed" | "needs-attention" | "failed" | "quarantined"
>;

/** Serializes caller-owned execution coordinates into the durable journal before side effects. */
export class FactoryExecutionJournalSession<
  Run extends FactoryExecutionJournalRun = FactoryExecutionRun
> implements FactoryExecutionOperationJournal {
  readonly #actor: FactoryExecutionEvent["actor"];

  private constructor(
    private readonly dependencies: FactoryExecutionJournalDependencies<Run>,
    private snapshotValue: FactoryExecutionJournalSnapshot<Run>
  ) {
    this.#actor = policyActor(dependencies.controlPlaneActorId);
  }

  public static async start(
    dependencies: FactoryExecutionJournalDependencies & {
      readonly executions: FactoryExecutionRepository;
    },
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
    return FactoryExecutionJournalSession.register(dependencies, run, "execution-registered");
  }

  public static async register<RegisteredRun extends FactoryExecutionJournalRun>(
    dependencies: FactoryExecutionJournalDependencies<RegisteredRun>,
    run: CanonicalFactoryDocument<RegisteredRun>,
    reasonCode: string
  ): Promise<FactoryExecutionJournalSession<RegisteredRun>> {
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
      occurredAt: run.value.createdAt,
      reasonCode: factoryIdentifierSchema.parse(reasonCode),
      summary: null,
      correlationId: run.value.correlationId
    });
    const snapshot = await dependencies.executions.register(run, registered);
    return new FactoryExecutionJournalSession<RegisteredRun>(dependencies, snapshot);
  }

  public static resume<ResumedRun extends FactoryExecutionJournalRun>(
    dependencies: FactoryExecutionJournalDependencies<ResumedRun>,
    snapshot: FactoryExecutionJournalSnapshot<ResumedRun>
  ): FactoryExecutionJournalSession<ResumedRun> {
    return new FactoryExecutionJournalSession<ResumedRun>(dependencies, snapshot);
  }

  public get snapshot(): FactoryExecutionJournalSnapshot<Run> {
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

function uuid(dependencies: Pick<FactoryExecutionJournalDependencies, "createId">): string {
  return z.uuid().parse(dependencies.createId());
}

function timestamp(dependencies: Pick<FactoryExecutionJournalDependencies, "now">): string {
  return factoryTimestampSchema.parse(dependencies.now());
}
