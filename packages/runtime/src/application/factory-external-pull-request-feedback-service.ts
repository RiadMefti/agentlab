import {
  factoryTimestampSchema,
  sha256DigestSchema,
  type FactoryActor,
  type FactoryExternalPullRequestFeedbackEvent,
  type FactoryExternalPullRequestFeedbackPolicy,
  type Sha256Digest
} from "@agentlab/contracts";
import { z } from "zod";

import type { FactoryArtifactStore } from "../domain/factory-artifact-store.js";
import type { FactoryExternalPullRequestFeedbackPublisher } from "../domain/factory-external-pull-request-feedback-publisher.js";
import type {
  FactoryExternalPullRequestFeedbackCandidate,
  FactoryExternalPullRequestFeedbackJournalSnapshot,
  FactoryExternalPullRequestFeedbackRepository
} from "../domain/factory-external-pull-request-feedback-repository.js";
import type { FactoryControlRepository } from "../domain/factory-task-repository.js";
import type {
  CanonicalFactoryDocument,
  FactoryDocumentCodec
} from "../domain/factory-documents.js";
import {
  factoryTimestampAddSeconds,
  factoryTimestampMilliseconds
} from "../domain/factory-timestamp.js";
import { renderExternalPullRequestFeedback } from "./factory-external-pull-request-feedback-body.js";

const tickInputSchema = z
  .object({
    expectedFeedbackPolicyDigest: sha256DigestSchema,
    expectedReviewPolicyDigest: sha256DigestSchema
  })
  .strict();

export interface FactoryExternalPullRequestFeedbackPreflight {
  readonly schemaVersion: "agentlab.external-pull-request-feedback-preflight.v1";
  readonly status: "ready" | "blocked";
  readonly repositoryId: string;
  readonly repositoryNumericId: number;
  readonly publisherId: string;
  readonly publisherUserId: number;
  readonly feedbackPolicyDigest: Sha256Digest;
  readonly reviewPolicyDigest: Sha256Digest;
  readonly authorityEnabled: boolean;
  readonly reasonCodes: readonly string[];
}

export interface FactoryExternalPullRequestFeedbackTickReport {
  readonly schemaVersion: "agentlab.external-pull-request-feedback-tick-result.v1";
  readonly status: "idle" | "completed" | "partial" | "attention-required" | "blocked";
  readonly repositoryId: string;
  readonly publisherId: string;
  readonly feedbackPolicyDigest: Sha256Digest;
  readonly inspected: number;
  readonly published: number;
  readonly reconciled: number;
  readonly skipped: number;
  readonly attentionRequired: number;
  readonly failed: number;
  readonly hasMore: boolean;
  readonly reasonCodes: readonly string[];
  readonly runs: readonly FactoryExternalPullRequestFeedbackRunReport[];
}

export interface FactoryExternalPullRequestFeedbackRunReport {
  readonly publicationRunId: string;
  readonly runDigest: Sha256Digest;
  readonly pullRequestNumber: number;
  readonly status:
    "published" | "reconciled" | "skipped" | "attention-required" | "failed" | "blocked";
  readonly bundleDigest: Sha256Digest;
  readonly recordDigest: Sha256Digest | null;
  readonly remoteReviewId: string | null;
  readonly reasonCode: string | null;
}

export interface FactoryExternalPullRequestFeedbackServiceDependencies {
  readonly feedbackPolicy: CanonicalFactoryDocument<FactoryExternalPullRequestFeedbackPolicy>;
  readonly repository: FactoryExternalPullRequestFeedbackRepository;
  readonly artifacts: FactoryArtifactStore;
  readonly documents: FactoryDocumentCodec;
  readonly publisher: FactoryExternalPullRequestFeedbackPublisher;
  readonly controls: Pick<FactoryControlRepository, "state">;
  readonly now: () => string;
  readonly createId: () => string;
}

type EventPayload<
  Event extends FactoryExternalPullRequestFeedbackEvent = FactoryExternalPullRequestFeedbackEvent
> = Event extends FactoryExternalPullRequestFeedbackEvent
  ? Omit<
      Event,
      | "schemaVersion"
      | "eventId"
      | "publicationRunId"
      | "runDigest"
      | "sequence"
      | "previousEventDigest"
      | "actor"
      | "occurredAt"
      | "correlationId"
    > & { readonly occurredAt?: string }
  : never;

