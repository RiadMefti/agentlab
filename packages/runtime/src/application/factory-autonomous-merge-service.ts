import {
  factoryTimestampSchema,
  sha256DigestSchema,
  type EvidenceItem,
  type FactoryAutonomousMergeAuthorization,
  type FactoryAutonomousMergeEvent,
  type FactoryAutonomousMergePolicy,
  type FactoryAutonomousMergeRecord,
  type Sha256Digest
} from "@agentlab/contracts";
import { z } from "zod";

import type { FactoryArtifactStore } from "../domain/factory-artifact-store.js";
import {
  FactoryAutonomousMergeQuarantineError,
  FactoryAutonomousMergeStaleError,
  type FactoryAutonomousMerger,
  type FactoryAutonomousMergeRemoteSnapshot
} from "../domain/factory-autonomous-merge-broker.js";
import {
  FactoryAutonomousMergeCapacityError,
  type FactoryAutonomousMergeCandidate,
  type FactoryAutonomousMergeJournalSnapshot,
  type FactoryAutonomousMergeRepository
} from "../domain/factory-autonomous-merge-repository.js";
import type {
  CanonicalFactoryDocument,
  FactoryDocumentCodec
} from "../domain/factory-documents.js";
import type {
  FactoryControlRepository,
  FactoryEvidenceRepository,
  FactoryTaskRepository,
  FactoryTaskSnapshot,
  StoredEvidenceBundle
} from "../domain/factory-task-repository.js";
import { factoryTimestampAddSeconds } from "../domain/factory-timestamp.js";
import type { FactoryControlPlane } from "./factory-control-plane.js";
import type { FactoryEvidenceIngress } from "./factory-evidence-ingress.js";
import {
  FactoryEvidencePublisher,
  type FactoryEvidencePublisherCredentials
} from "./factory-evidence-publisher.js";

const tickInputSchema = z
  .object({
    expectedMergePolicyDigest: sha256DigestSchema,
    expectedFactoryPolicyBundleDigest: sha256DigestSchema,
    expectedSchedulePolicyDigest: sha256DigestSchema,
    expectedDailyQuotaPolicyDigest: sha256DigestSchema,
    expectedRoleIdentityPolicyDigest: sha256DigestSchema
  })
  .strict();

const authorizationMediaType = "application/vnd.agentlab.autonomous-merge-authorization.v1+json";
const recordMediaType = "application/vnd.agentlab.autonomous-merge-record.v1+json";

export interface FactoryAutonomousMergePreflight {
  readonly schemaVersion: "agentlab.autonomous-merge-preflight.v1";
  readonly status: "ready" | "blocked";
  readonly repositoryId: string;
  readonly mergerId: string;
  readonly mergePolicyDigest: Sha256Digest;
  readonly factoryPolicyBundleDigest: Sha256Digest;
  readonly schedulerEnabled: boolean;
  readonly prBrokerEnabled: boolean;
  readonly mergeBrokerEnabled: boolean;
  readonly deliveryMode: "merge-queue";
  readonly directMerge: false;
  readonly release: false;
  readonly reasonCodes: readonly string[];
}

export interface FactoryAutonomousMergeRunReport {
  readonly mergeRunId: string;
  readonly authorizationDigest: Sha256Digest;
  readonly taskId: string;
  readonly pullRequestNumber: number;
  readonly status: "completed" | "pending" | "stale" | "blocked" | "quarantined";
  readonly reasonCode: string | null;
  readonly mergedRevision: string | null;
}

export interface FactoryAutonomousMergeTickReport {
  readonly schemaVersion: "agentlab.autonomous-merge-tick-result.v1";
  readonly status: "completed" | "idle" | "pending" | "partial" | "blocked";
  readonly repositoryId: string;
  readonly mergePolicyDigest: Sha256Digest;
  readonly inspected: number;
  readonly completed: number;
  readonly pending: number;
  readonly stale: number;
  readonly blocked: number;
  readonly quarantined: number;
  readonly reasonCodes: readonly string[];
  readonly runs: readonly FactoryAutonomousMergeRunReport[];
}

