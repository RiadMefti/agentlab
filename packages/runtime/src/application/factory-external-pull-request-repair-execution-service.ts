import {
  factoryTimestampSchema,
  sha256DigestSchema,
  type FactoryActor,
  type FactoryArtifactReference,
  type FactoryBudgetUsage,
  type FactoryExternalPullRequestRepairAdmissionPolicy,
  type FactoryExternalPullRequestRepairExecutionEvent,
  type FactoryExternalPullRequestRepairExecutionPolicy,
  type FactoryExternalPullRequestRepairerRecord,
  type Sha256Digest
} from "@agentlab/contracts";
import { z } from "zod";

import {
  factoryProcessCleanupUnconfirmedErrorCode,
  type FactoryAgentExecutor,
  type FactoryAgentProviderResolver
} from "../domain/factory-agent-executor.js";
import type { FactoryArtifactStore } from "../domain/factory-artifact-store.js";
import { factoryUsageFits } from "../domain/factory-authority-limits.js";
import type {
  FactoryExternalPullRequestRepairExecutionCandidate,
  FactoryExternalPullRequestRepairExecutionJournalSnapshot,
  FactoryExternalPullRequestRepairExecutionRepository
} from "../domain/factory-external-pull-request-repair-execution-repository.js";
import {
  resolveExternalPullRequestRepairer,
  type ResolvedExternalPullRequestRepairer
} from "../domain/factory-external-pull-request-repair-execution-policy.js";
import {
  FactoryExternalPullRequestRepairWorkspaceCleanupUnconfirmedError,
  type FactoryExternalPullRequestRepairWorkspaceManager
} from "../domain/factory-external-pull-request-repair-workspace.js";
import type {
  CanonicalFactoryDocument,
  FactoryDocumentCodec
} from "../domain/factory-documents.js";
import { narrowFactoryResourceLimits } from "../domain/factory-process-isolation.js";
import { repositoryPathMatches } from "../domain/repository-path-policy.js";
import type { FactorySkillSource } from "../domain/factory-skill.js";
import type { FactoryControlRepository } from "../domain/factory-task-repository.js";
import { factoryTimestampAddSeconds } from "../domain/factory-timestamp.js";
import type { FactoryWorkspaceRecoveryReconciler } from "../domain/factory-workspace-recovery.js";
import { renderExternalPullRequestRepairPrompt } from "./factory-external-pull-request-repair-prompt.js";

const tickInputSchema = z
  .object({
    expectedRepairExecutionPolicyDigest: sha256DigestSchema,
    expectedAdmissionPolicyDigest: sha256DigestSchema,
    expectedReviewPolicyDigest: sha256DigestSchema,
    expectedFeedbackPolicyDigest: sha256DigestSchema,
    expectedCostPolicyDigest: sha256DigestSchema,
    expectedRoleIdentityPolicyDigest: sha256DigestSchema,
    expectedGateProfileDigest: sha256DigestSchema
  })
  .strict();

export interface FactoryExternalPullRequestRepairExecutionPreflight {
  readonly schemaVersion: "agentlab.external-pull-request-repair-execution-preflight.v1";
  readonly status: "ready" | "blocked";
  readonly repositoryId: string;
  readonly repairExecutionPolicyDigest: Sha256Digest;
  readonly admissionPolicyDigest: Sha256Digest;
  readonly costPolicyDigest: Sha256Digest;
  readonly roleIdentityPolicyDigest: Sha256Digest;
  readonly gateProfileDigest: Sha256Digest;
  readonly provider: string;
  readonly schedulerEnabled: boolean;
  readonly repairAttempts: 1;
  readonly remoteWrite: false;
  readonly autoMerge: false;
  readonly release: false;
  readonly reasonCodes: readonly string[];
}

export interface FactoryExternalPullRequestRepairExecutionTickReport {
  readonly schemaVersion: "agentlab.external-pull-request-repair-execution-tick-result.v1";
  readonly status: "completed" | "idle" | "partial" | "blocked";
  readonly repositoryId: string;
  readonly repairExecutionPolicyDigest: Sha256Digest;
  readonly inspected: number;
  readonly completed: number;
  readonly failed: number;
  readonly quarantined: number;
  readonly reasonCodes: readonly string[];
  readonly runs: readonly FactoryExternalPullRequestRepairExecutionRunReport[];
}