/** Publishes only deterministic COMMENT feedback from completed, immutable review evidence. */
export class FactoryExternalPullRequestFeedbackService {
  public constructor(
    private readonly dependencies: FactoryExternalPullRequestFeedbackServiceDependencies
  ) {
    const identity = dependencies.publisher.identity();
    const policy = dependencies.feedbackPolicy.value;
    if (
      identity.repositoryId !== policy.repositoryId ||
      identity.publisherId !== policy.publisherId ||
      identity.publisherUserId !== policy.publisherUserId
    ) {
      throw new Error("External PR feedback composition identities do not match.");
    }
  }

  public async preflight(): Promise<FactoryExternalPullRequestFeedbackPreflight> {
    const [repository, controls] = await Promise.all([
      this.dependencies.publisher.inspectRepository(),
      this.dependencies.controls.state()
    ]);
    const identity = this.dependencies.publisher.identity();
    if (
      repository.repositoryId !== identity.repositoryId ||
      repository.repositoryNumericId !== identity.repositoryNumericId
    ) {
      throw new Error("External PR feedback preflight returned another repository.");
    }
    const reasonCodes = controls.prBroker ? [] : ["pr-broker-disabled"];
    return {
      schemaVersion: "agentlab.external-pull-request-feedback-preflight.v1",
      status: reasonCodes.length === 0 ? "ready" : "blocked",
      repositoryId: identity.repositoryId,
      repositoryNumericId: identity.repositoryNumericId,
      publisherId: identity.publisherId,
      publisherUserId: identity.publisherUserId,
      feedbackPolicyDigest: this.dependencies.feedbackPolicy.digest,
      reviewPolicyDigest: this.dependencies.feedbackPolicy.value.reviewPolicyDigest,
      authorityEnabled: controls.prBroker,
      reasonCodes
    };
  }

  public async tick(input: unknown): Promise<FactoryExternalPullRequestFeedbackTickReport> {
    const command = tickInputSchema.parse(input);
    this.#assertPins(command);
    const policy = this.dependencies.feedbackPolicy.value;
    const active = await this.dependencies.repository.listActive({
      repositoryId: policy.repositoryId,
      feedbackPolicyDigest: this.dependencies.feedbackPolicy.digest,
      limit: policy.maximumPublicationsPerTick
    });
    const reports: FactoryExternalPullRequestFeedbackRunReport[] = [];
    for (const journal of active) reports.push(await this.#resume(journal));

    const remaining = policy.maximumPublicationsPerTick - reports.length;
    const controls = await this.dependencies.controls.state();
    let hasMore = active.length >= policy.maximumPublicationsPerTick;
    if (remaining > 0 && controls.prBroker) {
      const candidates = await this.dependencies.repository.listCompletedReviews({
        repositoryId: policy.repositoryId,
        reviewPolicyDigest: policy.reviewPolicyDigest,
        limit: remaining + 1
      });
      hasMore ||= candidates.length > remaining;
      for (const candidate of candidates.slice(0, remaining)) {
        const journal = await this.#register(candidate);
        reports.push(await this.#execute(journal));
      }
    }
    if (reports.length === 0) {
      return this.#report(
        [],
        controls.prBroker ? "idle" : "blocked",
        hasMore,
        controls.prBroker ? [] : ["pr-broker-disabled"]
      );
    }
    const attention = reports.some(({ status }) => status === "attention-required");
    const blocked = reports.some(({ status }) => status === "blocked");
    const unsuccessful = reports.some(({ status }) =>
      ["attention-required", "failed", "blocked"].includes(status)
    );
    const status = attention
      ? "attention-required"
      : blocked
        ? "blocked"
        : unsuccessful
          ? "partial"
          : "completed";
    return this.#report(
      reports,
      status,
      hasMore,
      uniqueSorted(reports.flatMap(({ reasonCode }) => (reasonCode === null ? [] : [reasonCode])))
    );
  }