export interface FactoryAutonomousMergeServiceDependencies {
  readonly mergePolicy: CanonicalFactoryDocument<FactoryAutonomousMergePolicy>;
  readonly factoryPolicyBundleDigest: Sha256Digest;
  readonly repository: FactoryAutonomousMergeRepository;
  readonly tasks: Pick<FactoryTaskRepository, "findById" | "listByState">;
  readonly evidence: Pick<FactoryEvidenceRepository, "listEvidence">;
  readonly controls: Pick<FactoryControlRepository, "state">;
  readonly controlPlane: Pick<FactoryControlPlane, "transition">;
  readonly artifacts: FactoryArtifactStore;
  readonly documents: FactoryDocumentCodec;
  readonly evidenceIngress: FactoryEvidenceIngress;
  readonly evidenceCredentials: Pick<FactoryEvidencePublisherCredentials, "merger">;
  readonly remote: FactoryAutonomousMerger;
  readonly now: () => string;
  readonly createId: () => string;
}

type EventPayload<Event extends FactoryAutonomousMergeEvent = FactoryAutonomousMergeEvent> =
  Event extends FactoryAutonomousMergeEvent
    ? Omit<
        Event,
        | "schemaVersion"
        | "eventId"
        | "mergeRunId"
        | "runDigest"
        | "sequence"
        | "previousEventDigest"
        | "actor"
        | "occurredAt"
        | "correlationId"
      > & { readonly occurredAt?: string }
    : never;

/** Separately credentialed, recovery-first merge-queue broker; it loads no provider or model. */
export class FactoryAutonomousMergeService {
  readonly #publisher: FactoryEvidencePublisher;

