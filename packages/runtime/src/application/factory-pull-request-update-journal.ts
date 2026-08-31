import {
  factoryIdentifierSchema,
  factoryTimestampSchema,
  type FactoryPullRequestUpdateEvent,
  type FactoryPullRequestUpdateProposal,
  type FactoryPullRequestUpdateRecord,
  type Sha256Digest
} from "@agentlab/contracts";
import { z } from "zod";

import type {
  CanonicalFactoryDocument,
  FactoryDocumentCodec
} from "../domain/factory-documents.js";
import type {
  FactoryPullRequestUpdateRepository,
  FactoryPullRequestUpdateSnapshot
} from "../domain/factory-pull-request-update-repository.js";

export interface FactoryPullRequestUpdateJournalDependencies {
  readonly updates: FactoryPullRequestUpdateRepository;
  readonly documents: FactoryDocumentCodec;
  readonly brokerId: string;
  readonly now: () => string;
  readonly createId: () => string;
}

/** Persists the repaired proposal and each remote update checkpoint before advancing. */
export class FactoryPullRequestUpdateJournalSession {
  readonly #actor: FactoryPullRequestUpdateEvent["actor"];

  private constructor(
    private readonly dependencies: FactoryPullRequestUpdateJournalDependencies,
    private snapshotValue: FactoryPullRequestUpdateSnapshot
  ) {
    this.#actor = brokerActor(dependencies.brokerId);
    if (snapshotValue.run.brokerId !== this.#actor.id) {
      throw new Error("PR update journal broker identity differs from its immutable run.");
    }
  }

  public static async start(
    dependencies: FactoryPullRequestUpdateJournalDependencies,
    proposal: CanonicalFactoryDocument<FactoryPullRequestUpdateProposal>,
    correlationId: string
  ): Promise<FactoryPullRequestUpdateJournalSession> {
    const parsedCorrelationId = z.uuid().parse(correlationId);
    if (
      (await dependencies.updates.findByAuthorizationDigest(
        proposal.value.repairAuthorizationDigest
      )) !== null
    ) {
      throw new Error("Repair authorization already has a pull-request update journal.");
    }
    const run = dependencies.documents.pullRequestUpdateRun({
      schemaVersion: "agentlab.pull-request-update.v1",
      updateId: uuid(dependencies),
      taskId: proposal.value.taskId,
      contractDigest: proposal.value.contractDigest,
      proposalDigest: proposal.digest,
      proposal: proposal.value,
      brokerId: factoryIdentifierSchema.parse(dependencies.brokerId),
      createdAt: proposal.value.createdAt,
      correlationId: parsedCorrelationId
    });
    const registered = dependencies.documents.pullRequestUpdateEvent({
      schemaVersion: "agentlab.pull-request-update-event.v1",
      eventId: uuid(dependencies),
      updateId: run.value.updateId,
      updateDigest: run.digest,
      taskId: run.value.taskId,
      contractDigest: run.value.contractDigest,
      sequence: 1,
      previousEventDigest: null,
      kind: "registered",
      from: null,
      to: "ready",
      actor: brokerActor(dependencies.brokerId),
      occurredAt: run.value.createdAt,
      reasonCode: "pull-request-update-registered",
      summary: null,
      correlationId: parsedCorrelationId
    });
    const snapshot = await dependencies.updates.register(run, registered);
    return new FactoryPullRequestUpdateJournalSession(dependencies, snapshot);
  }

  public static resume(
    dependencies: FactoryPullRequestUpdateJournalDependencies,
    snapshot: FactoryPullRequestUpdateSnapshot
  ): FactoryPullRequestUpdateJournalSession {
    return new FactoryPullRequestUpdateJournalSession(dependencies, snapshot);
  }

  public get snapshot(): FactoryPullRequestUpdateSnapshot {
    return this.snapshotValue;
  }

  public async startUpdate(): Promise<void> {
    await this.#append({
      kind: "update-started",
      from: "ready",
      to: "update-active",
      reasonCode: "remote-draft-update-started"
    });
  }

  public async observeRemote(
    record: FactoryPullRequestUpdateRecord,
    updated: boolean
  ): Promise<void> {
    await this.#append({
      kind: "remote-updated",
      from: "update-active",
      to: "remote-updated",
      record,
      updated,
      reasonCode: updated ? "remote-draft-updated" : "remote-draft-update-reconciled"
    });
  }

  public async recordEvidence(evidenceBundleDigest: Sha256Digest): Promise<void> {
    await this.#append({
      kind: "evidence-recorded",
      from: "remote-updated",
      to: "evidence-recorded",
      evidenceBundleDigest,
      reasonCode: "remote-draft-update-evidence-recorded"
    });
  }

  public async complete(taskEventDigest: Sha256Digest): Promise<void> {
    await this.#append({
      kind: "task-recorded",
      from: "evidence-recorded",
      to: "completed",
      taskEventDigest,
      reasonCode: "remote-draft-update-task-recorded"
    });
  }

  async #append(fields: Readonly<Record<string, unknown>>): Promise<void> {
    const event = this.dependencies.documents.pullRequestUpdateEvent({
      schemaVersion: "agentlab.pull-request-update-event.v1",
      eventId: uuid(this.dependencies),
      updateId: this.snapshotValue.run.updateId,
      updateDigest: this.snapshotValue.runDigest,
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
    const appended = await this.dependencies.updates.append(event);
    if (appended === null) throw new Error("Pull-request update journal lost its append race.");
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

function uuid(dependencies: FactoryPullRequestUpdateJournalDependencies): string {
  return z.uuid().parse(dependencies.createId());
}

function timestamp(dependencies: FactoryPullRequestUpdateJournalDependencies): string {
  return factoryTimestampSchema.parse(dependencies.now());
}