  async #register(
    candidate: FactoryExternalPullRequestFeedbackCandidate
  ): Promise<FactoryExternalPullRequestFeedbackJournalSnapshot> {
    const policy = this.dependencies.feedbackPolicy.value;
    if (
      candidate.reviewRun.repositoryId !== policy.repositoryId ||
      candidate.reviewRun.reviewPolicyDigest !== policy.reviewPolicyDigest ||
      candidate.bundle.reviewPolicyDigest !== policy.reviewPolicyDigest
    ) {
      throw new Error("External PR feedback candidate belongs to another reviewed authority.");
    }
    const body = renderExternalPullRequestFeedback({
      bundle: candidate.bundle,
      bundleDigest: candidate.bundleDigest,
      maximumBytes: policy.maximumBodyBytes
    });
    const stored = await this.dependencies.artifacts.putText(body);
    if (stored.sizeBytes !== new TextEncoder().encode(body).byteLength) {
      throw new Error("External PR feedback body changed during immutable storage.");
    }
    const createdAt = factoryTimestampSchema.parse(this.dependencies.now());
    const run = this.dependencies.documents.externalPullRequestFeedbackRun({
      schemaVersion: "agentlab.external-pull-request-feedback-run.v1",
      publicationRunId: this.dependencies.createId(),
      repositoryId: candidate.reviewRun.repositoryId,
      pullRequestNumber: candidate.reviewRun.pullRequestNumber,
      reviewRunId: candidate.reviewRun.runId,
      reviewRunDigest: candidate.reviewRunDigest,
      reviewRun: candidate.reviewRun,
      bundleDigest: candidate.bundleDigest,
      bundle: candidate.bundle,
      reviewPolicyDigest: policy.reviewPolicyDigest,
      feedbackPolicyDigest: this.dependencies.feedbackPolicy.digest,
      feedbackPolicy: policy,
      expectedBaseRevision: candidate.reviewRun.candidate.base.revision,
      expectedHeadRevision: candidate.reviewRun.candidate.head.revision,
      bodyArtifact: {
        digest: stored.digest,
        sizeBytes: stored.sizeBytes,
        mediaType: "text/markdown; charset=utf-8"
      },
      marker: `<!-- agentlab-external-review:${candidate.bundleDigest} -->`,
      createdAt,
      deadlineAt: factoryTimestampAddSeconds(createdAt, policy.operationDeadlineSeconds),
      correlationId: candidate.reviewRun.correlationId
    });
    const event = this.dependencies.documents.externalPullRequestFeedbackEvent({
      ...eventBase(
        run.value.publicationRunId,
        run.digest,
        run.value.correlationId,
        policy.publisherId
      ),
      eventId: this.dependencies.createId(),
      sequence: 1,
      previousEventDigest: null,
      kind: "registered",
      from: null,
      to: "ready",
      occurredAt: createdAt,
      reasonCode: "completed-review-admitted"
    });
    return this.dependencies.repository.register(run, event);
  }

  async #resume(
    journal: FactoryExternalPullRequestFeedbackJournalSnapshot
  ): Promise<FactoryExternalPullRequestFeedbackRunReport> {
    if (journal.state === "recorded") return this.#complete(journal);
    if (journal.state === "publication-active") return this.#reconcile(journal);
    return this.#execute(journal);
  }

  async #execute(
    initial: FactoryExternalPullRequestFeedbackJournalSnapshot
  ): Promise<FactoryExternalPullRequestFeedbackRunReport> {
    let journal = initial;
    try {
      if (journal.state !== "ready" && journal.state !== "remote-verified") {
        throw new Error("External PR feedback reached an unsupported execution state.");
      }
      if (journal.state === "ready") {
        const reason = this.#localAdmissionReason(journal);
        if (reason !== null) {
          return await this.#terminal(
            journal,
            reason === "review-evidence-expired" ? "skipped" : "failed",
            reason
          );
        }
        if (!(await this.dependencies.controls.state()).prBroker) {
          return reportFor(journal, "blocked", "pr-broker-disabled");
        }
        const { snapshot } = await this.#inspect(journal);
        if (snapshot.existingPublication !== null) {
          journal = await this.#append(journal, {
            kind: "remote-verified",
            from: "ready",
            to: "remote-verified",
            reasonCode: "existing-exact-comment-verified"
          });
          return await this.#recordAndComplete(journal, snapshot.existingPublication, "reconciled");
        }
        const remoteReason = remoteAdmissionReason(journal, snapshot);
        if (remoteReason !== null) return await this.#terminal(journal, "skipped", remoteReason);
        journal = await this.#append(journal, {
          kind: "remote-verified",
          from: "ready",
          to: "remote-verified",
          reasonCode: "exact-open-head-verified"
        });
      }

      if (!(await this.dependencies.controls.state()).prBroker) {
        return reportFor(journal, "blocked", "pr-broker-disabled");
      }
      const { body, snapshot } = await this.#inspect(journal);
      if (snapshot.existingPublication !== null) {
        return await this.#recordAndComplete(journal, snapshot.existingPublication, "reconciled");
      }
      const remoteReason = remoteAdmissionReason(journal, snapshot);
      if (remoteReason !== null) return await this.#terminal(journal, "skipped", remoteReason);
      if (factoryTimestampSchema.parse(this.dependencies.now()) > journal.run.deadlineAt) {
        return await this.#terminal(journal, "failed", "feedback-deadline-exceeded");
      }
      journal = await this.#append(journal, {
        kind: "publication-started",
        from: "remote-verified",
        to: "publication-active",
        reasonCode: "comment-publication-intent-recorded"
      });
      if (!(await this.dependencies.controls.state()).prBroker) {
        const cancelled = await this.#append(journal, {
          kind: "publication-cancelled",
          from: "publication-active",
          to: "skipped",
          reasonCode: "authority-revoked-before-publication"
        });
        return reportFor(cancelled, "skipped", "authority-revoked-before-publication");
      }
      const publication = await this.dependencies.publisher.publish({
        pullRequestNumber: journal.run.pullRequestNumber,
        headRevision: journal.run.expectedHeadRevision,
        marker: journal.run.marker,
        body,
        bodyDigest: journal.run.bodyArtifact.digest
      });
      return await this.#recordAndComplete(journal, publication, "posted");
    } catch {
      const current = await this.dependencies.repository.findByBundle(journal.run.bundleDigest);
      if (current?.state === "publication-active") {
        return reportFor(current, "blocked", "feedback-publication-outcome-uncertain");
      }
      if (current?.state === "ready" || current?.state === "remote-verified") {
        return reportFor(current, "blocked", "feedback-prepublication-failed");
      }
      throw new Error("External PR feedback failed after losing its durable journal state.");
    }
  }

  async #reconcile(
    journal: FactoryExternalPullRequestFeedbackJournalSnapshot
  ): Promise<FactoryExternalPullRequestFeedbackRunReport> {
    try {
      const { snapshot } = await this.#inspect(journal);
      if (snapshot.existingPublication !== null) {
        return await this.#recordAndComplete(journal, snapshot.existingPublication, "reconciled");
      }
      const attempts = journal.history.filter(({ kind }) => kind === "recovery-pending").length;
      if (attempts >= journal.run.feedbackPolicy.maximumRecoveryAttempts) {
        const attention = await this.#append(journal, {
          kind: "attention-required",
          from: "publication-active",
          to: "attention-required",
          reasonCode: "feedback-publication-unconfirmed"
        });
        return reportFor(attention, "attention-required", "feedback-publication-unconfirmed");
      }
      const pending = await this.#append(journal, {
        kind: "recovery-pending",
        from: "publication-active",
        to: "publication-active",
        reasonCode: "feedback-publication-reconciliation-pending"
      });
      return reportFor(pending, "blocked", "feedback-publication-reconciliation-pending");
    } catch {
      return reportFor(journal, "blocked", "feedback-publication-reconciliation-failed");
    }
  }

  async #inspect(journal: FactoryExternalPullRequestFeedbackJournalSnapshot) {
    const body = await this.dependencies.artifacts.readText(
      journal.run.bodyArtifact.digest,
      journal.run.feedbackPolicy.maximumBodyBytes
    );
    if (
      new TextEncoder().encode(body).byteLength !== journal.run.bodyArtifact.sizeBytes ||
      !body.startsWith(`${journal.run.marker}\n`)
    ) {
      throw new Error("External PR feedback body artifact failed immutable verification.");
    }
    const snapshot = await this.dependencies.publisher.inspect({
      pullRequestNumber: journal.run.pullRequestNumber,
      headRevision: journal.run.expectedHeadRevision,
      marker: journal.run.marker,
      body,
      bodyDigest: journal.run.bodyArtifact.digest
    });
    return { body, snapshot };
  }

  #localAdmissionReason(journal: FactoryExternalPullRequestFeedbackJournalSnapshot): string | null {
    const now = factoryTimestampMilliseconds(this.dependencies.now());
    const reviewed = factoryTimestampMilliseconds(journal.run.bundle.createdAt);
    if (now < reviewed) return "feedback-clock-regression";
    if (now > factoryTimestampMilliseconds(journal.run.deadlineAt))
      return "feedback-deadline-exceeded";
    if (now - reviewed > journal.run.feedbackPolicy.maximumReviewAgeHours * 60 * 60 * 1_000) {
      return "review-evidence-expired";
    }
    return null;
  }

  async #recordAndComplete(
    journal: FactoryExternalPullRequestFeedbackJournalSnapshot,
    publication: {
      readonly reviewId: string;
      readonly state: "commented";
      readonly url: string | null;
      readonly headRevision: string;
      readonly bodyDigest: Sha256Digest;
      readonly submittedAt: string;
    },
    source: "posted" | "reconciled"
  ): Promise<FactoryExternalPullRequestFeedbackRunReport> {
    const observedAt = factoryTimestampSchema.parse(this.dependencies.now());
    const record = this.dependencies.documents.externalPullRequestFeedbackRecord({
      schemaVersion: "agentlab.external-pull-request-feedback-record.v1",
      publicationRunId: journal.run.publicationRunId,
      runDigest: journal.runDigest,
      bundleDigest: journal.run.bundleDigest,
      repositoryId: journal.run.repositoryId,
      pullRequestNumber: journal.run.pullRequestNumber,
      headRevision: publication.headRevision,
      publisherId: journal.run.feedbackPolicy.publisherId,
      publisherUserId: journal.run.feedbackPolicy.publisherUserId,
      remoteReviewId: publication.reviewId,
      remoteState: publication.state,
      remoteUrl: publication.url,
      bodyDigest: publication.bodyDigest,
      remoteSubmittedAt: publication.submittedAt,
      observedAt,
      source
    });
    const stored = await this.dependencies.artifacts.putText(record.json);
    if (
      stored.digest !== record.digest ||
      stored.sizeBytes !== new TextEncoder().encode(record.json).byteLength
    ) {
      throw new Error("External PR feedback record changed during immutable storage.");
    }
    const event = this.#event(journal, {
      kind: "publication-recorded",
      from: journal.state as "remote-verified" | "publication-active",
      to: "recorded",
      recordDigest: record.digest,
      recordArtifact: {
        digest: stored.digest,
        sizeBytes: stored.sizeBytes,
        mediaType: "application/vnd.agentlab.external-pull-request-feedback-record+json;version=1"
      },
      reasonCode:
        source === "posted" ? "comment-publication-recorded" : "remote-comment-reconciled",
      occurredAt: observedAt
    });
    const recorded = await this.dependencies.repository.record(event, record);
    if (recorded === null) throw new Error("External PR feedback lost its record claim.");
    return this.#complete(recorded);
  }

  async #complete(
    journal: FactoryExternalPullRequestFeedbackJournalSnapshot
  ): Promise<FactoryExternalPullRequestFeedbackRunReport> {
    if (journal.state !== "recorded" || journal.record === null) {
      throw new Error("External PR feedback completion requires a recorded publication.");
    }
    const completed = await this.#append(journal, {
      kind: "completed",
      from: "recorded",
      to: "completed",
      remoteReviewId: journal.record.remoteReviewId,
      reasonCode: "advisory-comment-published"
    });
    return reportFor(
      completed,
      journal.record.source === "posted" ? "published" : "reconciled",
      null
    );
  }

  async #terminal(
    journal: FactoryExternalPullRequestFeedbackJournalSnapshot,
    kind: "skipped" | "failed",
    reasonCode: string
  ): Promise<FactoryExternalPullRequestFeedbackRunReport> {
    const from = journal.state as "ready" | "remote-verified";
    const result =
      kind === "skipped"
        ? await this.#append(journal, {
            kind: "skipped",
            from,
            to: "skipped",
            reasonCode
          })
        : await this.#append(journal, {
            kind: "failed",
            from,
            to: "failed",
            reasonCode
          });
    return reportFor(result, kind, reasonCode);
  }

  async #append(
    journal: FactoryExternalPullRequestFeedbackJournalSnapshot,
    value: EventPayload
  ): Promise<FactoryExternalPullRequestFeedbackJournalSnapshot> {
    const result = await this.dependencies.repository.append(this.#event(journal, value));
    if (result === null) throw new Error("External PR feedback lost its journal append claim.");
    return result;
  }

  #event(journal: FactoryExternalPullRequestFeedbackJournalSnapshot, value: EventPayload) {
    return this.dependencies.documents.externalPullRequestFeedbackEvent({
      ...eventBase(
        journal.run.publicationRunId,
        journal.runDigest,
        journal.run.correlationId,
        journal.run.feedbackPolicy.publisherId
      ),
      eventId: this.dependencies.createId(),
      sequence: journal.sequence + 1,
      previousEventDigest: journal.lastEventDigest,
      ...value,
      occurredAt: value.occurredAt ?? factoryTimestampSchema.parse(this.dependencies.now())
    });
  }

  #assertPins(command: z.infer<typeof tickInputSchema>): void {
    if (
      command.expectedFeedbackPolicyDigest !== this.dependencies.feedbackPolicy.digest ||
      command.expectedReviewPolicyDigest !==
        this.dependencies.feedbackPolicy.value.reviewPolicyDigest
    ) {
      throw new Error("External PR feedback policy changed after operator review.");
    }
  }

  #report(
    runs: readonly FactoryExternalPullRequestFeedbackRunReport[],
    status: FactoryExternalPullRequestFeedbackTickReport["status"],
    hasMore: boolean,
    reasonCodes: readonly string[]
  ): FactoryExternalPullRequestFeedbackTickReport {
    return {
      schemaVersion: "agentlab.external-pull-request-feedback-tick-result.v1",
      status,
      repositoryId: this.dependencies.feedbackPolicy.value.repositoryId,
      publisherId: this.dependencies.feedbackPolicy.value.publisherId,
      feedbackPolicyDigest: this.dependencies.feedbackPolicy.digest,
      inspected: runs.length,
      published: runs.filter(({ status: value }) => value === "published").length,
      reconciled: runs.filter(({ status: value }) => value === "reconciled").length,
      skipped: runs.filter(({ status: value }) => value === "skipped").length,
      attentionRequired: runs.filter(({ status: value }) => value === "attention-required").length,
      failed: runs.filter(({ status: value }) => value === "failed").length,
      hasMore,
      reasonCodes: uniqueSorted(reasonCodes),
      runs
    };
  }
}