  public constructor(private readonly dependencies: FactoryAutonomousMergeServiceDependencies) {
    const identity = dependencies.remote.identity();
    if (
      identity.repositoryId !== dependencies.mergePolicy.value.repositoryId ||
      identity.mergerId !== dependencies.mergePolicy.value.mergerId
    ) {
      throw new Error("Autonomous merger identity does not match its reviewed policy.");
    }
    this.#publisher = new FactoryEvidencePublisher({
      evidenceIngress: dependencies.evidenceIngress,
      credentials: { merger: dependencies.evidenceCredentials.merger },
      artifacts: dependencies.artifacts,
      documents: dependencies.documents,
      now: dependencies.now,
      createId: dependencies.createId
    });
  }

  public async preflight(): Promise<FactoryAutonomousMergePreflight> {
    const controls = await this.dependencies.controls.state();
    const reasonCodes = controlDenials(controls);
    const identity = this.dependencies.remote.identity();
    if (identity.repositoryId !== this.dependencies.mergePolicy.value.repositoryId) {
      reasonCodes.push("merger-repository-mismatch");
    }
    if (identity.mergerId !== this.dependencies.mergePolicy.value.mergerId) {
      reasonCodes.push("merger-identity-mismatch");
    }
    return {
      schemaVersion: "agentlab.autonomous-merge-preflight.v1",
      status: reasonCodes.length === 0 ? "ready" : "blocked",
      repositoryId: this.dependencies.mergePolicy.value.repositoryId,
      mergerId: this.dependencies.mergePolicy.value.mergerId,
      mergePolicyDigest: this.dependencies.mergePolicy.digest,
      factoryPolicyBundleDigest: this.dependencies.factoryPolicyBundleDigest,
      schedulerEnabled: controls.scheduler,
      prBrokerEnabled: controls.prBroker,
      mergeBrokerEnabled: controls.mergeBroker ?? false,
      deliveryMode: "merge-queue",
      directMerge: false,
      release: false,
      reasonCodes: reasonCodes.toSorted()
    };
  }

  public async tick(input: unknown): Promise<FactoryAutonomousMergeTickReport> {
    const command = tickInputSchema.parse(input);
    this.#assertPins(command);
    const policy = this.dependencies.mergePolicy;
    const reports: FactoryAutonomousMergeRunReport[] = [];
    let admissionDenials: readonly string[] = [];
    const active = await this.dependencies.repository.listActive({
      repositoryId: policy.value.repositoryId,
      mergePolicyDigest: policy.digest,
      limit: policy.value.maximumCandidatesPerTick
    });
    for (const journal of active) reports.push(await this.#execute(journal));
    const remaining = policy.value.maximumCandidatesPerTick - reports.length;
    if (remaining > 0 && !reports.some(({ status }) => status === "quarantined")) {
      const controls = await this.dependencies.controls.state();
      admissionDenials = controlDenials(controls);
      if (admissionDenials.length === 0) {
        const now = factoryTimestampSchema.parse(this.dependencies.now());
        const occupied = await this.dependencies.repository.countCapacityForUtcDay({
          repositoryId: policy.value.repositoryId,
          at: now
        });
        const quotaRemaining = Math.max(0, policy.value.maximumMergesPerUtcDay - occupied);
        if (quotaRemaining === 0) admissionDenials = ["merge-daily-capacity-exhausted"];
        const candidates = await this.#candidates(Math.min(remaining, quotaRemaining));
        for (const candidate of candidates) {
          if (controlDenials(await this.dependencies.controls.state()).length > 0) break;
          let journal: FactoryAutonomousMergeJournalSnapshot;
          try {
            journal = await this.#register(candidate);
          } catch (error: unknown) {
            if (!(error instanceof FactoryAutonomousMergeCapacityError)) throw error;
            admissionDenials = ["merge-daily-capacity-exhausted"];
            break;
          }
          reports.push(await this.#execute(journal));
        }
      }
    }
    return this.#report(reports, admissionDenials);
  }

  async #candidates(limit: number): Promise<readonly FactoryAutonomousMergeCandidate[]> {
    if (limit === 0) return [];
    const tasks = await this.dependencies.tasks.listByState("merge-ready", limit);
    const candidates: FactoryAutonomousMergeCandidate[] = [];
    for (const task of tasks) {
      if (task.contract.repository.id !== this.dependencies.mergePolicy.value.repositoryId)
        continue;
      const bundles = await this.dependencies.evidence.listEvidence(task.contract.taskId);
      const found = await this.#authorizationFromEvidence(task, bundles);
      if (found !== null) candidates.push(found);
    }
    return candidates;
  }

  async #register(
    candidate: FactoryAutonomousMergeCandidate
  ): Promise<FactoryAutonomousMergeJournalSnapshot> {
    const policy = this.dependencies.mergePolicy;
    const createdAt = factoryTimestampSchema.parse(this.dependencies.now());
    if (createdAt >= candidate.authorization.value.expiresAt) {
      throw new FactoryAutonomousMergeStaleError(
        "Autonomous merge authorization expired before journal registration."
      );
    }
    const run = this.dependencies.documents.autonomousMergeRun({
      schemaVersion: "agentlab.autonomous-merge-run.v1",
      mergeRunId: this.dependencies.createId(),
      authorizationId: candidate.authorization.value.authorizationId,
      authorizationDigest: candidate.authorization.digest,
      taskId: candidate.authorization.value.taskId,
      contractDigest: candidate.authorization.value.contractDigest,
      repositoryId: candidate.authorization.value.repositoryId,
      pullRequestNumber: candidate.authorization.value.pullRequestNumber,
      pullRequestUrl: candidate.authorization.value.pullRequestUrl,
      expectedBaseRevision: candidate.authorization.value.expectedBaseRevision,
      expectedHeadRevision: candidate.authorization.value.expectedHeadRevision,
      mergePolicyDigest: policy.digest,
      mergePolicy: policy.value,
      createdAt,
      deadlineAt: earliest(
        candidate.authorization.value.expiresAt,
        factoryTimestampAddSeconds(createdAt, policy.value.operationDeadlineSeconds)
      ),
      correlationId: candidate.authorization.value.correlationId
    });
    const event = this.dependencies.documents.autonomousMergeEvent({
      schemaVersion: "agentlab.autonomous-merge-event.v1",
      eventId: this.dependencies.createId(),
      mergeRunId: run.value.mergeRunId,
      runDigest: run.digest,
      sequence: 1,
      previousEventDigest: null,
      actor: this.#actor(),
      occurredAt: createdAt,
      reasonCode: "merge-authorization-selected",
      correlationId: run.value.correlationId,
      kind: "registered",
      from: null,
      to: "ready"
    });
    return this.dependencies.repository.register(policy, run, event, candidate);
  }

  async #execute(
    initial: FactoryAutonomousMergeJournalSnapshot
  ): Promise<FactoryAutonomousMergeRunReport> {
    let journal = initial;
    try {
      for (let transitions = 0; transitions < 9; transitions += 1) {
        const authorization = await this.#authorization(journal);
        if (journal.state === "ready") {
          this.#assertBeforeDeadline(journal, authorization);
          if (!(await this.#mutationAuthorityEnabled())) {
            return reportFor(journal, "blocked", "merge-authority-disabled", null);
          }
          this.#assertDraftSnapshot(
            authorization.value,
            await this.dependencies.remote.observe(authorization.value)
          );
          journal = await this.#append(journal, {
            kind: "ready-intent-recorded",
            from: "ready",
            to: "ready-intent-recorded",
            reasonCode: "durable-ready-for-review-intent"
          });
          continue;
        }
        if (journal.state === "ready-intent-recorded") {
          this.#assertBeforeDeadline(journal, authorization);
          if (!(await this.#mutationAuthorityEnabled())) {
            return reportFor(journal, "blocked", "merge-authority-disabled", null);
          }
          const snapshot = await this.dependencies.remote.markReadyForReview(authorization.value);
          this.#assertReadySnapshot(authorization.value, snapshot);
          journal = await this.#append(journal, {
            kind: "ready-for-review",
            from: "ready-intent-recorded",
            to: "ready-for-review",
            reasonCode: "pull-request-ready-for-review"
          });
          continue;
        }
        if (journal.state === "ready-for-review") {
          this.#assertBeforeDeadline(journal, authorization);
          if (!(await this.#mutationAuthorityEnabled())) {
            return reportFor(journal, "blocked", "merge-authority-disabled", null);
          }
          await this.#ensureMergeQueued(journal, authorization);
          journal = await this.#append(journal, {
            kind: "enqueue-intent-recorded",
            from: "ready-for-review",
            to: "enqueue-intent-recorded",
            reasonCode: "durable-merge-queue-intent"
          });
          continue;
        }
        if (journal.state === "enqueue-intent-recorded") {
          this.#assertBeforeDeadline(journal, authorization);
          if (!(await this.#mutationAuthorityEnabled())) {
            return reportFor(journal, "blocked", "merge-authority-disabled", null);
          }
          const enqueued = await this.dependencies.remote.enqueue(authorization.value);
          if (enqueued.snapshot.merged) {
            this.#assertMergedSnapshot(authorization.value, enqueued.snapshot);
            journal = await this.#append(journal, {
              kind: "merged",
              from: "enqueue-intent-recorded",
              to: "merged",
              reasonCode: enqueued.created
                ? "merge-queue-completed-immediately"
                : "merge-queue-completion-reconciled",
              mergeQueueEntryId: enqueued.mergeQueueEntryId,
              mergedRevision: required(enqueued.snapshot.mergedRevision, "merged revision"),
              mergedAt: required(enqueued.snapshot.mergedAt, "merged time")
            });
            continue;
          }
          this.#assertReadySnapshot(authorization.value, enqueued.snapshot);
          journal = await this.#append(journal, {
            kind: "enqueued",
            from: "enqueue-intent-recorded",
            to: "enqueued",
            reasonCode: enqueued.created ? "merge-queue-entry-created" : "merge-queue-reconciled",
            mergeQueueEntryId: enqueued.mergeQueueEntryId
          });
          return reportFor(journal, "pending", null, null);
        }
        if (journal.state === "enqueued") {
          const snapshot = await this.dependencies.remote.observe(authorization.value);
          if (!snapshot.merged) {
            this.#assertReadySnapshot(authorization.value, snapshot);
            return reportFor(journal, "pending", null, null);
          }
          this.#assertMergedSnapshot(authorization.value, snapshot);
          const enqueued = journal.lastEvent;
          if (enqueued.kind !== "enqueued") {
            throw new Error("Enqueued merge journal lost its queue entry identity.");
          }
          journal = await this.#append(journal, {
            kind: "merged",
            from: "enqueued",
            to: "merged",
            reasonCode: "merge-queue-completion-observed",
            mergeQueueEntryId: enqueued.mergeQueueEntryId,
            mergedRevision: required(snapshot.mergedRevision, "merged revision"),
            mergedAt: required(snapshot.mergedAt, "merged time")
          });
          continue;
        }
        if (journal.state === "merged") {
          const published = await this.#publishedRecord(journal, authorization);
          if (published !== null) {
            journal = await this.#recordEvidence(
              journal,
              published.record,
              published.evidenceBundleDigest
            );
            continue;
          }
          const merged = journal.lastEvent;
          if (merged.kind !== "merged") throw new Error("Merged journal has no merged event.");
          const record = this.dependencies.documents.autonomousMergeRecord({
            schemaVersion: "agentlab.autonomous-merge-record.v1",
            mergeRunId: journal.run.mergeRunId,
            runDigest: journal.runDigest,
            authorizationDigest: authorization.digest,
            taskId: journal.run.taskId,
            contractDigest: journal.run.contractDigest,
            repositoryId: journal.run.repositoryId,
            pullRequestNumber: journal.run.pullRequestNumber,
            pullRequestUrl: journal.run.pullRequestUrl,
            expectedHeadRevision: journal.run.expectedHeadRevision,
            mergedRevision: merged.mergedRevision,
            mergerId: journal.run.mergePolicy.mergerId,
            mergeQueueEntryId: merged.mergeQueueEntryId,
            mergedAt: merged.mergedAt,
            recordedAt: factoryTimestampSchema.parse(this.dependencies.now())
          });
          await this.dependencies.remote.verifyRecord(authorization.value, record.value);
          const task = await this.#task(journal.run.taskId);
          const evidence = await this.#publisher.autonomousMergeRecord({
            task,
            authorization,
            record
          });
          journal = await this.#recordEvidence(journal, record, evidence.digest);
          continue;
        }
        if (journal.state === "merge-evidence-recorded") {
          const evidenceEvent = journal.lastEvent;
          if (evidenceEvent.kind !== "evidence-recorded") {
            throw new Error("Merge evidence state lost its evidence identity.");
          }
          let task = await this.#task(journal.run.taskId);
          if (task.state === "merge-queued") {
            task = await this.dependencies.controlPlane.transition({
              taskId: journal.run.taskId,
              expectedState: "merge-queued",
              nextState: "merged",
              actor: this.#actor(),
              reasonCode: "merge-queue-completed",
              summary: "Exact authorized pull-request head merged through the repository queue.",
              evidenceBundleDigest: evidenceEvent.evidenceBundleDigest
            });
          } else if (task.state !== "merged") {
            throw new FactoryAutonomousMergeQuarantineError(
              "Task state changed outside the autonomous merge journal."
            );
          }
          journal = await this.#append(journal, {
            kind: "completed",
            from: "merge-evidence-recorded",
            to: "completed",
            reasonCode: "merge-ledger-completed",
            taskEventDigest: task.lastEventDigest
          });
          return reportFor(journal, "completed", null, journal.record?.mergedRevision ?? null);
        }
        if (journal.state === "completed") {
          return reportFor(journal, "completed", null, journal.record?.mergedRevision ?? null);
        }
        return reportFor(
          journal,
          journal.state === "stale" ? "stale" : "quarantined",
          journal.lastEvent.reasonCode,
          journal.record?.mergedRevision ?? null
        );
      }
      throw new Error("Autonomous merge exceeded its bounded local transition count.");
    } catch (error: unknown) {
      if (error instanceof FactoryAutonomousMergeStaleError) {
        const closed = await this.#terminal(journal, "stale", "merge-remote-state-stale");
        return reportFor(closed, "stale", closed.lastEvent.reasonCode, null);
      }
      if (error instanceof FactoryAutonomousMergeQuarantineError) {
        const closed = await this.#terminal(
          journal,
          "quarantined",
          "merge-remote-state-quarantined"
        );
        return reportFor(closed, "quarantined", closed.lastEvent.reasonCode, null);
      }
      throw error;
    }
  }

  async #authorization(
    journal: FactoryAutonomousMergeJournalSnapshot
  ): Promise<CanonicalFactoryDocument<FactoryAutonomousMergeAuthorization>> {
    const task = await this.#task(journal.run.taskId);
    const bundles = await this.dependencies.evidence.listEvidence(task.contract.taskId);
    const candidate = await this.#authorizationFromEvidence(task, bundles);
    if (
      candidate?.authorization.digest !== journal.run.authorizationDigest ||
      candidate.authorization.value.authorizationId !== journal.run.authorizationId
    ) {
      throw new FactoryAutonomousMergeQuarantineError(
        "Merge journal lost its exact authenticated authorization."
      );
    }
    return candidate.authorization;
  }

  async #authorizationFromEvidence(
    task: FactoryTaskSnapshot,
    bundles: readonly StoredEvidenceBundle[]
  ): Promise<FactoryAutonomousMergeCandidate | null> {
    const candidates = bundles.flatMap((bundle) =>
      bundle.bundle.items
        .filter(
          (item) => item.kind === "merge" && item.artifact.mediaType === authorizationMediaType
        )
        .map((item) => ({ bundle, item }))
    );
    const latest = candidates.at(-1);
    if (latest === undefined) return null;
    const authorization = this.dependencies.documents.autonomousMergeAuthorization(
      parseJson(
        await this.dependencies.artifacts.readText(
          latest.item.artifact.digest,
          latest.item.artifact.sizeBytes + 1
        )
      )
    );
    if (
      authorization.digest !== latest.item.artifact.digest ||
      authorization.digest !== latest.item.subjectDigest ||
      authorization.value.taskId !== task.contract.taskId ||
      authorization.value.contractDigest !== task.contractDigest ||
      authorization.value.policyBundleDigest !== this.dependencies.factoryPolicyBundleDigest ||
      authorization.value.mergePolicyDigest !== this.dependencies.mergePolicy.digest ||
      authorization.value.repositoryId !== task.contract.repository.id ||
      authorization.value.expectedBaseRevision !== task.contract.repository.baseRevision ||
      latest.item.result !== "pass" ||
      latest.item.producer.kind !== "control-plane" ||
      latest.item.producer.role !== "policy-engine" ||
      latest.item.producer.id !== "agentlab-policy" ||
      latest.item.createdAt !== authorization.value.issuedAt ||
      claim(latest.item, "merge-policy-digest") !== this.dependencies.mergePolicy.digest ||
      claim(latest.item, "head-revision") !== authorization.value.expectedHeadRevision
    ) {
      throw new Error("Autonomous merge candidate authorization failed identity validation.");
    }
    return { authorization, evidenceBundleDigest: latest.bundle.digest };
  }

  async #publishedRecord(
    journal: FactoryAutonomousMergeJournalSnapshot,
    authorization: CanonicalFactoryDocument<FactoryAutonomousMergeAuthorization>
  ): Promise<{
    readonly record: CanonicalFactoryDocument<FactoryAutonomousMergeRecord>;
    readonly evidenceBundleDigest: Sha256Digest;
  } | null> {
    const bundles = await this.dependencies.evidence.listEvidence(journal.run.taskId);
    for (const bundle of bundles) {
      for (const item of bundle.bundle.items) {
        if (
          item.kind !== "merge" ||
          item.artifact.mediaType !== recordMediaType ||
          item.subjectDigest !== authorization.digest
        )
          continue;
        const record = this.dependencies.documents.autonomousMergeRecord(
          parseJson(
            await this.dependencies.artifacts.readText(
              item.artifact.digest,
              item.artifact.sizeBytes + 1
            )
          )
        );
        if (
          record.digest !== item.artifact.digest ||
          record.value.mergeRunId !== journal.run.mergeRunId ||
          record.value.runDigest !== journal.runDigest ||
          record.value.authorizationDigest !== authorization.digest ||
          record.value.mergerId !== journal.run.mergePolicy.mergerId ||
          item.result !== "pass" ||
          item.producer.kind !== "broker" ||
          item.producer.role !== "merger" ||
          item.producer.id !== journal.run.mergePolicy.mergerId ||
          claim(item, "merged-revision") !== record.value.mergedRevision
        ) {
          throw new Error("Published autonomous merge evidence failed identity validation.");
        }
        return { record, evidenceBundleDigest: bundle.digest };
      }
    }
    return null;
  }

  async #recordEvidence(
    journal: FactoryAutonomousMergeJournalSnapshot,
    record: CanonicalFactoryDocument<FactoryAutonomousMergeRecord>,
    evidenceBundleDigest: Sha256Digest
  ): Promise<FactoryAutonomousMergeJournalSnapshot> {
    const event = this.#event(journal, {
      kind: "evidence-recorded",
      from: "merged",
      to: "merge-evidence-recorded",
      reasonCode: "authenticated-merge-evidence-recorded",
      recordDigest: record.digest,
      evidenceBundleDigest
    });
    const appended = await this.dependencies.repository.record(event, record);
    if (appended === null) throw new Error("Autonomous merge journal changed concurrently.");
    return appended;
  }

  async #ensureMergeQueued(
    journal: FactoryAutonomousMergeJournalSnapshot,
    authorization: CanonicalFactoryDocument<FactoryAutonomousMergeAuthorization>
  ): Promise<void> {
    const task = await this.#task(journal.run.taskId);
    if (task.state === "merge-queued") return;
    if (task.state !== "merge-ready") {
      throw new FactoryAutonomousMergeQuarantineError(
        "Autonomous merge task is outside its admitted state."
      );
    }
    const bundles = await this.dependencies.evidence.listEvidence(task.contract.taskId);
    const candidate = await this.#authorizationFromEvidence(task, bundles);
    if (
      candidate?.authorization.digest !== authorization.digest ||
      candidate.evidenceBundleDigest !== bundles.at(-1)?.digest
    ) {
      throw new FactoryAutonomousMergeQuarantineError(
        "Autonomous merge authorization is no longer the exact latest task evidence."
      );
    }
    await this.dependencies.controlPlane.transition({
      taskId: task.contract.taskId,
      expectedState: "merge-ready",
      nextState: "merge-queued",
      actor: this.#actor(),
      reasonCode: "merge-queue-authorized",
      summary: "Separate merger accepted one exact short-lived merge authorization.",
      evidenceBundleDigest: candidate.evidenceBundleDigest
    });
  }

  #assertDraftSnapshot(
    authorization: FactoryAutonomousMergeAuthorization,
    snapshot: FactoryAutonomousMergeRemoteSnapshot
  ): void {
    this.#assertIdentity(authorization, snapshot);
    if (snapshot.state !== "open" || !snapshot.draft || snapshot.merged) {
      throw new FactoryAutonomousMergeStaleError(
        "Pull request is no longer the authorized open draft."
      );
    }
  }

  #assertReadySnapshot(
    authorization: FactoryAutonomousMergeAuthorization,
    snapshot: FactoryAutonomousMergeRemoteSnapshot
  ): void {
    this.#assertIdentity(authorization, snapshot);
    if (snapshot.state !== "open" || snapshot.draft || snapshot.merged) {
      throw new FactoryAutonomousMergeStaleError(
        "Pull request is not an exact open ready-for-review head."
      );
    }
  }

  #assertMergedSnapshot(
    authorization: FactoryAutonomousMergeAuthorization,
    snapshot: FactoryAutonomousMergeRemoteSnapshot
  ): void {
    this.#assertIdentity(authorization, snapshot);
    if (
      snapshot.state !== "closed" ||
      !snapshot.merged ||
      snapshot.mergedRevision === null ||
      snapshot.mergedAt === null
    ) {
      throw new FactoryAutonomousMergeQuarantineError(
        "Remote merge result lacks exact queue-backed completion identity."
      );
    }
  }

  #assertIdentity(
    authorization: FactoryAutonomousMergeAuthorization,
    snapshot: FactoryAutonomousMergeRemoteSnapshot
  ): void {
    if (
      snapshot.repositoryId !== authorization.repositoryId ||
      snapshot.pullRequestNumber !== authorization.pullRequestNumber ||
      snapshot.pullRequestUrl !== authorization.pullRequestUrl ||
      snapshot.baseRevision !== authorization.expectedBaseRevision ||
      snapshot.headRevision !== authorization.expectedHeadRevision
    ) {
      throw new FactoryAutonomousMergeQuarantineError(
        "Remote pull request changed its authorized repository, URL, base, or head identity."
      );
    }
  }

  async #terminal(
    journal: FactoryAutonomousMergeJournalSnapshot,
    state: "stale" | "quarantined",
    reasonCode: string
  ): Promise<FactoryAutonomousMergeJournalSnapshot> {
    if (journal.state === "stale" || journal.state === "quarantined") return journal;
    if (journal.state === "merged" || journal.state === "merge-evidence-recorded") {
      throw new Error("A remotely merged change cannot be relabeled stale or quarantined.");
    }
    return this.#append(journal, {
      kind: state,
      from: journal.state,
      to: state,
      reasonCode
    } as EventPayload);
  }

  #assertBeforeDeadline(
    journal: FactoryAutonomousMergeJournalSnapshot,
    authorization: CanonicalFactoryDocument<FactoryAutonomousMergeAuthorization>
  ): void {
    const now = factoryTimestampSchema.parse(this.dependencies.now());
    if (now >= journal.run.deadlineAt || now >= authorization.value.expiresAt) {
      throw new FactoryAutonomousMergeStaleError(
        "Autonomous merge authorization or operation deadline expired."
      );
    }
  }

  async #mutationAuthorityEnabled(): Promise<boolean> {
    return controlDenials(await this.dependencies.controls.state()).length === 0;
  }

  async #append(
    journal: FactoryAutonomousMergeJournalSnapshot,
    payload: EventPayload
  ): Promise<FactoryAutonomousMergeJournalSnapshot> {
    const event = this.#event(journal, payload);
    const appended = await this.dependencies.repository.append(event);
    if (appended === null) throw new Error("Autonomous merge journal changed concurrently.");
    return appended;
  }

  #event(
    journal: FactoryAutonomousMergeJournalSnapshot,
    payload: EventPayload
  ): CanonicalFactoryDocument<FactoryAutonomousMergeEvent> {
    return this.dependencies.documents.autonomousMergeEvent({
      schemaVersion: "agentlab.autonomous-merge-event.v1",
      eventId: this.dependencies.createId(),
      mergeRunId: journal.run.mergeRunId,
      runDigest: journal.runDigest,
      sequence: journal.sequence + 1,
      previousEventDigest: journal.lastEventDigest,
      actor: this.#actor(),
      occurredAt: payload.occurredAt ?? factoryTimestampSchema.parse(this.dependencies.now()),
      correlationId: journal.run.correlationId,
      ...payload
    });
  }

  #actor() {
    return {
      kind: "broker" as const,
      role: "merger" as const,
      id: this.dependencies.mergePolicy.value.mergerId,
      sessionId: null
    };
  }

  #assertPins(command: z.infer<typeof tickInputSchema>): void {
    const policy = this.dependencies.mergePolicy;
    if (
      command.expectedMergePolicyDigest !== policy.digest ||
      command.expectedFactoryPolicyBundleDigest !== this.dependencies.factoryPolicyBundleDigest ||
      command.expectedSchedulePolicyDigest !== policy.value.schedulePolicyDigest ||
      command.expectedDailyQuotaPolicyDigest !== policy.value.dailyQuotaPolicyDigest ||
      command.expectedRoleIdentityPolicyDigest !== policy.value.roleIdentityPolicyDigest
    ) {
      throw new Error("Autonomous merge broker policy changed after operator review.");
    }
  }

  #report(
    reports: readonly FactoryAutonomousMergeRunReport[],
    controls: readonly string[]
  ): FactoryAutonomousMergeTickReport {
    const counts = {
      completed: reports.filter(({ status }) => status === "completed").length,
      pending: reports.filter(({ status }) => status === "pending").length,
      stale: reports.filter(({ status }) => status === "stale").length,
      blocked: reports.filter(({ status }) => status === "blocked").length,
      quarantined: reports.filter(({ status }) => status === "quarantined").length
    };
    const reasonCodes = [
      ...controls,
      ...reports.flatMap(({ reasonCode }) => (reasonCode === null ? [] : [reasonCode]))
    ]
      .filter((value, index, values) => values.indexOf(value) === index)
      .toSorted();
    const status =
      reports.length === 0
        ? controls.length === 0
          ? "idle"
          : "blocked"
        : counts.completed === reports.length
          ? "completed"
          : counts.pending === reports.length
            ? "pending"
            : counts.blocked === reports.length
              ? "blocked"
              : "partial";
    return {
      schemaVersion: "agentlab.autonomous-merge-tick-result.v1",
      status,
      repositoryId: this.dependencies.mergePolicy.value.repositoryId,
      mergePolicyDigest: this.dependencies.mergePolicy.digest,
      inspected: reports.length,
      ...counts,
      reasonCodes,
      runs: reports
    };
  }

  async #task(taskId: string): Promise<FactoryTaskSnapshot> {
    const task = await this.dependencies.tasks.findById(taskId);
    if (task === null) throw new Error(`Factory task ${taskId} does not exist.`);
    return task;
  }
}

