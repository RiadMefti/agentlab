import {
  factoryReviewDecisionSchema,
  factoryTimestampSchema,
  sha256DigestSchema,
  type FactoryActor,
  type FactoryArtifactReference,
  type FactoryBudget,
  type FactoryBudgetUsage,
  type FactoryExternalPullRequestRepairExecutionPolicy,
  type FactoryExternalPullRequestRepairQualificationEvent,
  type FactoryExternalPullRequestRepairQualificationPolicy,
  type FactoryExternalPullRequestReviewerRecord,
  type FactoryExternalPullRequestReviewResult,
  type FactoryGateObservation,
  type FactoryResourceIsolationRecord,
  type Sha256Digest
} from "@agentlab/contracts";
import { z } from "zod";

import {
  factoryProcessCleanupUnconfirmedErrorCode,
  type FactoryAgentExecutor,
  type FactoryAgentProviderResolver
} from "../domain/factory-agent-executor.js";
import type { FactoryArtifactStore } from "../domain/factory-artifact-store.js";
import { minimumFactoryBudget } from "../domain/factory-authority-limits.js";
import { FactoryBudgetMeter } from "../domain/factory-budget-meter.js";
import type {
  FactoryExternalPullRequestRepairQualificationCandidate,
  FactoryExternalPullRequestRepairQualificationJournalSnapshot,
  FactoryExternalPullRequestRepairQualificationRepository
} from "../domain/factory-external-pull-request-repair-qualification-repository.js";
import {
  resolveExternalPullRequestRepairQualificationReviewers,
  type ResolvedExternalPullRequestRepairQualificationReviewer
} from "../domain/factory-external-pull-request-repair-qualification-policy.js";
import {
  FactoryExternalPullRequestRepairQualificationWorkspaceCleanupUnconfirmedError,
  type FactoryExternalPullRequestRepairQualificationWorkspace,
  type FactoryExternalPullRequestRepairQualificationWorkspaceManager
} from "../domain/factory-external-pull-request-repair-qualification-workspace.js";
import type {
  CanonicalFactoryDocument,
  FactoryDocumentCodec
} from "../domain/factory-documents.js";
import {
  FactoryGateProcessCleanupUnconfirmedError,
  type FactoryGateExecutionOutput,
  type FactoryGateExecutor
} from "../domain/factory-gate.js";
import { narrowFactoryResourceLimits } from "../domain/factory-process-isolation.js";
import type { FactorySkillSource } from "../domain/factory-skill.js";
import type { FactoryControlRepository } from "../domain/factory-task-repository.js";
import {
  factoryTimestampAddSeconds,
  factoryTimestampDifferenceSeconds
} from "../domain/factory-timestamp.js";
import type { FactoryWorkspaceRecoveryReconciler } from "../domain/factory-workspace-recovery.js";
import { renderExternalPullRequestRepairQualificationPrompt } from "./factory-external-pull-request-repair-qualification-prompt.js";
import { externalPullRequestReviewOutputSchemaJson } from "./factory-external-pull-request-review-prompt.js";

const tickInputSchema = z
  .object({
    expectedQualificationPolicyDigest: sha256DigestSchema,
    expectedRepairExecutionPolicyDigest: sha256DigestSchema,
    expectedCostPolicyDigest: sha256DigestSchema,
    expectedRoleIdentityPolicyDigest: sha256DigestSchema,
    expectedGateProfileDigest: sha256DigestSchema
  })
  .strict();

export interface FactoryExternalPullRequestRepairQualificationPreflight {
  readonly schemaVersion: "agentlab.external-pull-request-repair-qualification-preflight.v1";
  readonly status: "ready" | "blocked";
  readonly repositoryId: string;
  readonly qualificationPolicyDigest: Sha256Digest;
  readonly repairExecutionPolicyDigest: Sha256Digest;
  readonly costPolicyDigest: Sha256Digest;
  readonly roleIdentityPolicyDigest: Sha256Digest;
  readonly gateProfileDigest: Sha256Digest;
  readonly gateIds: readonly string[];
  readonly reviewers: number;
  readonly schedulerEnabled: boolean;
  readonly remoteWrite: false;
  readonly autoMerge: false;
  readonly release: false;
  readonly reasonCodes: readonly string[];
}

export interface FactoryExternalPullRequestRepairQualificationRunReport {
  readonly qualificationRunId: string;
  readonly runDigest: Sha256Digest;
  readonly repairBundleDigest: Sha256Digest;
  readonly pullRequestNumber: number;
  readonly status: "completed" | "failed" | "quarantined" | "blocked";
  readonly decision: "qualified" | "rejected" | "human-review-required" | null;
  readonly qualificationBundleDigest: Sha256Digest | null;
  readonly reasonCode: string | null;
}

export interface FactoryExternalPullRequestRepairQualificationTickReport {
  readonly schemaVersion: "agentlab.external-pull-request-repair-qualification-tick-result.v1";
  readonly status: "completed" | "idle" | "partial" | "blocked";
  readonly repositoryId: string;
  readonly qualificationPolicyDigest: Sha256Digest;
  readonly inspected: number;
  readonly completed: number;
  readonly qualified: number;
  readonly rejected: number;
  readonly humanReviewRequired: number;
  readonly failed: number;
  readonly quarantined: number;
  readonly reasonCodes: readonly string[];
  readonly runs: readonly FactoryExternalPullRequestRepairQualificationRunReport[];
}

export interface FactoryExternalPullRequestRepairQualificationServiceDependencies {
  readonly repositoryRoot: string;
  readonly qualificationPolicy: CanonicalFactoryDocument<FactoryExternalPullRequestRepairQualificationPolicy>;
  readonly repairExecutionPolicy: CanonicalFactoryDocument<FactoryExternalPullRequestRepairExecutionPolicy>;
  readonly repository: FactoryExternalPullRequestRepairQualificationRepository;
  readonly controls: Pick<FactoryControlRepository, "state">;
  readonly artifacts: FactoryArtifactStore;
  readonly documents: FactoryDocumentCodec;
  readonly skills: FactorySkillSource;
  readonly workspaces: FactoryExternalPullRequestRepairQualificationWorkspaceManager;
  readonly recovery: FactoryWorkspaceRecoveryReconciler;
  readonly gates: FactoryGateExecutor;
  readonly agents: FactoryAgentExecutor;
  readonly providers: FactoryAgentProviderResolver;
  readonly now: () => string;
  readonly createId: () => string;
}

type EventPayload<
  Event extends FactoryExternalPullRequestRepairQualificationEvent =
    FactoryExternalPullRequestRepairQualificationEvent
> = Event extends FactoryExternalPullRequestRepairQualificationEvent
  ? Omit<
      Event,
      | "schemaVersion"
      | "eventId"
      | "qualificationRunId"
      | "runDigest"
      | "sequence"
      | "previousEventDigest"
      | "actor"
      | "occurredAt"
      | "correlationId"
    > & { readonly occurredAt?: string }
  : never;

interface QualificationEvidence {
  readonly gateObservations: FactoryGateObservation[];
  readonly gateIsolationRecords: FactoryResourceIsolationRecord[];
  readonly reviewerRecords: FactoryExternalPullRequestReviewerRecord[];
  readonly reviews: FactoryExternalPullRequestReviewResult[];
  readonly meter: FactoryBudgetMeter;
}