export interface FactoryExternalPullRequestRepairExecutionRunReport {
  readonly runId: string;
  readonly runDigest: Sha256Digest;
  readonly authorizationDigest: Sha256Digest;
  readonly pullRequestNumber: number;
  readonly status: "completed" | "failed" | "quarantined" | "blocked";
  readonly bundleDigest: Sha256Digest | null;
  readonly patchDigest: Sha256Digest | null;
  readonly reasonCode: string | null;
}

export interface FactoryExternalPullRequestRepairExecutionServiceDependencies {
  readonly repositoryRoot: string;
  readonly admissionPolicy: CanonicalFactoryDocument<FactoryExternalPullRequestRepairAdmissionPolicy>;
  readonly executionPolicy: CanonicalFactoryDocument<FactoryExternalPullRequestRepairExecutionPolicy>;
  readonly repository: FactoryExternalPullRequestRepairExecutionRepository;
  readonly controls: Pick<FactoryControlRepository, "state">;
  readonly artifacts: FactoryArtifactStore;
  readonly documents: FactoryDocumentCodec;
  readonly skills: FactorySkillSource;
  readonly workspaces: FactoryExternalPullRequestRepairWorkspaceManager;
  readonly recovery: FactoryWorkspaceRecoveryReconciler;
  readonly agents: FactoryAgentExecutor;
  readonly providers: FactoryAgentProviderResolver;
  readonly now: () => string;
  readonly createId: () => string;
}

type EventPayload<
  Event extends FactoryExternalPullRequestRepairExecutionEvent =
    FactoryExternalPullRequestRepairExecutionEvent
> = Event extends FactoryExternalPullRequestRepairExecutionEvent
  ? Omit<
      Event,
      | "schemaVersion"
      | "eventId"
      | "repairRunId"
      | "runDigest"
      | "sequence"
      | "previousEventDigest"
      | "actor"
      | "occurredAt"
      | "correlationId"
    > & { readonly occurredAt?: string }
  : never;

/** Executes one admitted repair in an isolated worktree and emits no remote capability. */
export class FactoryExternalPullRequestRepairExecutionService {
  public constructor(
    private readonly dependencies: FactoryExternalPullRequestRepairExecutionServiceDependencies
  ) {}

  public async preflight(): Promise<FactoryExternalPullRequestRepairExecutionPreflight> {
    const repairer = await this.#resolveRepairer();
    const [profileReasons, controls] = await Promise.all([
      this.#profileReasonCodes(repairer),
      this.dependencies.controls.state()
    ]);
    const reasonCodes = [
      ...profileReasons,
      ...(controls.scheduler ? [] : ["scheduler-disabled"])
    ].toSorted();
    const policy = this.dependencies.executionPolicy;
    return {
      schemaVersion: "agentlab.external-pull-request-repair-execution-preflight.v1",
      status: reasonCodes.length === 0 ? "ready" : "blocked",
      repositoryId: policy.value.repositoryId,
      repairExecutionPolicyDigest: policy.digest,
      admissionPolicyDigest: this.dependencies.admissionPolicy.digest,
      costPolicyDigest: policy.value.costPolicyDigest,
      roleIdentityPolicyDigest: policy.value.roleIdentityPolicyDigest,
      gateProfileDigest: policy.value.gateProfileDigest,
      provider: repairer.profile.provider,
      schedulerEnabled: controls.scheduler,
      repairAttempts: 1,
      remoteWrite: false,
      autoMerge: false,
      release: false,
      reasonCodes
    };
  }

