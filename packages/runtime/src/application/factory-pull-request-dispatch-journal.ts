import {
  factoryIdentifierSchema,
  factoryTimestampSchema,
  type FactoryPullRequestDispatchEvent,
  type FactoryPullRequestProposal,
  type FactoryPullRequestRecord,
  type Sha256Digest
} from "@agentlab/contracts";
import { z } from "zod";

import type {
  CanonicalFactoryDocument,
  FactoryDocumentCodec
} from "../domain/factory-documents.js";
import type {
  FactoryPullRequestDispatchRepository,
  FactoryPullRequestDispatchSnapshot
} from "../domain/factory-pull-request-dispatch-repository.js";

export interface FactoryPullRequestDispatchJournalDependencies {
  readonly dispatches: FactoryPullRequestDispatchRepository;
  readonly documents: FactoryDocumentCodec;
  readonly brokerId: string;
  readonly now: () => string;
  readonly createId: () => string;
}

/** Persists the exact proposal and each remote-authority checkpoint before advancing. */
export class FactoryPullRequestDispatchJournalSession {
  readonly #actor: FactoryPullRequestDispatchEvent["actor"];

  private constructor(
    private readonly dependencies: FactoryPullRequestDispatchJournalDependencies,
    private snapshotValue: FactoryPullRequestDispatchSnapshot
  ) {
    this.#actor = brokerActor(dependencies.brokerId);
    if (snapshotValue.run.brokerId !== this.#actor.id) {
      throw new Error("Dispatch journal broker identity differs from its immutable run.");
    }
  }

  public static async start(
    dependencies: FactoryPullRequestDispatchJournalDependencies,
    proposal: CanonicalFactoryDocument<FactoryPullRequestProposal>,
    correlationId: string
  ): Promise<FactoryPullRequestDispatchJournalSession> {
    const parsedCorrelationId = z.uuid().parse(correlationId);
    if ((await dependencies.dispatches.findByTaskId(proposal.value.taskId)) !== null) {
      throw new Error("Factory task already has a pull-request dispatch journal.");
    }
    const run = dependencies.documents.pullRequestDispatchRun({
      schemaVersion: "agentlab.pull-request-dispatch.v1",
      dispatchId: uuid(dependencies),
      taskId: proposal.value.taskId,
      contractDigest: proposal.value.contractDigest,
      proposalDigest: proposal.digest,
      proposal: proposal.value,
      brokerId: factoryIdentifierSchema.parse(dependencies.brokerId),
      createdAt: proposal.value.createdAt,
      correlationId: parsedCorrelationId
    });
    const registered = dependencies.documents.pullRequestDispatchEvent({
      schemaVersion: "agentlab.pull-request-dispatch-event.v1",
      eventId: uuid(dependencies),
      dispatchId: run.value.dispatchId,
      dispatchDigest: run.digest,
      taskId: run.value.taskId,
      contractDigest: run.value.contractDigest,
      sequence: 1,
      previousEventDigest: null,
      kind: "registered",
      from: null,
      to: "ready",
      actor: brokerActor(dependencies.brokerId),
      occurredAt: run.value.createdAt,
      reasonCode: "pull-request-dispatch-registered",
      summary: null,
      correlationId: parsedCorrelationId
    });
    const snapshot = await dependencies.dispatches.register(run, registered);
    return new FactoryPullRequestDispatchJournalSession(dependencies, snapshot);
  }

  public static resume(
    dependencies: FactoryPullRequestDispatchJournalDependencies,
    snapshot: FactoryPullRequestDispatchSnapshot
  ): FactoryPullRequestDispatchJournalSession {
    return new FactoryPullRequestDispatchJournalSession(dependencies, snapshot);
  }

  public get snapshot(): FactoryPullRequestDispatchSnapshot {
    return this.snapshotValue;
  }

  public async startDispatch(): Promise<void> {
    await this.#append({
      kind: "dispatch-started",
      from: "ready",
      to: "dispatch-active",
      reasonCode: "remote-draft-dispatch-started"
    });
  }

  public async observeRemote(record: FactoryPullRequestRecord, created: boolean): Promise<void> {
    await this.#append({
      kind: "remote-observed",
      from: "dispatch-active",
      to: "remote-open",
      record,
      created,
      reasonCode: created ? "remote-draft-created" : "remote-draft-reconciled"
    });
  }

  public async recordEvidence(evidenceBundleDigest: Sha256Digest): Promise<void> {
    await this.#append({
      kind: "evidence-recorded",
      from: "remote-open",
      to: "evidence-recorded",
      evidenceBundleDigest,
      reasonCode: "remote-draft-evidence-recorded"
    });
  }

  public async complete(taskEventDigest: Sha256Digest): Promise<void> {
    await this.#append({
      kind: "task-recorded",
      from: "evidence-recorded",
      to: "completed",
      taskEventDigest,
      reasonCode: "remote-draft-task-recorded"
    });
  }

  async #append(fields: Readonly<Record<string, unknown>>): Promise<void> {
    const event = this.dependencies.documents.pullRequestDispatchEvent({
      schemaVersion: "agentlab.pull-request-dispatch-event.v1",
      eventId: uuid(this.dependencies),
      dispatchId: this.snapshotValue.run.dispatchId,
      dispatchDigest: this.snapshotValue.runDigest,
      taskId: this.snapshotValue.run.taskId,
      contractDigest: this.snapshotValue.run.contractDigest,
      sequence: this.snapshotValue.sequence + 1,
      previousEventDigest: this.snapshotValue.lastEventDigest,
      actor: this.#actor,
      occurredAt: timestamp(this.dependencies),
      summary: null,
      correlationId: this.snapshotValue.run.correlationId,
      ...fields
    });
    const appended = await this.dependencies.dispatches.append(event);
    if (appended === null) throw new Error("Pull-request dispatch journal lost its append race.");
    this.snapshotValue = appended;
  }
}

function brokerActor(id: string) {
  return {
    kind: "broker",
    role: "pr-broker",
    id: factoryIdentifierSchema.parse(id),
    sessionId: null
  } as const;
}

function uuid(dependencies: FactoryPullRequestDispatchJournalDependencies): string {
  return z.uuid().parse(dependencies.createId());
}

function timestamp(dependencies: FactoryPullRequestDispatchJournalDependencies): string {
  return factoryTimestampSchema.parse(dependencies.now());
}