/** Runs the strict gate floor and distinct read-only review without any remote-write capability. */
export class FactoryExternalPullRequestRepairQualificationService {
  public constructor(
    private readonly dependencies: FactoryExternalPullRequestRepairQualificationServiceDependencies
  ) {}

  public async preflight(): Promise<FactoryExternalPullRequestRepairQualificationPreflight> {
    const reviewers = await this.#resolveReviewers();
    const [profileReasons, controls] = await Promise.all([
      this.#profileReasonCodes(reviewers),
      this.dependencies.controls.state()
    ]);
    const reasonCodes = [
      ...profileReasons,
      ...(controls.scheduler ? [] : ["scheduler-disabled"])
    ].toSorted();
    const policy = this.dependencies.qualificationPolicy;
    return {
      schemaVersion: "agentlab.external-pull-request-repair-qualification-preflight.v1",
      status: reasonCodes.length === 0 ? "ready" : "blocked",
      repositoryId: policy.value.repositoryId,
      qualificationPolicyDigest: policy.digest,
      repairExecutionPolicyDigest: this.dependencies.repairExecutionPolicy.digest,
      costPolicyDigest: policy.value.costPolicyDigest,
      roleIdentityPolicyDigest: policy.value.roleIdentityPolicyDigest,
      gateProfileDigest: policy.value.gateProfileDigest,
      gateIds: policy.value.gateProfile.gates.map(({ id }) => id),
      reviewers: policy.value.minimumIndependentReviews,
      schedulerEnabled: controls.scheduler,
      remoteWrite: false,
      autoMerge: false,
      release: false,
      reasonCodes
    };
  }

  public async tick(
    input: unknown
  ): Promise<FactoryExternalPullRequestRepairQualificationTickReport> {
    const command = tickInputSchema.parse(input);
    this.#assertPins(command);
    const reviewers = await this.#resolveReviewers();
    const [profileReasons, controls] = await Promise.all([
      this.#profileReasonCodes(reviewers),
      this.dependencies.controls.state()
    ]);
    const executionBlockers = [
      ...profileReasons,
      ...(controls.scheduler ? [] : ["scheduler-disabled"])
    ].toSorted();
    const policy = this.dependencies.qualificationPolicy;
    const active = await this.dependencies.repository.listActive({
      repositoryId: policy.value.repositoryId,
      qualificationPolicyDigest: policy.digest,
      limit: policy.value.maximumCandidatesPerTick
    });
    const reports: FactoryExternalPullRequestRepairQualificationRunReport[] = [];
    let schedulingStopped = false;
    for (const journal of active) {
      reports.push(await this.#resume(journal, reviewers, executionBlockers));
    }
    const remaining = policy.value.maximumCandidatesPerTick - reports.length;
    if (
      remaining > 0 &&
      executionBlockers.length === 0 &&
      !reports.some(({ status }) => status === "blocked")
    ) {
      const candidates = await this.dependencies.repository.listCompletedRepairs({
        repositoryId: policy.value.repositoryId,
        repairExecutionPolicyDigest: this.dependencies.repairExecutionPolicy.digest,
        qualificationPolicyDigest: policy.digest,
        limit: remaining
      });
      for (const candidate of candidates) {
        if (!(await this.dependencies.controls.state()).scheduler) {
          schedulingStopped = true;
          break;
        }
        const journal = await this.#register(candidate);
        reports.push(await this.#execute(journal, candidate, reviewers));
      }
    }
    if (reports.length === 0) {
      const reasons = schedulingStopped
        ? [...executionBlockers, "scheduler-disabled-during-repair-qualification-tick"]
        : executionBlockers;
      return this.#report([], reasons.length === 0 ? "idle" : "blocked", reasons);
    }
    const completed = reports.filter(({ status }) => status === "completed").length;
    return this.#report(
      reports,
      schedulingStopped
        ? "partial"
        : completed === reports.length
          ? "completed"
          : completed === 0
            ? "blocked"
            : "partial",
      [
        ...reports.flatMap(({ reasonCode }) => (reasonCode === null ? [] : [reasonCode])),
        ...(schedulingStopped ? ["scheduler-disabled-during-repair-qualification-tick"] : [])
      ]
    );
  }

  async #resolveReviewers() {
    return resolveExternalPullRequestRepairQualificationReviewers(
      this.dependencies.skills,
      this.dependencies.qualificationPolicy.value
    );
  }