function eventBase(
  publicationRunId: string,
  runDigest: Sha256Digest,
  correlationId: string,
  publisherId: string
) {
  return {
    schemaVersion: "agentlab.external-pull-request-feedback-event.v1" as const,
    publicationRunId,
    runDigest,
    actor: actor(publisherId, publicationRunId),
    correlationId
  };
}

function actor(publisherId: string, publicationRunId: string): FactoryActor {
  return {
    kind: "broker",
    role: "pr-broker",
    id: publisherId,
    sessionId: publicationRunId
  };
}

function remoteAdmissionReason(
  journal: FactoryExternalPullRequestFeedbackJournalSnapshot,
  snapshot: {
    readonly repositoryId: string;
    readonly pullRequestNumber: number;
    readonly state: "open" | "closed";
    readonly merged: boolean;
    readonly baseRevision: string;
    readonly headRevision: string;
  }
): string | null {
  if (
    snapshot.repositoryId !== journal.run.repositoryId ||
    snapshot.pullRequestNumber !== journal.run.pullRequestNumber
  ) {
    throw new Error("External PR feedback publisher returned another pull request identity.");
  }
  if (snapshot.merged) return "pull-request-already-merged";
  if (snapshot.state !== "open") return "pull-request-not-open";
  if (snapshot.baseRevision !== journal.run.expectedBaseRevision)
    return "pull-request-base-changed";
  if (snapshot.headRevision !== journal.run.expectedHeadRevision)
    return "pull-request-head-changed";
  return null;
}

function reportFor(
  journal: FactoryExternalPullRequestFeedbackJournalSnapshot,
  status: FactoryExternalPullRequestFeedbackRunReport["status"],
  reasonCode: string | null
): FactoryExternalPullRequestFeedbackRunReport {
  const recordDigest = journal.record === null ? null : publicationRecordDigest(journal.history);
  return {
    publicationRunId: journal.run.publicationRunId,
    runDigest: journal.runDigest,
    pullRequestNumber: journal.run.pullRequestNumber,
    status,
    bundleDigest: journal.run.bundleDigest,
    recordDigest,
    remoteReviewId: journal.record?.remoteReviewId ?? null,
    reasonCode
  };
}

function publicationRecordDigest(
  history: FactoryExternalPullRequestFeedbackJournalSnapshot["history"]
): Sha256Digest | null {
  for (const event of history) {
    if (event.kind === "publication-recorded") return event.recordDigest;
  }
  return null;
}

function uniqueSorted(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort();
}