function reportFor(
  journal: FactoryAutonomousMergeJournalSnapshot,
  status: FactoryAutonomousMergeRunReport["status"],
  reasonCode: string | null,
  mergedRevision: string | null
): FactoryAutonomousMergeRunReport {
  return {
    mergeRunId: journal.run.mergeRunId,
    authorizationDigest: journal.run.authorizationDigest,
    taskId: journal.run.taskId,
    pullRequestNumber: journal.run.pullRequestNumber,
    status,
    reasonCode,
    mergedRevision
  };
}

function controlDenials(state: {
  readonly scheduler: boolean;
  readonly prBroker: boolean;
  readonly mergeBroker?: boolean;
}): string[] {
  return [
    ...(state.scheduler ? [] : ["scheduler-disabled"]),
    ...(state.prBroker ? [] : ["pr-broker-disabled"]),
    ...(state.mergeBroker ? [] : ["merge-broker-disabled"])
  ];
}

function earliest(left: string, right: string): string {
  return left < right ? left : right;
}

function required<Value>(value: Value | null, label: string): Value {
  if (value === null) throw new Error(`Autonomous merge lacks its ${label}.`);
  return value;
}

function claim(item: EvidenceItem, name: string): string | null {
  return item.claims.find((candidate) => candidate.name === name)?.value ?? null;
}

function parseJson(json: string): unknown {
  try {
    return JSON.parse(json) as unknown;
  } catch (error: unknown) {
    throw new Error("Stored autonomous merge artifact is not valid JSON.", { cause: error });
  }
}