  async #profileReasonCodes(
    reviewers: readonly ResolvedExternalPullRequestRepairQualificationReviewer[]
  ): Promise<readonly string[]> {
    const reasons: string[] = [];
    const expectedGates = this.dependencies.qualificationPolicy.value.gateProfile.gates.map(
      ({ id }) => id
    );
    if (
      this.dependencies.gates.availableGateIds().toSorted().join("\0") !==
      expectedGates.toSorted().join("\0")
    ) {
      reasons.push("strict-gate-inventory-mismatch");
    }
    const capabilities = this.dependencies.agents.capabilities();
    for (const { profile } of reviewers) {
      const capability = capabilities.find(({ provider }) => provider === profile.provider);
      if (!capability?.roles.includes("reviewer") || capability.acceptsCommandAllowlist) {
        reasons.push(`reviewer-${profile.id}-capability-unavailable`);
        continue;
      }
      try {
        this.dependencies.agents.preflight({
          provider: profile.provider,
          model: profile.model,
          policyBundleDigest: this.dependencies.qualificationPolicy.value.costPolicyDigest
        });
        if (
          (await this.dependencies.providers.resolve(
            profile.provider,
            this.dependencies.repositoryRoot
          )) === null
        ) {
          reasons.push(`reviewer-${profile.id}-provider-unavailable`);
        }
      } catch {
        reasons.push(`reviewer-${profile.id}-provider-unavailable`);
      }
    }
    return [...new Set(reasons)].sort();
  }

  async #register(
    candidate: FactoryExternalPullRequestRepairQualificationCandidate
  ): Promise<FactoryExternalPullRequestRepairQualificationJournalSnapshot> {
    const repairerRecord = await this.#repairerRecord(candidate);
    if (repairerRecord.value.providerSessionId === null) {
      throw new Error("Completed external repair has no provider session identity.");
    }
    const createdAt = factoryTimestampSchema.parse(this.dependencies.now());
    const execution = candidate.repairRun.value;
    const repair = candidate.repairBundle.value;
    const policy = this.dependencies.qualificationPolicy;
    const run = this.dependencies.documents.externalPullRequestRepairQualificationRun({
      schemaVersion: "agentlab.external-pull-request-repair-qualification-run.v1",
      qualificationRunId: this.dependencies.createId(),
      repositoryId: execution.repositoryId,
      pullRequestNumber: execution.pullRequestNumber,
      repairRunId: execution.runId,
      repairRunDigest: candidate.repairRun.digest,
      repairBundleDigest: candidate.repairBundle.digest,
      authorizationDigest: execution.authorizationDigest,
      repairExecutionPolicyDigest: candidate.repairRun.value.repairExecutionPolicyDigest,
      qualificationPolicyDigest: policy.digest,
      qualificationPolicy: policy.value,
      gateProfileDigest: policy.value.gateProfileDigest,
      expectedBaseRevision: execution.expectedBaseRevision,
      expectedHeadRevision: execution.expectedHeadRevision,
      originalPatchDigest: execution.originalPatchDigest,
      repairedPatchDigest: repair.patchArtifact.digest,
      repairerId: execution.repairExecutionPolicy.repairerProfile.id,
      repairerRecordDigest: repair.repairerRecordDigest,
      repairerExecutionId: repair.executionId,
      repairerProviderSessionId: repairerRecord.value.providerSessionId,
      workspaceId: this.dependencies.createId(),
      createdAt,
      deadlineAt: factoryTimestampAddSeconds(createdAt, policy.value.operationDeadlineSeconds),
      correlationId: this.dependencies.createId()
    });
    const event = this.dependencies.documents.externalPullRequestRepairQualificationEvent({
      schemaVersion: "agentlab.external-pull-request-repair-qualification-event.v1",
      eventId: this.dependencies.createId(),
      qualificationRunId: run.value.qualificationRunId,
      runDigest: run.digest,
      sequence: 1,
      previousEventDigest: null,
      actor: actor(run.value.qualificationRunId),
      kind: "registered",
      from: null,
      to: "ready",
      occurredAt: createdAt,
      reasonCode: "completed-external-repair-consumed",
      correlationId: run.value.correlationId
    });
    return this.dependencies.repository.register(policy, run, event, candidate, repairerRecord);
  }

  async #resume(
    journal: FactoryExternalPullRequestRepairQualificationJournalSnapshot,
    reviewers: readonly ResolvedExternalPullRequestRepairQualificationReviewer[],
    executionBlockers: readonly string[]
  ): Promise<FactoryExternalPullRequestRepairQualificationRunReport> {
    if (journal.state === "recorded") return this.#complete(journal);
    if (journal.state === "ready") {
      const blocker = executionBlockers[0];
      if (blocker !== undefined) return reportFor(journal, "blocked", blocker);
      return this.#execute(journal, await this.#candidateFor(journal), reviewers);
    }
    const result = await this.dependencies.recovery.reconcile({
      taskId: journal.run.qualificationRunId,
      workspaceId: journal.run.workspaceId,
      attempt: 1,
      repositoryRoot: this.dependencies.repositoryRoot,
      baseRevision: journal.run.expectedHeadRevision,
      processExecutionIds: journal.history.flatMap((event) =>
        event.kind === "gate-started"
          ? [event.isolationId]
          : event.kind === "reviewer-started"
            ? [event.executionId]
            : []
      )
    });
    if (result.status !== "inactive") return reportFor(journal, "blocked", result.reasonCode);
    if (journal.state === "gate-active" || journal.state === "reviewer-active") {
      const quarantined = await this.#append(journal, {
        kind: "quarantined",
        from: journal.state,
        to: "quarantined",
        evidenceDigest: null,
        reasonCode:
          journal.state === "gate-active"
            ? "gate-outcome-unrecoverable"
            : "qualification-reviewer-outcome-unrecoverable"
      });
      return reportFor(quarantined, "quarantined", quarantined.lastEvent.reasonCode);
    }
    const recoveryAttempts = journal.history.filter(({ kind }) => kind === "recovered").length;
    if (recoveryAttempts >= journal.run.qualificationPolicy.maximumRecoveryAttempts) {
      const failed = await this.#append(journal, {
        kind: "failed",
        from: journal.state as "workspace-active" | "gating" | "reviewing",
        to: "failed",
        evidenceDigest: null,
        reasonCode: "repair-qualification-recovery-exhausted"
      });
      return reportFor(failed, "failed", "repair-qualification-recovery-exhausted");
    }
    const recovered = await this.#append(journal, {
      kind: "recovered",
      from: journal.state as "workspace-active" | "gating" | "reviewing",
      to: "ready",
      reasonCode: "inactive-qualification-workspace-recovered"
    });
    const blocker = executionBlockers[0];
    if (blocker !== undefined) return reportFor(recovered, "blocked", blocker);
    return this.#execute(recovered, await this.#candidateFor(recovered), reviewers);
  }

  async #candidateFor(journal: FactoryExternalPullRequestRepairQualificationJournalSnapshot) {
    const candidate = await this.dependencies.repository.findCandidateByRepairBundle(
      journal.run.repairBundleDigest
    );
    if (candidate === null) {
      throw new Error("Active repair qualification lost its completed repair projection.");
    }
    return candidate;
  }

  async #execute(
    initial: FactoryExternalPullRequestRepairQualificationJournalSnapshot,
    candidate: FactoryExternalPullRequestRepairQualificationCandidate,
    reviewers: readonly ResolvedExternalPullRequestRepairQualificationReviewer[]
  ): Promise<FactoryExternalPullRequestRepairQualificationRunReport> {
    let journal = initial;
    let workspace: FactoryExternalPullRequestRepairQualificationWorkspace | null = null;
    let evidenceDigest: Sha256Digest | null = null;
    try {
      this.#assertDeadline(journal, null);
      const patch = await this.#readExactArtifact(
        candidate.repairBundle.value.patchArtifact,
        journal.run.qualificationPolicy.maximumPatchBytes
      );
      journal = await this.#append(journal, {
        kind: "workspace-started",
        from: "ready",
        to: "workspace-active",
        reasonCode: "exact-repaired-head-workspace-started"
      });
      workspace = await this.dependencies.workspaces.prepare({
        qualificationRunId: journal.run.qualificationRunId,
        workspaceId: journal.run.workspaceId,
        repositoryRoot: this.dependencies.repositoryRoot,
        expectedHeadRevision: journal.run.expectedHeadRevision,
        patch,
        expectedPatchDigest: journal.run.repairedPatchDigest,
        expectedChangeSet: candidate.repairBundle.value.changeSet,
        maximumPatchBytes: journal.run.qualificationPolicy.maximumPatchBytes
      });
      const evidence = await this.#loadEvidence(journal, candidate, reviewers, workspace);
      const requiredGates = journal.run.qualificationPolicy.gateProfile.gates;
      const allPriorGatesRecorded = evidence.gateObservations.length === requiredGates.length;
      journal = await this.#append(journal, {
        kind: "workspace-prepared",
        from: "workspace-active",
        to: allPriorGatesRecorded ? "reviewing" : "gating",
        patchDigest: workspace.patchDigest,
        patchArtifact: workspace.patchArtifact,
        reasonCode: "exact-repaired-patch-materialized"
      });

      if (!allPriorGatesRecorded) {
        for (const [index, gate] of requiredGates.entries()) {
          if (evidence.gateObservations.some(({ gateId }) => gateId === gate.id)) continue;
          this.#assertDeadline(journal, evidenceDigest);
          if (!(await this.dependencies.controls.state()).scheduler) {
            throw new QualificationFailure(
              "scheduler-disabled-before-repair-qualification-gate",
              evidenceDigest,
              false
            );
          }
          const gateRemaining = evidence.meter.remaining(
            journal.run.qualificationPolicy.aggregateBudget,
            workspace.changeSet,
            0
          );
          if (
            gateRemaining === null ||
            gateRemaining.wallClockSeconds < Math.ceil(gate.timeoutMs / 1_000) ||
            gateRemaining.maxProcesses < 1 ||
            gateRemaining.maxOutputBytes < gate.maximumOutputBytes ||
            factoryTimestampDifferenceSeconds(
              factoryTimestampSchema.parse(this.dependencies.now()),
              journal.run.deadlineAt
            ) < Math.ceil(gate.timeoutMs / 1_000)
          ) {
            throw new QualificationFailure(
              "repair-qualification-gate-reservation-unavailable",
              evidenceDigest,
              false
            );
          }
          const isolationId = this.dependencies.createId();
          journal = await this.#append(journal, {
            kind: "gate-started",
            from: "gating",
            to: "gate-active",
            gateId: gate.id,
            isolationId,
            reasonCode: "strict-repair-qualification-gate-started"
          });
          const output = await this.dependencies.gates.execute({
            gateId: gate.id,
            isolationId,
            workspace: workspace.workspace,
            resourceLimits: journal.run.qualificationPolicy.resourceLimits
          });
          if (
            output.isolation.isolationId !== isolationId ||
            output.gateId !== gate.id ||
            output.evidenceKind !== gate.evidenceKind ||
            output.outputBytes > gate.maximumOutputBytes
          ) {
            throw new QualificationProcessOutcomeUnconfirmedError(
              "Qualification gate isolation identity changed."
            );
          }
          const recorded = await this.#gateRecords(journal, output, index + 1);
          evidenceDigest = recorded.observation.digest;
          journal = await this.#append(journal, {
            kind: "gate-finished",
            from: "gate-active",
            to: "gating",
            gateId: gate.id,
            isolationId,
            gateObservationDigest: recorded.observation.digest,
            isolationRecordDigest: recorded.isolation.digest,
            reasonCode: "strict-repair-qualification-gate-finished"
          });
          evidence.gateObservations.push(recorded.observation.value);
          evidence.gateIsolationRecords.push(recorded.isolation.value);
          evidence.meter.addGate(output);
          await this.#assertWorkspaceUnchanged(workspace, evidenceDigest);
          if (output.result !== "pass") {
            await workspace.close();
            workspace = null;
            return await this.#recordBundle(journal, candidate, evidence, "rejected");
          }
          if (
            evidence.meter.exceeds(
              journal.run.qualificationPolicy.aggregateBudget,
              candidate.repairBundle.value.changeSet,
              0
            )
          ) {
            throw new QualificationFailure(
              "repair-qualification-aggregate-budget-exhausted",
              evidenceDigest,
              false
            );
          }
        }
        journal = await this.#append(journal, {
          kind: "gates-passed",
          from: "gating",
          to: "reviewing",
          reasonCode: "strict-repair-qualification-gates-passed"
        });
      } else if (evidence.gateObservations.some(({ result }) => result !== "pass")) {
        await workspace.close();
        workspace = null;
        return await this.#recordBundle(journal, candidate, evidence, "rejected");
      }

      const selected = reviewers.slice(
        0,
        journal.run.qualificationPolicy.minimumIndependentReviews
      );
      for (const reviewer of selected) {
        if (evidence.reviews.some(({ reviewerId }) => reviewerId === reviewer.profile.id)) continue;
        this.#assertDeadline(journal, evidenceDigest);
        if (!(await this.dependencies.controls.state()).scheduler) {
          throw new QualificationFailure(
            "scheduler-disabled-before-repair-qualification-review",
            evidenceDigest,
            false
          );
        }
        const remaining = evidence.meter.remaining(
          journal.run.qualificationPolicy.aggregateBudget,
          workspace.changeSet,
          0
        );
        if (remaining === null) {
          throw new QualificationFailure(
            "repair-qualification-aggregate-budget-exhausted",
            evidenceDigest,
            false
          );
        }
        const deadlineSeconds = Math.floor(
          factoryTimestampDifferenceSeconds(
            factoryTimestampSchema.parse(this.dependencies.now()),
            journal.run.deadlineAt
          )
        );
        if (deadlineSeconds < 1) {
          throw new QualificationFailure(
            "external-repair-qualification-deadline-expired",
            evidenceDigest,
            false
          );
        }
        const reviewed = await this.#runReviewer(
          journal,
          candidate,
          reviewer,
          workspace,
          minimumFactoryBudget(reviewer.profile.budget, {
            ...remaining,
            wallClockSeconds: Math.min(remaining.wallClockSeconds, deadlineSeconds)
          })
        );
        journal = reviewed.journal;
        evidenceDigest = reviewed.record.digest;
        evidence.reviewerRecords.push(reviewed.record.value);
        evidence.reviews.push(reviewed.result.value);
        evidence.meter.addUsage(reviewed.record.value.usage, reviewed.record.value.usageComplete);
        await this.#assertWorkspaceUnchanged(workspace, evidenceDigest);
      }
      if (
        evidence.reviews.length !== selected.length ||
        !evidence.meter.complete ||
        evidence.meter.exceeds(
          journal.run.qualificationPolicy.aggregateBudget,
          workspace.changeSet,
          0
        )
      ) {
        throw new QualificationFailure(
          "repair-qualification-evidence-incomplete",
          evidenceDigest,
          false
        );
      }
      const sessions = evidence.reviewerRecords.map(({ providerSessionId }) => providerSessionId);
      if (
        sessions.some(
          (session) => session === null || session === journal.run.repairerProviderSessionId
        ) ||
        new Set(sessions).size !== sessions.length ||
        evidence.reviewerRecords.some(
          ({ executionId }) => executionId === journal.run.repairerExecutionId
        )
      ) {
        throw new QualificationFailure(
          "repair-qualification-reviewer-independence-invalid",
          evidenceDigest,
          true
        );
      }
      await workspace.close();
      workspace = null;
      const approvals = evidence.reviews.filter(({ verdict }) => verdict === "approved").length;
      const decision =
        approvals === evidence.reviews.length
          ? "qualified"
          : approvals === 0
            ? "rejected"
            : "human-review-required";
      return await this.#recordBundle(journal, candidate, evidence, decision);
    } catch (error: unknown) {
      if (
        error instanceof
          FactoryExternalPullRequestRepairQualificationWorkspaceCleanupUnconfirmedError ||
        error instanceof FactoryGateProcessCleanupUnconfirmedError ||
        error instanceof QualificationProcessOutcomeUnconfirmedError ||
        ((journal.state === "gate-active" || journal.state === "reviewer-active") &&
          !(error instanceof QualificationFailure))
      ) {
        throw error;
      }
      if (workspace !== null) {
        try {
          await workspace.close();
        } catch (cleanupError: unknown) {
          throw new AggregateError(
            [error, cleanupError],
            "External repair qualification and workspace cleanup both failed.",
            { cause: error }
          );
        }
      }
      const current = await this.dependencies.repository.findByRepairBundle(
        journal.run.repairBundleDigest,
        journal.run.qualificationPolicyDigest
      );
      if (current === null) throw error;
      if (current.state === "recorded") {
        return reportFor(current, "blocked", "repair-qualification-completion-pending");
      }
      if (!isActiveState(current.state)) throw error;
      const reasonCode =
        error instanceof QualificationFailure
          ? error.reasonCode
          : "external-repair-qualification-failed";
      const quarantined =
        error instanceof QualificationFailure
          ? error.quarantine
          : current.state === "gate-active" || current.state === "reviewer-active";
      const terminal = await this.#append(current, {
        kind: quarantined ? "quarantined" : "failed",
        from: current.state,
        to: quarantined ? "quarantined" : "failed",
        evidenceDigest:
          error instanceof QualificationFailure ? error.evidenceDigest : evidenceDigest,
        reasonCode
      } as EventPayload);
      return reportFor(terminal, quarantined ? "quarantined" : "failed", reasonCode);
    }
  }

  async #gateRecords(
    journal: FactoryExternalPullRequestRepairQualificationJournalSnapshot,
    output: FactoryGateExecutionOutput,
    attempt: number
  ) {
    const [stdout, stderr] = await Promise.all([
      this.dependencies.artifacts.putText(output.stdout),
      this.dependencies.artifacts.putText(output.stderr)
    ]);
    const observation = this.dependencies.documents.gateObservation({
      schemaVersion: "agentlab.gate-observation.v1",
      gateId: output.gateId,
      taskId: journal.run.qualificationRunId,
      contractDigest: journal.runDigest,
      baseRevision: journal.run.expectedHeadRevision,
      result: output.result,
      command: output.command,
      startedAt: output.startedAt,
      finishedAt: output.finishedAt,
      exitCode: output.exitCode,
      stdoutArtifact: artifact(stdout, "text/plain; charset=utf-8"),
      stderrArtifact: artifact(stderr, "text/plain; charset=utf-8")
    });
    const isolation = this.dependencies.documents.resourceIsolation({
      schemaVersion: "agentlab.resource-isolation-record.v1",
      taskId: journal.run.qualificationRunId,
      contractDigest: journal.runDigest,
      policyBundleDigest: journal.run.gateProfileDigest,
      subjectDigest: journal.run.repairBundleDigest,
      attempt,
      execution: { kind: "gate", gateId: output.gateId },
      isolation: output.isolation,
      result: "enforced",
      observedAt: output.finishedAt
    });
    await Promise.all([
      this.#storeDocument(observation, "application/vnd.agentlab.gate-observation+json;version=1"),
      this.#storeDocument(
        isolation,
        "application/vnd.agentlab.resource-isolation-record+json;version=1"
      )
    ]);
    return { observation, isolation };
  }

  async #runReviewer(
    journal: FactoryExternalPullRequestRepairQualificationJournalSnapshot,
    candidate: FactoryExternalPullRequestRepairQualificationCandidate,
    reviewer: ResolvedExternalPullRequestRepairQualificationReviewer,
    workspace: FactoryExternalPullRequestRepairQualificationWorkspace,
    budget: FactoryBudget
  ) {
    const prompt = renderExternalPullRequestRepairQualificationPrompt({
      repairRun: candidate.repairRun.value,
      feedbackRun: candidate.feedbackRun.value,
      policy: journal.run.qualificationPolicy,
      reviewerId: reviewer.profile.id,
      skills: reviewer.skills,
      repairedPatch: workspace.patch
    });
    if (
      new TextEncoder().encode(prompt).byteLength >
      journal.run.qualificationPolicy.maximumPromptBytes
    ) {
      throw new QualificationFailure(
        "repair-qualification-prompt-byte-ceiling-exceeded",
        null,
        false
      );
    }
    const [storedPrompt, storedSchema] = await Promise.all([
      this.dependencies.artifacts.putText(prompt),
      this.dependencies.artifacts.putText(externalPullRequestReviewOutputSchemaJson)
    ]);
    const executionId = this.dependencies.createId();
    const request = this.dependencies.documents.externalPullRequestReviewerRequest({
      schemaVersion: "agentlab.external-pull-request-reviewer-request.v1",
      executionId,
      reviewRunId: journal.run.qualificationRunId,
      taskId: journal.run.qualificationRunId,
      contractDigest: journal.runDigest,
      candidateDigest: journal.run.repairBundleDigest,
      reviewerId: reviewer.profile.id,
      role: "reviewer",
      attempt:
        journal.run.qualificationPolicy.reviewerProfiles.findIndex(
          ({ id }) => id === reviewer.profile.id
        ) + 1,
      provider: reviewer.profile.provider,
      model: reviewer.profile.model,
      reasoning: reviewer.profile.reasoning,
      repository: {
        id: journal.run.repositoryId,
        baseRevision: journal.run.expectedHeadRevision
      },
      pullRequest: {
        number: journal.run.pullRequestNumber,
        baseRevision: journal.run.expectedBaseRevision,
        headRevision: journal.run.expectedHeadRevision,
        patchDigest: journal.run.repairedPatchDigest
      },
      promptArtifact: artifact(storedPrompt, "text/plain; charset=utf-8"),
      outputSchemaDigest: storedSchema.digest,
      skillDigests: reviewer.skills.map(({ packageDigest }) => packageDigest),
      capabilities: reviewer.profile.capabilities,
      budget
    });
    await this.#storeDocument(
      request,
      "application/vnd.agentlab.external-pull-request-reviewer-request+json;version=1"
    );
    journal = await this.#append(journal, {
      kind: "reviewer-started",
      from: "reviewing",
      to: "reviewer-active",
      reviewerId: reviewer.profile.id,
      executionId,
      requestDigest: request.digest,
      reasonCode: "post-repair-independent-reviewer-started"
    });
    const provider = await this.dependencies.providers.resolve(
      reviewer.profile.provider,
      workspace.workspace.root
    );
    if (provider === null) {
      throw new QualificationFailure("qualification-review-provider-unavailable", null, false);
    }
    const output = await this.dependencies.agents.execute({
      request: request.value,
      policyBundleDigest: journal.run.qualificationPolicy.costPolicyDigest,
      executable: provider.executable,
      providerVersion: provider.version,
      workspace: workspace.workspace,
      prompt,
      resourceLimits: narrowFactoryResourceLimits(
        journal.run.qualificationPolicy.resourceLimits,
        budget.maxProcesses
      )
    });
    if (
      output.errorCode === factoryProcessCleanupUnconfirmedErrorCode ||
      output.isolation.isolationId !== executionId
    ) {
      throw new QualificationProcessOutcomeUnconfirmedError(
        "Qualification reviewer process cleanup or identity is uncertain."
      );
    }
    const record = await this.#reviewerRecord(journal, reviewer, request.digest, output);
    await this.#storeDocument(
      record,
      "application/vnd.agentlab.external-pull-request-reviewer-record+json;version=1"
    );
    if (record.value.status !== "succeeded" || !record.value.usageComplete) {
      throw new QualificationFailure(
        "qualification-independent-reviewer-run-failed",
        record.digest,
        false
      );
    }
    let decision;
    try {
      decision = factoryReviewDecisionSchema.parse(
        JSON.parse(output.finalOutput ?? "null") as unknown
      );
    } catch {
      throw new QualificationFailure(
        "qualification-independent-reviewer-output-invalid",
        record.digest,
        false
      );
    }
    const result = this.dependencies.documents.externalPullRequestReviewResult({
      ...decision,
      schemaVersion: "agentlab.external-pull-request-review-result.v1",
      reviewRunId: journal.run.qualificationRunId,
      runDigest: journal.runDigest,
      candidateDigest: journal.run.repairBundleDigest,
      patchDigest: journal.run.repairedPatchDigest,
      reviewerId: reviewer.profile.id,
      requestDigest: request.digest,
      reviewerRecordDigest: record.digest,
      executionId,
      createdAt: factoryTimestampSchema.parse(this.dependencies.now())
    });
    await this.#storeDocument(
      result,
      "application/vnd.agentlab.external-pull-request-review-result+json;version=1"
    );
    journal = await this.#append(journal, {
      kind: "reviewer-finished",
      from: "reviewer-active",
      to: "reviewing",
      reviewerId: reviewer.profile.id,
      executionId,
      requestDigest: request.digest,
      reviewerRecordDigest: record.digest,
      reviewResultDigest: result.digest,
      reasonCode: "post-repair-independent-reviewer-finished"
    });
    return { journal, record, result };
  }

  async #reviewerRecord(
    journal: FactoryExternalPullRequestRepairQualificationJournalSnapshot,
    reviewer: ResolvedExternalPullRequestRepairQualificationReviewer,
    requestDigest: Sha256Digest,
    output: Awaited<ReturnType<FactoryAgentExecutor["execute"]>>
  ): Promise<CanonicalFactoryDocument<FactoryExternalPullRequestReviewerRecord>> {
    const [stdoutArtifact, stderrArtifact, finalOutputArtifact] = await Promise.all([
      this.dependencies.artifacts.putText(output.stdout),
      this.dependencies.artifacts.putText(output.stderr),
      output.finalOutput === null
        ? Promise.resolve(null)
        : this.dependencies.artifacts.putText(output.finalOutput)
    ]);
    return this.dependencies.documents.externalPullRequestReviewerRecord({
      schemaVersion: "agentlab.external-pull-request-reviewer-record.v1",
      reviewRunId: journal.run.qualificationRunId,
      runDigest: journal.runDigest,
      requestDigest,
      executionId: output.isolation.isolationId,
      reviewerId: reviewer.profile.id,
      provider: reviewer.profile.provider,
      providerVersion: output.providerVersion,
      harnessVersion: output.harnessVersion,
      model: reviewer.profile.model,
      reasoning: reviewer.profile.reasoning,
      providerSessionId: output.providerSessionId,
      status: output.status,
      startedAt: output.startedAt,
      finishedAt: output.finishedAt,
      exitCode: output.exitCode,
      stdoutArtifact: artifact(stdoutArtifact, "application/x-ndjson"),
      stderrArtifact: artifact(stderrArtifact, "text/plain; charset=utf-8"),
      finalOutputArtifact:
        finalOutputArtifact === null
          ? null
          : artifact(finalOutputArtifact, "application/json; charset=utf-8"),
      usage: output.usage,
      usageComplete: output.usageComplete,
      errorCode: output.errorCode,
      isolation: output.isolation
    });
  }

  async #loadEvidence(
    journal: FactoryExternalPullRequestRepairQualificationJournalSnapshot,
    candidate: FactoryExternalPullRequestRepairQualificationCandidate,
    reviewers: readonly ResolvedExternalPullRequestRepairQualificationReviewer[],
    workspace: FactoryExternalPullRequestRepairQualificationWorkspace
  ): Promise<QualificationEvidence> {
    const gateObservations: FactoryGateObservation[] = [];
    const gateIsolationRecords: FactoryResourceIsolationRecord[] = [];
    const reviewerRecords: FactoryExternalPullRequestReviewerRecord[] = [];
    const reviews: FactoryExternalPullRequestReviewResult[] = [];
    const meter = new FactoryBudgetMeter();
    for (const event of journal.history) {
      if (event.kind === "gate-finished") {
        const [observationJson, isolationJson] = await Promise.all([
          this.dependencies.artifacts.readText(event.gateObservationDigest, 8 * 1_024 * 1_024),
          this.dependencies.artifacts.readText(event.isolationRecordDigest, 4 * 1_024 * 1_024)
        ]);
        const observation = this.dependencies.documents.gateObservation(parseJson(observationJson));
        const isolation = this.dependencies.documents.resourceIsolation(parseJson(isolationJson));
        if (
          observation.digest !== event.gateObservationDigest ||
          isolation.digest !== event.isolationRecordDigest ||
          observation.value.gateId !== event.gateId ||
          observation.value.taskId !== journal.run.qualificationRunId ||
          observation.value.contractDigest !== journal.runDigest ||
          observation.value.baseRevision !== journal.run.expectedHeadRevision ||
          isolation.value.taskId !== journal.run.qualificationRunId ||
          isolation.value.contractDigest !== journal.runDigest ||
          isolation.value.policyBundleDigest !== journal.run.gateProfileDigest ||
          isolation.value.subjectDigest !== journal.run.repairBundleDigest ||
          isolation.value.execution.kind !== "gate" ||
          isolation.value.execution.gateId !== event.gateId ||
          isolation.value.isolation.isolationId !== event.isolationId ||
          isolation.value.result !== "enforced"
        ) {
          throw new Error("Recovered qualification gate evidence changed its immutable lineage.");
        }
        await Promise.all([
          this.#readExactArtifact(observation.value.stdoutArtifact, 1_073_741_824),
          this.#readExactArtifact(observation.value.stderrArtifact, 1_073_741_824)
        ]);
        gateObservations.push(observation.value);
        gateIsolationRecords.push(isolation.value);
        meter.addUsage(gateUsage(observation.value), true);
      }
      if (event.kind === "reviewer-finished") {
        const [requestJson, recordJson, resultJson] = await Promise.all([
          this.dependencies.artifacts.readText(event.requestDigest, 4 * 1_024 * 1_024),
          this.dependencies.artifacts.readText(event.reviewerRecordDigest, 16 * 1_024 * 1_024),
          this.dependencies.artifacts.readText(event.reviewResultDigest, 4 * 1_024 * 1_024)
        ]);
        const request = this.dependencies.documents.externalPullRequestReviewerRequest(
          parseJson(requestJson)
        );
        const record = this.dependencies.documents.externalPullRequestReviewerRecord(
          parseJson(recordJson)
        );
        const result = this.dependencies.documents.externalPullRequestReviewResult(
          parseJson(resultJson)
        );
        const reviewer = reviewers.find(({ profile }) => profile.id === event.reviewerId);
        if (reviewer === undefined)
          throw new Error("Recovered qualification reviewer disappeared.");
        const expectedPrompt = renderExternalPullRequestRepairQualificationPrompt({
          repairRun: candidate.repairRun.value,
          feedbackRun: candidate.feedbackRun.value,
          policy: journal.run.qualificationPolicy,
          reviewerId: reviewer.profile.id,
          skills: reviewer.skills,
          repairedPatch: workspace.patch
        });
        const [storedPrompt, schema] = await Promise.all([
          this.#readExactArtifact(
            request.value.promptArtifact,
            journal.run.qualificationPolicy.maximumPromptBytes
          ),
          this.dependencies.artifacts.readText(request.value.outputSchemaDigest, 1 * 1_024 * 1_024)
        ]);
        if (
          request.digest !== event.requestDigest ||
          record.digest !== event.reviewerRecordDigest ||
          result.digest !== event.reviewResultDigest ||
          storedPrompt !== expectedPrompt ||
          schema !== externalPullRequestReviewOutputSchemaJson ||
          request.value.reviewRunId !== journal.run.qualificationRunId ||
          request.value.taskId !== journal.run.qualificationRunId ||
          request.value.contractDigest !== journal.runDigest ||
          request.value.candidateDigest !== journal.run.repairBundleDigest ||
          request.value.reviewerId !== event.reviewerId ||
          request.value.executionId !== event.executionId ||
          request.value.repository.id !== journal.run.repositoryId ||
          request.value.repository.baseRevision !== journal.run.expectedHeadRevision ||
          request.value.pullRequest.number !== journal.run.pullRequestNumber ||
          request.value.pullRequest.baseRevision !== journal.run.expectedBaseRevision ||
          request.value.pullRequest.headRevision !== journal.run.expectedHeadRevision ||
          request.value.pullRequest.patchDigest !== journal.run.repairedPatchDigest ||
          record.value.reviewRunId !== journal.run.qualificationRunId ||
          record.value.runDigest !== journal.runDigest ||
          record.value.requestDigest !== request.digest ||
          record.value.executionId !== event.executionId ||
          record.value.reviewerId !== event.reviewerId ||
          record.value.provider !== reviewer.profile.provider ||
          record.value.model !== reviewer.profile.model ||
          record.value.reasoning !== reviewer.profile.reasoning ||
          result.value.reviewRunId !== journal.run.qualificationRunId ||
          result.value.runDigest !== journal.runDigest ||
          result.value.candidateDigest !== journal.run.repairBundleDigest ||
          result.value.patchDigest !== journal.run.repairedPatchDigest ||
          result.value.reviewerRecordDigest !== record.digest ||
          result.value.requestDigest !== request.digest ||
          result.value.executionId !== event.executionId ||
          result.value.reviewerId !== event.reviewerId
        ) {
          throw new Error("Recovered qualification review evidence changed its immutable lineage.");
        }
        if (record.value.finalOutputArtifact === null) {
          throw new Error("Recovered qualification review has no final output artifact.");
        }
        await Promise.all([
          this.#readExactArtifact(record.value.stdoutArtifact, 16 * 1_024 * 1_024),
          this.#readExactArtifact(record.value.stderrArtifact, 16 * 1_024 * 1_024),
          this.#readExactArtifact(record.value.finalOutputArtifact, 4 * 1_024 * 1_024)
        ]);
        reviewerRecords.push(record.value);
        reviews.push(result.value);
        meter.addUsage(record.value.usage, record.value.usageComplete);
      }
    }
    return { gateObservations, gateIsolationRecords, reviewerRecords, reviews, meter };
  }

  async #repairerRecord(candidate: FactoryExternalPullRequestRepairQualificationCandidate) {
    const json = await this.dependencies.artifacts.readText(
      candidate.repairBundle.value.repairerRecordDigest,
      16 * 1_024 * 1_024
    );
    const record = this.dependencies.documents.externalPullRequestRepairerRecord(parseJson(json));
    if (
      record.digest !== candidate.repairBundle.value.repairerRecordDigest ||
      record.value.repairRunId !== candidate.repairRun.value.runId ||
      record.value.runDigest !== candidate.repairRun.digest ||
      record.value.executionId !== candidate.repairBundle.value.executionId ||
      record.value.repairerId !==
        candidate.repairRun.value.repairExecutionPolicy.repairerProfile.id ||
      record.value.status !== "succeeded" ||
      !record.value.usageComplete
    ) {
      throw new Error("Completed external repair record failed qualification lineage validation.");
    }
    return record;
  }

  async #assertWorkspaceUnchanged(
    workspace: FactoryExternalPullRequestRepairQualificationWorkspace,
    evidenceDigest: Sha256Digest | null
  ): Promise<void> {
    try {
      await workspace.assertUnchanged();
    } catch {
      throw new QualificationFailure(
        "repair-qualification-workspace-mutated",
        evidenceDigest,
        true
      );
    }
  }

  async #recordBundle(
    journal: FactoryExternalPullRequestRepairQualificationJournalSnapshot,
    candidate: FactoryExternalPullRequestRepairQualificationCandidate,
    evidence: QualificationEvidence,
    decision: "qualified" | "rejected" | "human-review-required"
  ): Promise<FactoryExternalPullRequestRepairQualificationRunReport> {
    const bundle = this.dependencies.documents.externalPullRequestRepairQualificationBundle({
      schemaVersion: "agentlab.external-pull-request-repair-qualification-bundle.v1",
      qualificationRunId: journal.run.qualificationRunId,
      runDigest: journal.runDigest,
      repositoryId: journal.run.repositoryId,
      pullRequestNumber: journal.run.pullRequestNumber,
      repairRunDigest: journal.run.repairRunDigest,
      repairBundleDigest: journal.run.repairBundleDigest,
      qualificationPolicyDigest: journal.run.qualificationPolicyDigest,
      gateProfileDigest: journal.run.gateProfileDigest,
      repairedPatchArtifact: candidate.repairBundle.value.patchArtifact,
      changeSet: candidate.repairBundle.value.changeSet,
      gateObservations: evidence.gateObservations,
      gateIsolationRecords: evidence.gateIsolationRecords,
      reviewerRecords: evidence.reviewerRecords,
      reviews: evidence.reviews,
      decision,
      aggregateUsage: evidence.meter.finish(candidate.repairBundle.value.changeSet, 0),
      usageComplete: true,
      workspaceUnchanged: true,
      workspaceClosed: true,
      publicationMode: "replacement-draft",
      remoteWrite: false,
      autoMerge: false,
      release: false,
      createdAt: factoryTimestampSchema.parse(this.dependencies.now())
    });
    const stored = await this.#storeDocument(
      bundle,
      "application/vnd.agentlab.external-pull-request-repair-qualification-bundle+json;version=1"
    );
    const event = this.#event(journal, {
      kind: "bundle-recorded",
      from: journal.state as "gating" | "reviewing",
      to: "recorded",
      bundleDigest: bundle.digest,
      bundleArtifact: stored,
      decision,
      reasonCode: "external-repair-qualification-evidence-recorded"
    });
    const recorded = await this.dependencies.repository.recordBundle(event, bundle);
    if (recorded === null) throw new Error("External repair qualification lost its bundle claim.");
    return this.#complete(recorded);
  }

  async #complete(
    journal: FactoryExternalPullRequestRepairQualificationJournalSnapshot
  ): Promise<FactoryExternalPullRequestRepairQualificationRunReport> {
    if (journal.state !== "recorded" || journal.bundle === null) {
      throw new Error("External repair qualification completion requires a recorded bundle.");
    }
    const completed = await this.#append(journal, {
      kind: "completed",
      from: "recorded",
      to: "completed",
      bundleDigest: qualificationBundleDigest(journal),
      decision: journal.bundle.decision,
      reasonCode: "external-repair-qualification-completed"
    });
    return reportFor(completed, "completed", null);
  }

  async #append(
    journal: FactoryExternalPullRequestRepairQualificationJournalSnapshot,
    payload: EventPayload
  ): Promise<FactoryExternalPullRequestRepairQualificationJournalSnapshot> {
    const result = await this.dependencies.repository.append(this.#event(journal, payload));
    if (result === null) throw new Error("External repair qualification lost its append claim.");
    return result;
  }

  #event(
    journal: FactoryExternalPullRequestRepairQualificationJournalSnapshot,
    payload: EventPayload
  ) {
    return this.dependencies.documents.externalPullRequestRepairQualificationEvent({
      schemaVersion: "agentlab.external-pull-request-repair-qualification-event.v1",
      eventId: this.dependencies.createId(),
      qualificationRunId: journal.run.qualificationRunId,
      runDigest: journal.runDigest,
      sequence: journal.sequence + 1,
      previousEventDigest: journal.lastEventDigest,
      actor: actor(journal.run.qualificationRunId),
      ...payload,
      occurredAt: payload.occurredAt ?? factoryTimestampSchema.parse(this.dependencies.now()),
      correlationId: journal.run.correlationId
    });
  }

  async #storeDocument<Value>(
    document: CanonicalFactoryDocument<Value>,
    mediaType: string
  ): Promise<FactoryArtifactReference> {
    const stored = await this.dependencies.artifacts.putText(document.json);
    if (
      stored.digest !== document.digest ||
      stored.sizeBytes !== new TextEncoder().encode(document.json).byteLength
    ) {
      throw new Error("External repair qualification canonical artifact changed during storage.");
    }
    return artifact(stored, mediaType);
  }

  async #readExactArtifact(reference: FactoryArtifactReference, maximumBytes: number) {
    if (reference.sizeBytes > maximumBytes) {
      throw new Error("External repair qualification artifact exceeds its evidence ceiling.");
    }
    const content = await this.dependencies.artifacts.readText(
      reference.digest,
      Math.max(1, maximumBytes)
    );
    if (new TextEncoder().encode(content).byteLength !== reference.sizeBytes) {
      throw new Error("External repair qualification artifact size changed.");
    }
    return content;
  }

  #assertPins(command: z.infer<typeof tickInputSchema>): void {
    const qualification = this.dependencies.qualificationPolicy;
    const execution = this.dependencies.repairExecutionPolicy;
    const expected = {
      expectedQualificationPolicyDigest: qualification.digest,
      expectedRepairExecutionPolicyDigest: execution.digest,
      expectedCostPolicyDigest: qualification.value.costPolicyDigest,
      expectedRoleIdentityPolicyDigest: qualification.value.roleIdentityPolicyDigest,
      expectedGateProfileDigest: qualification.value.gateProfileDigest
    };
    for (const key of Object.keys(expected) as (keyof typeof expected)[]) {
      if (command[key] !== expected[key]) {
        throw new Error("External repair qualification policy changed after operator review.");
      }
    }
  }

  #assertDeadline(
    journal: FactoryExternalPullRequestRepairQualificationJournalSnapshot,
    evidenceDigest: Sha256Digest | null
  ): void {
    if (factoryTimestampSchema.parse(this.dependencies.now()) >= journal.run.deadlineAt) {
      throw new QualificationFailure(
        "external-repair-qualification-deadline-expired",
        evidenceDigest,
        false
      );
    }
  }

  #report(
    runs: readonly FactoryExternalPullRequestRepairQualificationRunReport[],
    status: FactoryExternalPullRequestRepairQualificationTickReport["status"],
    reasonCodes: readonly string[]
  ): FactoryExternalPullRequestRepairQualificationTickReport {
    return {
      schemaVersion: "agentlab.external-pull-request-repair-qualification-tick-result.v1",
      status,
      repositoryId: this.dependencies.qualificationPolicy.value.repositoryId,
      qualificationPolicyDigest: this.dependencies.qualificationPolicy.digest,
      inspected: runs.length,
      completed: runs.filter(({ status: value }) => value === "completed").length,
      qualified: runs.filter(({ decision }) => decision === "qualified").length,
      rejected: runs.filter(({ decision }) => decision === "rejected").length,
      humanReviewRequired: runs.filter(({ decision }) => decision === "human-review-required")
        .length,
      failed: runs.filter(({ status: value }) => value === "failed").length,
      quarantined: runs.filter(({ status: value }) => value === "quarantined").length,
      reasonCodes: [...new Set(reasonCodes)].sort(),
      runs
    };
  }
}