  public async tick(input: unknown): Promise<FactoryExternalPullRequestRepairExecutionTickReport> {
    const command = tickInputSchema.parse(input);
    this.#assertPins(command);
    const repairer = await this.#resolveRepairer();
    const [profileReasons, controls] = await Promise.all([
      this.#profileReasonCodes(repairer),
      this.dependencies.controls.state()
    ]);
    const executionBlockers = [
      ...profileReasons,
      ...(controls.scheduler ? [] : ["scheduler-disabled"])
    ].toSorted();

    const policy = this.dependencies.executionPolicy;
    const active = await this.dependencies.repository.listActive({
      repositoryId: policy.value.repositoryId,
      repairExecutionPolicyDigest: policy.digest,
      limit: policy.value.maximumCandidatesPerTick
    });
    const reports: FactoryExternalPullRequestRepairExecutionRunReport[] = [];
    let schedulingStopped = false;
    for (const journal of active) {
      reports.push(await this.#resume(journal, repairer, executionBlockers));
    }

    const remaining = policy.value.maximumCandidatesPerTick - reports.length;
    const activeBlocked = reports.some(({ status }) => status === "blocked");
    if (remaining > 0 && executionBlockers.length === 0 && !activeBlocked) {
      const candidates = await this.dependencies.repository.listAdmitted({
        repositoryId: policy.value.repositoryId,
        admissionPolicyDigest: this.dependencies.admissionPolicy.digest,
        repairExecutionPolicyDigest: policy.digest,
        limit: remaining
      });
      for (const candidate of candidates) {
        if (!(await this.dependencies.controls.state()).scheduler) {
          schedulingStopped = true;
          break;
        }
        const journal = await this.#register(candidate);
        reports.push(await this.#execute(journal, candidate, repairer));
      }
    }
    if (reports.length === 0) {
      const idleBlockers = schedulingStopped
        ? [...executionBlockers, "scheduler-disabled-during-external-repair-tick"]
        : executionBlockers;
      return this.#report([], idleBlockers.length === 0 ? "idle" : "blocked", idleBlockers);
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
        ...(schedulingStopped ? ["scheduler-disabled-during-external-repair-tick"] : [])
      ]
    );
  }

  async #resolveRepairer(): Promise<ResolvedExternalPullRequestRepairer> {
    return resolveExternalPullRequestRepairer(
      this.dependencies.skills,
      this.dependencies.executionPolicy.value
    );
  }

