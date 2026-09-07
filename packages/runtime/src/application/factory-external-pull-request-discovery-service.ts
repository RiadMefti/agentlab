import {
  factoryTimestampSchema,
  sha256DigestSchema,
  type FactoryActor,
  type FactoryExternalPullRequestDiscoveryEvent,
  type FactoryExternalPullRequestDiscoveryPolicy,
  type FactorySchedulePolicy,
  type Sha256Digest
} from "@agentlab/contracts";
import { z } from "zod";

import type { FactoryArtifactStore } from "../domain/factory-artifact-store.js";
import type {
  FactoryExternalPullRequestDiscoveryJournalSnapshot,
  FactoryExternalPullRequestDiscoveryRepository
} from "../domain/factory-external-pull-request-discovery-repository.js";
import { classifyExternalPullRequest } from "../domain/factory-external-pull-request-policy.js";
import type {
  FactoryExternalPullRequestSource,
  FactoryOwnedPullRequestIndex
} from "../domain/factory-external-pull-request-source.js";
import type {
  CanonicalFactoryDocument,
  FactoryDocumentCodec
} from "../domain/factory-documents.js";
import { resolveFactoryDailyScheduleSlot } from "../domain/factory-schedule-time.js";

const tickInputSchema = z
  .object({
    expectedDiscoveryPolicyDigest: sha256DigestSchema,
    expectedSchedulePolicyDigest: sha256DigestSchema
  })
  .strict();

export interface FactoryExternalPullRequestDiscoveryPreflight {
  readonly schemaVersion: "agentlab.external-pull-request-discovery-preflight.v1";
  readonly status: "ready" | "blocked";
  readonly repositoryId: string;
  readonly repositoryNumericId: number;
  readonly defaultBranch: string;
  readonly observerId: string;
  readonly discoveryPolicyDigest: Sha256Digest;
  readonly schedulePolicyDigest: Sha256Digest;
  readonly reasonCodes: readonly string[];
}

export interface FactoryExternalPullRequestDiscoveryTickReport {
  readonly schemaVersion: "agentlab.external-pull-request-discovery-tick-result.v1";
  readonly status: "completed" | "already-completed" | "blocked" | "failed";
  readonly repositoryId: string;
  readonly observerId: string;
  readonly discoveryPolicyDigest: Sha256Digest;
  readonly schedulePolicyDigest: Sha256Digest;
  readonly scheduledFor: string;
  readonly runId: string | null;
  readonly runDigest: Sha256Digest | null;
  readonly snapshotDigest: Sha256Digest | null;
  readonly pullRequestsInspected: number;
  readonly agentReviewCandidates: number;
  readonly humanReviewRequired: number;
  readonly deferred: number;
  readonly factoryOwned: number;
  readonly hasMore: boolean;
  readonly reasonCodes: readonly string[];
}

export interface FactoryExternalPullRequestDiscoveryServiceDependencies {
  readonly repositoryId: string;
  readonly observerId: string;
  readonly discoveryPolicy: CanonicalFactoryDocument<FactoryExternalPullRequestDiscoveryPolicy>;
  readonly schedulePolicy: CanonicalFactoryDocument<FactorySchedulePolicy>;
  readonly source: FactoryExternalPullRequestSource;
  readonly ownedPullRequests: Pick<FactoryOwnedPullRequestIndex, "contains">;
  readonly repository: FactoryExternalPullRequestDiscoveryRepository;
  readonly artifacts: FactoryArtifactStore;
  readonly documents: FactoryDocumentCodec;
  readonly now: () => string;
  readonly createId: () => string;
}

type DiscoveryEventPayload<
  Event extends FactoryExternalPullRequestDiscoveryEvent = FactoryExternalPullRequestDiscoveryEvent
> = Event extends FactoryExternalPullRequestDiscoveryEvent
  ? Omit<
      Event,
      | "schemaVersion"
      | "eventId"
      | "runId"
      | "runDigest"
      | "sequence"
      | "previousEventDigest"
      | "actor"
      | "occurredAt"
      | "correlationId"
    > & { readonly occurredAt?: string }
  : never;