class QualificationFailure extends Error {
  public constructor(
    public readonly reasonCode: string,
    public readonly evidenceDigest: Sha256Digest | null,
    public readonly quarantine: boolean
  ) {
    super(reasonCode);
  }
}

class QualificationProcessOutcomeUnconfirmedError extends Error {}

function actor(runId: string): FactoryActor {
  return {
    kind: "control-plane",
    id: "agentlab/external-pull-request-repair-qualification",
    role: "policy-engine",
    sessionId: runId
  };
}

function artifact(
  stored: { readonly digest: Sha256Digest; readonly sizeBytes: number },
  mediaType: string
): FactoryArtifactReference {
  return { ...stored, mediaType };
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch (error: unknown) {
    throw new Error("External repair qualification artifact is invalid JSON.", { cause: error });
  }
}

function gateUsage(observation: FactoryGateObservation): FactoryBudgetUsage {
  const seconds = factoryTimestampDifferenceSeconds(observation.startedAt, observation.finishedAt);
  return {
    wallClockSeconds: Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : 0,
    agentTurns: 0,
    toolCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    costMicrousd: 0,
    processes: 1,
    outputBytes: observation.stdoutArtifact.sizeBytes + observation.stderrArtifact.sizeBytes,
    workers: 0,
    repairAttempts: 0,
    changedFiles: 0,
    changedLines: 0
  };
}