  async #profileReasonCodes(
    repairer: ResolvedExternalPullRequestRepairer
  ): Promise<readonly string[]> {
    const capability = this.dependencies.agents
      .capabilities()
      .find(({ provider }) => provider === repairer.profile.provider);
    if (
      !capability?.roles.includes("repairer") ||
      capability.maximumToolFilesystemAccess !== "workspace-write"
    ) {
      return ["repairer-capability-unavailable"];
    }
    try {
      this.dependencies.agents.preflight({
        provider: repairer.profile.provider,
        model: repairer.profile.model,
        policyBundleDigest: this.dependencies.executionPolicy.value.costPolicyDigest
      });
      const provider = await this.dependencies.providers.resolve(
        repairer.profile.provider,
        this.dependencies.repositoryRoot
      );
      return provider === null ? ["repairer-provider-unavailable"] : [];
    } catch {
      return ["repairer-provider-unavailable"];
    }
  }

  async #register(
    candidate: FactoryExternalPullRequestRepairExecutionCandidate
  ): Promise<FactoryExternalPullRequestRepairExecutionJournalSnapshot> {
    const createdAt = factoryTimestampSchema.parse(this.dependencies.now());
    const authorization = candidate.authorization.value;
    const policy = this.dependencies.executionPolicy;
    const run = this.dependencies.documents.externalPullRequestRepairExecutionRun({
      schemaVersion: "agentlab.external-pull-request-repair-execution-run.v1",
      runId: this.dependencies.createId(),
      repositoryId: authorization.repositoryId,
      pullRequestNumber: authorization.pullRequestNumber,
      authorizationId: authorization.authorizationId,
      authorizationDigest: candidate.authorization.digest,
      admissionDecisionDigest: candidate.decision.digest,
      feedbackPublicationRunDigest: candidate.feedbackRun.digest,
      feedbackRecordDigest: candidate.feedbackRecord.digest,
      reviewRunDigest: authorization.reviewRunDigest,
      reviewBundleDigest: authorization.bundleDigest,
      admissionPolicyDigest: this.dependencies.admissionPolicy.digest,
      repairExecutionPolicyDigest: policy.digest,
      repairExecutionPolicy: policy.value,
      expectedBaseRevision: authorization.expectedBaseRevision,
      expectedHeadRevision: authorization.expectedHeadRevision,
      originalPatchDigest: authorization.patchDigest,
      selectedFindings: authorization.selectedFindings,
      repairAttempt: 1,
      workspaceId: this.dependencies.createId(),
      createdAt,
      deadlineAt: factoryTimestampAddSeconds(createdAt, policy.value.operationDeadlineSeconds),
      correlationId: this.dependencies.createId()
    });
    const event = this.dependencies.documents.externalPullRequestRepairExecutionEvent({
      schemaVersion: "agentlab.external-pull-request-repair-execution-event.v1",
      eventId: this.dependencies.createId(),
      repairRunId: run.value.runId,
      runDigest: run.digest,
      sequence: 1,
      previousEventDigest: null,
      actor: actor(run.value.runId),
      kind: "registered",
      from: null,
      to: "ready",
      occurredAt: createdAt,
      reasonCode: "external-repair-authorization-consumed",
      correlationId: run.value.correlationId
    });
    return this.dependencies.repository.register(
      this.dependencies.admissionPolicy,
      policy,
      run,
      event,
      candidate
    );
  }

  async #resume(
    journal: FactoryExternalPullRequestRepairExecutionJournalSnapshot,
    repairer: ResolvedExternalPullRequestRepairer,
    executionBlockers: readonly string[]
  ): Promise<FactoryExternalPullRequestRepairExecutionRunReport> {
    if (journal.state === "recorded") return this.#complete(journal);
    if (journal.state === "ready") {
      const blocker = executionBlockers[0];
      if (blocker !== undefined) return reportFor(journal, "blocked", blocker);
      return this.#execute(journal, await this.#candidateFor(journal), repairer);
    }
    const result = await this.dependencies.recovery.reconcile({
      taskId: journal.run.runId,
      workspaceId: journal.run.workspaceId,
      attempt: 1,
      repositoryRoot: this.dependencies.repositoryRoot,
      baseRevision: journal.run.expectedHeadRevision,
      processExecutionIds: journal.history.flatMap((event) =>
        event.kind === "repairer-started" ? [event.executionId] : []
      )
    });
    if (result.status !== "inactive") return reportFor(journal, "blocked", result.reasonCode);
    if (journal.state === "repairer-active") {
      const quarantined = await this.#append(journal, {
        kind: "quarantined",
        from: "repairer-active",
        to: "quarantined",
        repairerRecordDigest: null,
        reasonCode: "repairer-outcome-unrecoverable"
      });
      return reportFor(quarantined, "quarantined", "repairer-outcome-unrecoverable");
    }
    const recoveryAttempts = journal.history.filter(({ kind }) => kind === "recovered").length;
    if (recoveryAttempts >= journal.run.repairExecutionPolicy.maximumRecoveryAttempts) {
      const failed = await this.#append(journal, {
        kind: "failed",
        from: journal.state as "workspace-active" | "prepared",
        to: "failed",
        repairerRecordDigest: null,
        reasonCode: "external-repair-recovery-exhausted"
      });
      return reportFor(failed, "failed", "external-repair-recovery-exhausted");
    }
    const recovered = await this.#append(journal, {
      kind: "recovered",
      from: journal.state as "workspace-active" | "prepared",
      to: "ready",
      reasonCode: "inactive-repair-workspace-recovered"
    });
    const blocker = executionBlockers[0];
    if (blocker !== undefined) return reportFor(recovered, "blocked", blocker);
    return this.#execute(recovered, await this.#candidateFor(recovered), repairer);
  }

  async #candidateFor(
    journal: FactoryExternalPullRequestRepairExecutionJournalSnapshot
  ): Promise<FactoryExternalPullRequestRepairExecutionCandidate> {
    const candidate = await this.dependencies.repository.findCandidateByAuthorization(
      journal.run.authorizationDigest
    );
    if (candidate === null) {
      throw new Error("Active external repair execution lost its admitted evidence projection.");
    }
    return candidate;
  }

  async #execute(
    initial: FactoryExternalPullRequestRepairExecutionJournalSnapshot,
    candidate: FactoryExternalPullRequestRepairExecutionCandidate,
    repairer: ResolvedExternalPullRequestRepairer
  ): Promise<FactoryExternalPullRequestRepairExecutionRunReport> {
    let journal = initial;
    let workspace: Awaited<
      ReturnType<FactoryExternalPullRequestRepairWorkspaceManager["prepare"]>
    > | null = null;
    let recordDigest: Sha256Digest | null = null;
    try {
      this.#assertDeadline(journal);
      journal = await this.#append(journal, {
        kind: "workspace-started",
        from: "ready",
        to: "workspace-active",
        reasonCode: "exact-external-pr-head-workspace-started"
      });
      workspace = await this.dependencies.workspaces.prepare({
        repairRunId: journal.run.runId,
        workspaceId: journal.run.workspaceId,
        repositoryRoot: this.dependencies.repositoryRoot,
        candidate: candidate.feedbackRun.value.reviewRun.candidate,
        expectedPatchDigest: journal.run.originalPatchDigest,
        maximumPatchBytes: journal.run.repairExecutionPolicy.maximumPatchBytes
      });
      journal = await this.#append(journal, {
        kind: "workspace-prepared",
        from: "workspace-active",
        to: "prepared",
        sourcePatchDigest: workspace.sourcePatchDigest,
        sourcePatchArtifact: workspace.sourcePatchArtifact,
        reasonCode: "exact-reviewed-patch-and-head-materialized"
      });
      this.#assertDeadline(journal);
      if (!(await this.dependencies.controls.state()).scheduler) {
        throw new RepairFailure("scheduler-disabled-before-external-repair", null, false);
      }
      const prompt = renderExternalPullRequestRepairPrompt({
        candidate: candidate.feedbackRun.value.reviewRun.candidate,
        reviewBundle: candidate.feedbackRun.value.bundle,
        selectedFindings: journal.run.selectedFindings,
        policy: journal.run.repairExecutionPolicy,
        skills: repairer.skills
      });
      const promptBytes = new TextEncoder().encode(prompt).byteLength;
      if (promptBytes > journal.run.repairExecutionPolicy.maximumPromptBytes) {
        throw new RepairFailure("external-repair-prompt-byte-ceiling-exceeded", null, false);
      }
      const storedPrompt = await this.dependencies.artifacts.putText(prompt);
      const executionId = this.dependencies.createId();
      const request = this.dependencies.documents.externalPullRequestRepairerRequest({
        schemaVersion: "agentlab.external-pull-request-repairer-request.v1",
        executionId,
        repairRunId: journal.run.runId,
        taskId: journal.run.runId,
        contractDigest: journal.runDigest,
        authorizationDigest: journal.run.authorizationDigest,
        feedbackPublicationRunDigest: journal.run.feedbackPublicationRunDigest,
        feedbackRecordDigest: journal.run.feedbackRecordDigest,
        selectedFindings: journal.run.selectedFindings,
        repairerId: repairer.profile.id,
        role: "repairer",
        attempt: 1,
        provider: repairer.profile.provider,
        model: repairer.profile.model,
        reasoning: repairer.profile.reasoning,
        repository: {
          id: journal.run.repositoryId,
          baseRevision: journal.run.expectedHeadRevision
        },
        pullRequest: {
          number: journal.run.pullRequestNumber,
          originalBaseRevision: journal.run.expectedBaseRevision,
          headRevision: journal.run.expectedHeadRevision,
          originalPatchDigest: journal.run.originalPatchDigest
        },
        promptArtifact: artifact(storedPrompt, "text/plain; charset=utf-8"),
        skillDigests: repairer.skills.map(({ packageDigest }) => packageDigest),
        capabilities: repairer.profile.capabilities,
        budget: repairer.profile.budget
      });
      await this.#storeDocument(
        request,
        "application/vnd.agentlab.external-pull-request-repairer-request+json;version=1"
      );
      journal = await this.#append(journal, {
        kind: "repairer-started",
        from: "prepared",
        to: "repairer-active",
        repairerId: repairer.profile.id,
        executionId,
        requestDigest: request.digest,
        reasonCode: "credentialless-external-repairer-started"
      });
      const provider = await this.dependencies.providers.resolve(
        repairer.profile.provider,
        workspace.workspace.root
      );
      if (provider === null) {
        throw new RepairFailure("external-repair-provider-unavailable", null, true);
      }
      const output = await this.dependencies.agents.execute({
        request: request.value,
        policyBundleDigest: journal.run.repairExecutionPolicy.costPolicyDigest,
        executable: provider.executable,
        providerVersion: provider.version,
        workspace: workspace.workspace,
        prompt,
        resourceLimits: narrowFactoryResourceLimits(
          journal.run.repairExecutionPolicy.resourceLimits,
          repairer.profile.budget.maxProcesses
        )
      });
      if (
        output.errorCode === factoryProcessCleanupUnconfirmedErrorCode ||
        output.isolation.isolationId !== executionId
      ) {
        throw new RepairFailure("external-repair-process-cleanup-uncertain", null, true);
      }
      const record = await this.#repairerRecord(journal, repairer, request.digest, output);
      recordDigest = record.digest;
      await this.#storeDocument(
        record,
        "application/vnd.agentlab.external-pull-request-repairer-record+json;version=1"
      );
      if (record.value.status !== "succeeded" || !record.value.usageComplete) {
        throw new RepairFailure("external-repairer-run-failed", record.digest, false);
      }
      this.#assertDeadline(journal);
      const collected = await this.dependencies.workspaces.collect(workspace.workspace, {
        maximumChangedFiles: journal.run.repairExecutionPolicy.maximumChangedFiles,
        maximumChangedLines: journal.run.repairExecutionPolicy.maximumChangedLines,
        maximumPatchBytes: journal.run.repairExecutionPolicy.maximumPatchBytes
      });
      if (collected.changeSet.changedFiles < 1 || collected.patch.length < 1) {
        throw new RepairFailure("external-repair-produced-no-patch", record.digest, false);
      }
      if (
        collected.changeSet.changedPaths.some((path) =>
          journal.run.repairExecutionPolicy.protectedPaths.some((pattern) =>
            repositoryPathMatches(path, pattern)
          )
        )
      ) {
        throw new RepairFailure("external-repair-touched-protected-path", record.digest, true);
      }
      const usage: FactoryBudgetUsage = {
        ...record.value.usage,
        repairAttempts: 1,
        changedFiles: collected.changeSet.changedFiles,
        changedLines: collected.changeSet.changedLines
      };
      if (!factoryUsageFits(usage, repairer.profile.budget)) {
        throw new RepairFailure("external-repair-budget-exhausted", record.digest, false);
      }
      const storedPatch = await this.dependencies.artifacts.putText(collected.patch);
      await workspace.close();
      workspace = null;
      const bundle = this.dependencies.documents.externalPullRequestRepairBundle({
        schemaVersion: "agentlab.external-pull-request-repair-bundle.v1",
        repairRunId: journal.run.runId,
        runDigest: journal.runDigest,
        repositoryId: journal.run.repositoryId,
        pullRequestNumber: journal.run.pullRequestNumber,
        authorizationDigest: journal.run.authorizationDigest,
        repairExecutionPolicyDigest: journal.run.repairExecutionPolicyDigest,
        expectedHeadRevision: journal.run.expectedHeadRevision,
        originalPatchDigest: journal.run.originalPatchDigest,
        repairerRequestDigest: request.digest,
        repairerRecordDigest: record.digest,
        executionId,
        patchArtifact: artifact(storedPatch, "application/vnd.git.patch"),
        changeSet: collected.changeSet,
        usage,
        usageComplete: true,
        repairAttempt: 1,
        publicationMode: "replacement-draft",
        remoteWrite: false,
        autoMerge: false,
        release: false,
        workspaceClosed: true,
        createdAt: factoryTimestampSchema.parse(this.dependencies.now())
      });
      const storedBundle = await this.#storeDocument(
        bundle,
        "application/vnd.agentlab.external-pull-request-repair-bundle+json;version=1"
      );
      const event = this.#event(journal, {
        kind: "bundle-recorded",
        from: "repairer-active",
        to: "recorded",
        repairerId: repairer.profile.id,
        executionId,
        requestDigest: request.digest,
        repairerRecordDigest: record.digest,
        bundleDigest: bundle.digest,
        bundleArtifact: storedBundle,
        reasonCode: "credentialless-external-repair-bundle-recorded"
      });
      const recorded = await this.dependencies.repository.recordBundle(event, bundle);
      if (recorded === null) throw new Error("External repair lost its bundle claim.");
      return await this.#complete(recorded);
    } catch (error: unknown) {
      if (workspace !== null) {
        try {
          await workspace.close();
        } catch (cleanupError: unknown) {
          throw new AggregateError(
            [error, cleanupError],
            "External repair and workspace cleanup both failed.",
            { cause: error }
          );
        }
      }
      if (error instanceof FactoryExternalPullRequestRepairWorkspaceCleanupUnconfirmedError) {
        throw error;
      }
      const current = await this.dependencies.repository.findByAuthorization(
        journal.run.authorizationDigest,
        journal.run.repairExecutionPolicyDigest
      );
      if (current?.state === "recorded") {
        return reportFor(current, "blocked", "external-repair-completion-pending");
      }
      if (current === null || !isExecutionState(current.state)) throw error;
      const reasonCode =
        error instanceof RepairFailure ? error.reasonCode : "external-repair-execution-failed";
      const quarantine =
        error instanceof RepairFailure ? error.quarantine : current.state === "repairer-active";
      const terminal = await this.#append(current, {
        kind: quarantine ? "quarantined" : "failed",
        from: current.state,
        to: quarantine ? "quarantined" : "failed",
        repairerRecordDigest: error instanceof RepairFailure ? error.recordDigest : recordDigest,
        reasonCode
      } as EventPayload);
      return reportFor(terminal, quarantine ? "quarantined" : "failed", reasonCode);
    }
  }

  async #repairerRecord(
    journal: FactoryExternalPullRequestRepairExecutionJournalSnapshot,
    repairer: ResolvedExternalPullRequestRepairer,
    requestDigest: Sha256Digest,
    output: Awaited<ReturnType<FactoryAgentExecutor["execute"]>>
  ): Promise<CanonicalFactoryDocument<FactoryExternalPullRequestRepairerRecord>> {
    const [stdoutArtifact, stderrArtifact, finalOutputArtifact] = await Promise.all([
      this.dependencies.artifacts.putText(output.stdout),
      this.dependencies.artifacts.putText(output.stderr),
      output.finalOutput === null
        ? Promise.resolve(null)
        : this.dependencies.artifacts.putText(output.finalOutput)
    ]);
    return this.dependencies.documents.externalPullRequestRepairerRecord({
      schemaVersion: "agentlab.external-pull-request-repairer-record.v1",
      repairRunId: journal.run.runId,
      runDigest: journal.runDigest,
      requestDigest,
      executionId: output.isolation.isolationId,
      repairerId: repairer.profile.id,
      provider: repairer.profile.provider,
      providerVersion: output.providerVersion,
      harnessVersion: output.harnessVersion,
      model: repairer.profile.model,
      reasoning: repairer.profile.reasoning,
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
          : artifact(finalOutputArtifact, "text/plain; charset=utf-8"),
      usage: output.usage,
      usageComplete: output.usageComplete,
      errorCode: output.errorCode,
      isolation: output.isolation
    });
  }

  async #complete(
    journal: FactoryExternalPullRequestRepairExecutionJournalSnapshot
  ): Promise<FactoryExternalPullRequestRepairExecutionRunReport> {
    if (journal.state !== "recorded" || journal.bundle === null) {
      throw new Error("External repair completion requires a recorded bundle.");
    }
    const completed = await this.#append(journal, {
      kind: "completed",
      from: "recorded",
      to: "completed",
      bundleDigest: bundleDigest(journal),
      reasonCode: "credentialless-external-repair-completed"
    });
    return reportFor(completed, "completed", null);
  }

  async #append(
    journal: FactoryExternalPullRequestRepairExecutionJournalSnapshot,
    payload: EventPayload
  ): Promise<FactoryExternalPullRequestRepairExecutionJournalSnapshot> {
    const result = await this.dependencies.repository.append(this.#event(journal, payload));
    if (result === null) throw new Error("External repair lost its journal append claim.");
    return result;
  }

  #event(journal: FactoryExternalPullRequestRepairExecutionJournalSnapshot, payload: EventPayload) {
    return this.dependencies.documents.externalPullRequestRepairExecutionEvent({
      schemaVersion: "agentlab.external-pull-request-repair-execution-event.v1",
      eventId: this.dependencies.createId(),
      repairRunId: journal.run.runId,
      runDigest: journal.runDigest,
      sequence: journal.sequence + 1,
      previousEventDigest: journal.lastEventDigest,
      actor: actor(journal.run.runId),
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
      throw new Error("External repair canonical artifact changed during publication.");
    }
    return artifact(stored, mediaType);
  }

  #assertPins(command: z.infer<typeof tickInputSchema>): void {
    const execution = this.dependencies.executionPolicy;
    const admission = this.dependencies.admissionPolicy;
    const expected = {
      expectedRepairExecutionPolicyDigest: execution.digest,
      expectedAdmissionPolicyDigest: admission.digest,
      expectedReviewPolicyDigest: admission.value.reviewPolicyDigest,
      expectedFeedbackPolicyDigest: admission.value.feedbackPolicyDigest,
      expectedCostPolicyDigest: execution.value.costPolicyDigest,
      expectedRoleIdentityPolicyDigest: execution.value.roleIdentityPolicyDigest,
      expectedGateProfileDigest: execution.value.gateProfileDigest
    };
    for (const key of Object.keys(expected) as (keyof typeof expected)[]) {
      if (command[key] !== expected[key]) {
        throw new Error("External repair execution policy changed after operator review.");
      }
    }
  }

  #assertDeadline(journal: FactoryExternalPullRequestRepairExecutionJournalSnapshot): void {
    if (factoryTimestampSchema.parse(this.dependencies.now()) > journal.run.deadlineAt) {
      throw new RepairFailure("external-repair-deadline-expired", null, false);
    }
  }

  #report(
    runs: readonly FactoryExternalPullRequestRepairExecutionRunReport[],
    status: FactoryExternalPullRequestRepairExecutionTickReport["status"],
    reasonCodes: readonly string[]
  ): FactoryExternalPullRequestRepairExecutionTickReport {
    return {
      schemaVersion: "agentlab.external-pull-request-repair-execution-tick-result.v1",
      status,
      repositoryId: this.dependencies.executionPolicy.value.repositoryId,
      repairExecutionPolicyDigest: this.dependencies.executionPolicy.digest,
      inspected: runs.length,
      completed: runs.filter(({ status: value }) => value === "completed").length,
      failed: runs.filter(({ status: value }) => value === "failed").length,
      quarantined: runs.filter(({ status: value }) => value === "quarantined").length,
      reasonCodes: [...new Set(reasonCodes)].sort(),
      runs
    };
  }
}