/** One idempotent daily remote-read slot; output is immutable evidence and never write authority. */
export class FactoryExternalPullRequestDiscoveryService {
  public constructor(
    private readonly dependencies: FactoryExternalPullRequestDiscoveryServiceDependencies
  ) {
    const identity = dependencies.source.identity();
    if (
      identity.repositoryId !== dependencies.repositoryId ||
      identity.observerId !== dependencies.observerId ||
      dependencies.discoveryPolicy.value.repositoryId !== dependencies.repositoryId
    ) {
      throw new Error("External PR discovery composition identities do not match.");
    }
  }

  public async preflight(): Promise<FactoryExternalPullRequestDiscoveryPreflight> {
    const remote = await this.dependencies.source.inspectRepository();
    if (remote.repositoryId !== this.dependencies.repositoryId) {
      throw new Error("External PR discovery preflight returned another repository.");
    }
    const reasonCodes = this.dependencies.discoveryPolicy.value.allowedBaseBranches.includes(
      remote.defaultBranch
    )
      ? []
      : ["default-base-branch-not-admitted"];
    return {
      schemaVersion: "agentlab.external-pull-request-discovery-preflight.v1",
      status: reasonCodes.length === 0 ? "ready" : "blocked",
      repositoryId: remote.repositoryId,
      repositoryNumericId: remote.repositoryNumericId,
      defaultBranch: remote.defaultBranch,
      observerId: this.dependencies.observerId,
      discoveryPolicyDigest: this.dependencies.discoveryPolicy.digest,
      schedulePolicyDigest: this.dependencies.schedulePolicy.digest,
      reasonCodes
    };
  }