function qualificationBundleDigest(
  journal: FactoryExternalPullRequestRepairQualificationJournalSnapshot
): Sha256Digest {
  const event = [...journal.history].reverse().find(({ kind }) => kind === "bundle-recorded");
  if (event?.kind !== "bundle-recorded") {
    throw new Error("External repair qualification has no bundle event.");
  }
  return event.bundleDigest;
}

function reportFor(
  journal: FactoryExternalPullRequestRepairQualificationJournalSnapshot,
  status: FactoryExternalPullRequestRepairQualificationRunReport["status"],
  reasonCode: string | null
): FactoryExternalPullRequestRepairQualificationRunReport {
  const event = [...journal.history].reverse().find(({ kind }) => kind === "bundle-recorded");
  return {
    qualificationRunId: journal.run.qualificationRunId,
    runDigest: journal.runDigest,
    repairBundleDigest: journal.run.repairBundleDigest,
    pullRequestNumber: journal.run.pullRequestNumber,
    status,
    decision: journal.bundle?.decision ?? null,
    qualificationBundleDigest: event?.kind === "bundle-recorded" ? event.bundleDigest : null,
    reasonCode
  };
}

function isActiveState(
  state: FactoryExternalPullRequestRepairQualificationJournalSnapshot["state"]
): state is
  "ready" | "workspace-active" | "gating" | "gate-active" | "reviewing" | "reviewer-active" {
  return [
    "ready",
    "workspace-active",
    "gating",
    "gate-active",
    "reviewing",
    "reviewer-active"
  ].includes(state);
}