class RepairFailure extends Error {
  public constructor(
    public readonly reasonCode: string,
    public readonly recordDigest: Sha256Digest | null,
    public readonly quarantine: boolean
  ) {
    super(reasonCode);
  }
}

function actor(runId: string): FactoryActor {
  return {
    kind: "control-plane",
    id: "agentlab/external-pull-request-repair-execution",
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

function bundleDigest(journal: FactoryExternalPullRequestRepairExecutionJournalSnapshot) {
  const event = [...journal.history].reverse().find(({ kind }) => kind === "bundle-recorded");
  if (event?.kind !== "bundle-recorded") throw new Error("External repair has no bundle event.");
  return event.bundleDigest;
}

function reportFor(
  journal: FactoryExternalPullRequestRepairExecutionJournalSnapshot,
  status: FactoryExternalPullRequestRepairExecutionRunReport["status"],
  reasonCode: string | null
): FactoryExternalPullRequestRepairExecutionRunReport {
  const event = [...journal.history].reverse().find(({ kind }) => kind === "bundle-recorded");
  return {
    runId: journal.run.runId,
    runDigest: journal.runDigest,
    authorizationDigest: journal.run.authorizationDigest,
    pullRequestNumber: journal.run.pullRequestNumber,
    status,
    bundleDigest: event?.kind === "bundle-recorded" ? event.bundleDigest : null,
    patchDigest: journal.bundle?.patchArtifact.digest ?? null,
    reasonCode
  };
}

function isExecutionState(
  state: FactoryExternalPullRequestRepairExecutionJournalSnapshot["state"]
): state is "ready" | "workspace-active" | "prepared" | "repairer-active" {
  return ["ready", "workspace-active", "prepared", "repairer-active"].includes(state);
}