  public async tick(input: unknown): Promise<FactoryExternalPullRequestDiscoveryTickReport> {
    const command = tickInputSchema.parse(input);
    this.#assertPins(command);
    const startedAt = factoryTimestampSchema.parse(this.dependencies.now());
    const slot = resolveFactoryDailyScheduleSlot(this.dependencies.schedulePolicy.value, startedAt);
    if (slot.status === "missed-deadline") {
      return this.#emptyReport("blocked", slot.scheduledFor, ["discovery-slot-deadline-missed"]);
    }

    let journal = await this.dependencies.repository.findBySlot({
      repositoryId: this.dependencies.repositoryId,
      schedulePolicyDigest: this.dependencies.schedulePolicy.digest,
      scheduledFor: slot.scheduledFor
    });
    journal ??= await this.#register(startedAt, slot);
    if (journal.state === "completed") return this.#existingReport(journal, "already-completed");
    if (journal.state === "failed") return this.#existingReport(journal, "failed");
    if (journal.state === "recorded") return this.#complete(journal);
    if (journal.state === "fetching") {
      if (journal.sequence >= 6) {
        const failed = await this.#append(journal, {
          kind: "failed",
          from: "fetching",
          to: "failed",
          reasonCode: "discovery-recovery-exhausted"
        });
        return this.#existingReport(failed, "failed");
      }
      journal = await this.#append(journal, {
        kind: "recovered",
        from: "fetching",
        to: "ready",
        reasonCode: "uncertain-read-recovered"
      });
    }
    if (journal.state !== "ready") {
      throw new Error("External PR discovery reached an unsupported journal state.");
    }
    journal = await this.#append(journal, {
      kind: "inventory-started",
      from: "ready",
      to: "fetching",
      reasonCode: "bounded-read-started"
    });

    try {
      const page = await this.dependencies.source.listOpen(
        journal.run.discoveryPolicy.maximumPullRequestsPerTick
      );
      const observedAt = factoryTimestampSchema.parse(this.dependencies.now());
      if (observedAt > journal.run.deadlineAt) {
        const failed = await this.#append(journal, {
          kind: "failed",
          from: "fetching",
          to: "failed",
          reasonCode: "discovery-deadline-exceeded"
        });
        return this.#existingReport(failed, "failed");
      }
      const ownership = await Promise.all(
        page.items.map(({ pullRequestNumber }) =>
          this.dependencies.ownedPullRequests.contains(
            this.dependencies.repositoryId,
            pullRequestNumber
          )
        )
      );
      const pullRequests = page.items
        .map((pullRequest, index) =>
          classifyExternalPullRequest({
            pullRequest,
            policy: journal.run.discoveryPolicy,
            factoryOwned: ownership[index] ?? false,
            observedAt
          })
        )
        .sort((left, right) => left.pullRequestNumber - right.pullRequestNumber);
      const counts = countDispositions(pullRequests);
      const snapshot = this.dependencies.documents.externalPullRequestDiscoverySnapshot({
        schemaVersion: "agentlab.external-pull-request-discovery-snapshot.v1",
        runId: journal.run.runId,
        runDigest: journal.runDigest,
        repositoryId: journal.run.repositoryId,
        observerId: journal.run.observerId,
        discoveryPolicyDigest: journal.run.discoveryPolicyDigest,
        scheduledFor: journal.run.scheduledFor,
        observedAt,
        hasMore: page.truncated,
        pullRequests,
        counts
      });
      const stored = await this.dependencies.artifacts.putText(snapshot.json);
      if (
        stored.digest !== snapshot.digest ||
        stored.sizeBytes !== new TextEncoder().encode(snapshot.json).byteLength
      ) {
        throw new Error("External PR discovery artifact changed during publication.");
      }
      const recordEvent = this.#event(journal, {
        kind: "snapshot-recorded",
        from: "fetching",
        to: "recorded",
        reasonCode: "immutable-inventory-recorded",
        occurredAt: observedAt,
        snapshotDigest: snapshot.digest,
        snapshotArtifact: {
          digest: stored.digest,
          sizeBytes: stored.sizeBytes,
          mediaType:
            "application/vnd.agentlab.external-pull-request-discovery-snapshot+json;version=1"
        }
      });
      const recorded = await this.dependencies.repository.recordSnapshot(recordEvent, snapshot);
      if (recorded === null)
        throw new Error("External PR discovery lost its snapshot journal claim.");
      return await this.#complete(recorded);
    } catch (error: unknown) {
      const current = await this.dependencies.repository.findBySlot({
        repositoryId: journal.run.repositoryId,
        schedulePolicyDigest: journal.run.schedulePolicyDigest,
        scheduledFor: journal.run.scheduledFor
      });
      if (current?.state === "fetching") {
        const failed = await this.#append(current, {
          kind: "failed",
          from: "fetching",
          to: "failed",
          reasonCode: "external-pull-request-read-failed"
        });
        return this.#existingReport(failed, "failed");
      }
      throw error;
    }
  }

  async #register(
    createdAt: string,
    slot: { readonly scheduledFor: string; readonly deadlineAt: string }
  ): Promise<FactoryExternalPullRequestDiscoveryJournalSnapshot> {
    const run = this.dependencies.documents.externalPullRequestDiscoveryRun({
      schemaVersion: "agentlab.external-pull-request-discovery-run.v1",
      runId: this.dependencies.createId(),
      repositoryId: this.dependencies.repositoryId,
      observerId: this.dependencies.observerId,
      discoveryPolicyDigest: this.dependencies.discoveryPolicy.digest,
      discoveryPolicy: this.dependencies.discoveryPolicy.value,
      schedulePolicyDigest: this.dependencies.schedulePolicy.digest,
      schedulePolicy: this.dependencies.schedulePolicy.value,
      scheduledFor: slot.scheduledFor,
      deadlineAt: slot.deadlineAt,
      createdAt,
      correlationId: this.dependencies.createId()
    });
    const event = this.dependencies.documents.externalPullRequestDiscoveryEvent({
      schemaVersion: "agentlab.external-pull-request-discovery-event.v1",
      eventId: this.dependencies.createId(),
      runId: run.value.runId,
      runDigest: run.digest,
      sequence: 1,
      previousEventDigest: null,
      actor: actor(run.value.observerId, run.value.runId),
      kind: "registered",
      from: null,
      to: "ready",
      occurredAt: createdAt,
      reasonCode: "daily-slot-registered",
      correlationId: run.value.correlationId
    });
    return this.dependencies.repository.register(run, event);
  }

  async #append(
    journal: FactoryExternalPullRequestDiscoveryJournalSnapshot,
    value: Extract<
      DiscoveryEventPayload,
      { readonly kind: "inventory-started" | "recovered" | "failed" }
    >
  ): Promise<FactoryExternalPullRequestDiscoveryJournalSnapshot> {
    const event = this.#event(journal, value);
    const result = await this.dependencies.repository.append(event);
    if (result === null) throw new Error("External PR discovery lost its journal append claim.");
    return result;
  }

  #event(
    journal: FactoryExternalPullRequestDiscoveryJournalSnapshot,
    value: DiscoveryEventPayload
  ) {
    return this.dependencies.documents.externalPullRequestDiscoveryEvent({
      schemaVersion: "agentlab.external-pull-request-discovery-event.v1",
      eventId: this.dependencies.createId(),
      runId: journal.run.runId,
      runDigest: journal.runDigest,
      sequence: journal.sequence + 1,
      previousEventDigest: journal.lastEventDigest,
      actor: actor(journal.run.observerId, journal.run.runId),
      ...value,
      occurredAt: value.occurredAt ?? factoryTimestampSchema.parse(this.dependencies.now()),
      correlationId: journal.run.correlationId
    });
  }

  async #complete(
    journal: FactoryExternalPullRequestDiscoveryJournalSnapshot
  ): Promise<FactoryExternalPullRequestDiscoveryTickReport> {
    const snapshot = journal.discoverySnapshot;
    if (journal.state !== "recorded" || snapshot === null) {
      throw new Error("External PR discovery completion requires a recorded snapshot.");
    }
    const event = this.#event(journal, {
      kind: "completed",
      from: "recorded",
      to: "completed",
      reasonCode: "bounded-read-completed",
      ...snapshot.counts,
      hasMore: snapshot.hasMore
    });
    const completed = await this.dependencies.repository.append(event);
    if (completed === null) throw new Error("External PR discovery lost its completion claim.");
    return this.#existingReport(completed, "completed");
  }

  #existingReport(
    journal: FactoryExternalPullRequestDiscoveryJournalSnapshot,
    status: "completed" | "already-completed" | "failed"
  ): FactoryExternalPullRequestDiscoveryTickReport {
    const snapshot = journal.discoverySnapshot;
    const counts = snapshot?.counts ?? emptyCounts();
    return {
      schemaVersion: "agentlab.external-pull-request-discovery-tick-result.v1",
      status,
      repositoryId: journal.run.repositoryId,
      observerId: journal.run.observerId,
      discoveryPolicyDigest: journal.run.discoveryPolicyDigest,
      schedulePolicyDigest: journal.run.schedulePolicyDigest,
      scheduledFor: journal.run.scheduledFor,
      runId: journal.run.runId,
      runDigest: journal.runDigest,
      snapshotDigest:
        journal.lastEvent.kind === "snapshot-recorded"
          ? journal.lastEvent.snapshotDigest
          : snapshot === null
            ? null
            : this.dependencies.documents.externalPullRequestDiscoverySnapshot(snapshot).digest,
      pullRequestsInspected: snapshot?.pullRequests.length ?? 0,
      ...counts,
      hasMore: snapshot?.hasMore ?? false,
      reasonCodes: status === "failed" ? [journal.lastEvent.reasonCode] : []
    };
  }

  #emptyReport(
    status: "blocked",
    scheduledFor: string,
    reasonCodes: readonly string[]
  ): FactoryExternalPullRequestDiscoveryTickReport {
    return {
      schemaVersion: "agentlab.external-pull-request-discovery-tick-result.v1",
      status,
      repositoryId: this.dependencies.repositoryId,
      observerId: this.dependencies.observerId,
      discoveryPolicyDigest: this.dependencies.discoveryPolicy.digest,
      schedulePolicyDigest: this.dependencies.schedulePolicy.digest,
      scheduledFor,
      runId: null,
      runDigest: null,
      snapshotDigest: null,
      pullRequestsInspected: 0,
      ...emptyCounts(),
      hasMore: false,
      reasonCodes
    };
  }

  #assertPins(command: z.infer<typeof tickInputSchema>): void {
    if (
      command.expectedDiscoveryPolicyDigest !== this.dependencies.discoveryPolicy.digest ||
      command.expectedSchedulePolicyDigest !== this.dependencies.schedulePolicy.digest
    ) {
      throw new Error("External PR discovery policy changed after operator review.");
    }
  }
}

function actor(observerId: string, runId: string): FactoryActor {
  return {
    kind: "control-plane",
    id: observerId,
    role: "maintenance-scout",
    sessionId: runId
  };
}

function countDispositions(items: readonly { readonly disposition: string }[]) {
  return {
    agentReviewCandidates: items.filter(
      ({ disposition }) => disposition === "agent-review-candidate"
    ).length,
    humanReviewRequired: items.filter(({ disposition }) => disposition === "human-review-required")
      .length,
    deferred: items.filter(({ disposition }) => disposition === "deferred").length,
    factoryOwned: items.filter(({ disposition }) => disposition === "factory-owned").length
  };
}

function emptyCounts() {
  return { agentReviewCandidates: 0, humanReviewRequired: 0, deferred: 0, factoryOwned: 0 };
}
