import {
  factoryReviewDecisionSchema,
  factoryTimestampSchema,
  sha256DigestSchema,
  type FactoryActor,
  type FactoryArtifactReference,
  type FactoryExternalPullRequestReviewEvent,
  type FactoryExternalPullRequestCandidate,
  type FactoryExternalPullRequestReviewerRecord,
  type FactoryExternalPullRequestReviewerRequest,
  type FactoryExternalPullRequestReviewPolicy,
  type FactoryExternalPullRequestReviewResult,
  type FactoryBudget,
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
import {
  resolveExternalPullRequestReviewers,
  type ResolvedExternalPullRequestReviewer
} from "../domain/factory-external-pull-request-review-policy.js";
import type {
  FactoryExternalPullRequestReviewCandidateEnvelope,
  FactoryExternalPullRequestReviewJournalSnapshot,
  FactoryExternalPullRequestReviewRepository
} from "../domain/factory-external-pull-request-review-repository.js";
import type { FactoryExternalPullRequestReviewWorkspaceManager } from "../domain/factory-external-pull-request-review-workspace.js";
import type {
  CanonicalFactoryDocument,
  FactoryDocumentCodec
} from "../domain/factory-documents.js";
import { narrowFactoryResourceLimits } from "../domain/factory-process-isolation.js";
import type { FactorySkillSource } from "../domain/factory-skill.js";
import { factoryTimestampAddSeconds } from "../domain/factory-timestamp.js";
import type { FactoryWorkspaceRecoveryReconciler } from "../domain/factory-workspace-recovery.js";
import {
  externalPullRequestReviewOutputSchemaJson,
  renderExternalPullRequestReviewPrompt
} from "./factory-external-pull-request-review-prompt.js";

const tickInputSchema = z
  .object({
    expectedReviewPolicyDigest: sha256DigestSchema,
    expectedDiscoveryPolicyDigest: sha256DigestSchema,
    expectedCostPolicyDigest: sha256DigestSchema
  })
  .strict();

export interface FactoryExternalPullRequestReviewPreflight {
  readonly schemaVersion: "agentlab.external-pull-request-review-preflight.v1";
  readonly status: "ready" | "blocked";
  readonly repositoryId: string;
  readonly reviewPolicyDigest: Sha256Digest;
  readonly discoveryPolicyDigest: Sha256Digest;
  readonly costPolicyDigest: Sha256Digest;
  readonly reviewers: number;
  readonly reasonCodes: readonly string[];
}

export interface FactoryExternalPullRequestReviewTickReport {
  readonly schemaVersion: "agentlab.external-pull-request-review-tick-result.v1";
  readonly status: "completed" | "idle" | "partial" | "blocked";
  readonly repositoryId: string;
  readonly reviewPolicyDigest: Sha256Digest;
  readonly inspected: number;
  readonly completed: number;
  readonly approved: number;
  readonly changesRequested: number;
  readonly humanReviewRequired: number;
  readonly failed: number;
  readonly quarantined: number;
  readonly reasonCodes: readonly string[];
  readonly runs: readonly {
    readonly runId: string;
    readonly runDigest: Sha256Digest;
    readonly pullRequestNumber: number;
    readonly status: "completed" | "failed" | "quarantined" | "blocked";
    readonly decision: "approved" | "changes-requested" | "human-review-required" | null;
    readonly bundleDigest: Sha256Digest | null;
    readonly reasonCode: string | null;
  }[];
}

export interface FactoryExternalPullRequestReviewServiceDependencies {
  readonly repositoryRoot: string;
  readonly reviewPolicy: CanonicalFactoryDocument<FactoryExternalPullRequestReviewPolicy>;
  readonly costPolicyDigest: Sha256Digest;
  readonly repository: FactoryExternalPullRequestReviewRepository;
  readonly artifacts: FactoryArtifactStore;
  readonly documents: FactoryDocumentCodec;
  readonly skills: FactorySkillSource;
  readonly workspaces: FactoryExternalPullRequestReviewWorkspaceManager;
  readonly recovery: FactoryWorkspaceRecoveryReconciler;
  readonly agents: FactoryAgentExecutor;
  readonly providers: FactoryAgentProviderResolver;
  readonly now: () => string;
  readonly createId: () => string;
}

type EventPayload<
  Event extends FactoryExternalPullRequestReviewEvent = FactoryExternalPullRequestReviewEvent
> = Event extends FactoryExternalPullRequestReviewEvent
  ? Omit<
      Event,
      | "schemaVersion"
      | "eventId"
      | "reviewRunId"
      | "runDigest"
      | "sequence"
      | "previousEventDigest"
      | "actor"
      | "occurredAt"
      | "correlationId"
    > & { readonly occurredAt?: string }
  : never;

type RunReport = FactoryExternalPullRequestReviewTickReport["runs"][number];

/** Produces immutable independent-review evidence with no GitHub or remote-write capability. */
export class FactoryExternalPullRequestReviewService {
  public constructor(
    private readonly dependencies: FactoryExternalPullRequestReviewServiceDependencies
  ) {}

  public async preflight(): Promise<FactoryExternalPullRequestReviewPreflight> {
    const reviewers = await this.#resolveReviewers();
    const reasonCodes = await this.#profileReasonCodes(reviewers);
    return {
      schemaVersion: "agentlab.external-pull-request-review-preflight.v1",
      status: reasonCodes.length === 0 ? "ready" : "blocked",
      repositoryId: this.dependencies.reviewPolicy.value.repositoryId,
      reviewPolicyDigest: this.dependencies.reviewPolicy.digest,
      discoveryPolicyDigest: this.dependencies.reviewPolicy.value.discoveryPolicyDigest,
      costPolicyDigest: this.dependencies.costPolicyDigest,
      reviewers: reviewers.length,
      reasonCodes
    };
  }

  public async tick(input: unknown): Promise<FactoryExternalPullRequestReviewTickReport> {
    const command = tickInputSchema.parse(input);
    this.#assertPins(command);
    const reviewers = await this.#resolveReviewers();
    const profileReasons = await this.#profileReasonCodes(reviewers);
    if (profileReasons.length > 0) return this.#report([], "blocked", profileReasons);

    const policy = this.dependencies.reviewPolicy.value;
    const active = await this.dependencies.repository.listActive({
      repositoryId: policy.repositoryId,
      reviewPolicyDigest: this.dependencies.reviewPolicy.digest,
      limit: policy.maximumCandidatesPerTick
    });
    const reports: RunReport[] = [];
    for (const journal of active) reports.push(await this.#resume(journal, reviewers));

    const remaining = policy.maximumCandidatesPerTick - reports.length;
    if (remaining > 0) {
      const candidates = await this.dependencies.repository.listAdmitted({
        repositoryId: policy.repositoryId,
        discoveryPolicyDigest: policy.discoveryPolicyDigest,
        reviewPolicyDigest: this.dependencies.reviewPolicy.digest,
        limit: remaining
      });
      for (const candidate of candidates) {
        const journal = await this.#register(candidate);
        reports.push(await this.#execute(journal, reviewers));
      }
    }
    if (reports.length === 0) return this.#report([], "idle", []);
    const completed = reports.filter(({ status }) => status === "completed").length;
    return this.#report(
      reports,
      completed === reports.length ? "completed" : completed === 0 ? "blocked" : "partial",
      reports.flatMap(({ reasonCode }) => (reasonCode === null ? [] : [reasonCode]))
    );
  }

  async #resolveReviewers(): Promise<readonly ResolvedExternalPullRequestReviewer[]> {
    return resolveExternalPullRequestReviewers(
      this.dependencies.skills,
      this.dependencies.reviewPolicy.value
    );
  }

  async #profileReasonCodes(
    reviewers: readonly ResolvedExternalPullRequestReviewer[]
  ): Promise<readonly string[]> {
    const capabilities = this.dependencies.agents.capabilities();
    const reasons: string[] = [];
    for (const { profile } of reviewers) {
      const capability = capabilities.find(({ provider }) => provider === profile.provider);
      if (!capability?.roles.includes("reviewer")) {
        reasons.push(`reviewer-${profile.id}-capability-unavailable`);
        continue;
      }
      try {
        this.dependencies.agents.preflight({
          provider: profile.provider,
          model: profile.model,
          policyBundleDigest: this.dependencies.costPolicyDigest
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
    candidate: FactoryExternalPullRequestReviewCandidateEnvelope
  ): Promise<FactoryExternalPullRequestReviewJournalSnapshot> {
    if (
      candidate.discoveryPolicyDigest !== this.dependencies.reviewPolicy.value.discoveryPolicyDigest
    ) {
      throw new Error("External PR review candidate belongs to another discovery policy.");
    }
    const createdAt = factoryTimestampSchema.parse(this.dependencies.now());
    const deadlineAt = factoryTimestampAddSeconds(
      createdAt,
      this.dependencies.reviewPolicy.value.aggregateBudget.wallClockSeconds
    );
    const run = this.dependencies.documents.externalPullRequestReviewRun({
      schemaVersion: "agentlab.external-pull-request-review-run.v1",
      runId: this.dependencies.createId(),
      repositoryId: candidate.candidate.repositoryId,
      pullRequestNumber: candidate.candidate.pullRequestNumber,
      candidateDigest: candidate.candidateDigest,
      candidate: candidate.candidate,
      discoveryRunId: candidate.discoveryRunId,
      discoveryRunDigest: candidate.discoveryRunDigest,
      discoverySnapshotDigest: candidate.discoverySnapshotDigest,
      discoveryPolicyDigest: candidate.discoveryPolicyDigest,
      reviewPolicyDigest: this.dependencies.reviewPolicy.digest,
      reviewPolicy: this.dependencies.reviewPolicy.value,
      costPolicyDigest: this.dependencies.costPolicyDigest,
      workspaceId: this.dependencies.createId(),
      createdAt,
      deadlineAt,
      correlationId: this.dependencies.createId()
    });
    const event = this.dependencies.documents.externalPullRequestReviewEvent({
      schemaVersion: "agentlab.external-pull-request-review-event.v1",
      eventId: this.dependencies.createId(),
      reviewRunId: run.value.runId,
      runDigest: run.digest,
      sequence: 1,
      previousEventDigest: null,
      actor: actor(run.value.runId),
      kind: "registered",
      from: null,
      to: "ready",
      occurredAt: createdAt,
      reasonCode: "admitted-discovery-candidate",
      correlationId: run.value.correlationId
    });
    return this.dependencies.repository.register(run, event);
  }

  async #resume(
    journal: FactoryExternalPullRequestReviewJournalSnapshot,
    reviewers: readonly ResolvedExternalPullRequestReviewer[]
  ): Promise<RunReport> {
    if (journal.state === "recorded") return this.#complete(journal);
    if (journal.state === "ready") return this.#execute(journal, reviewers);
    const recoveryAttempts = journal.history.filter(({ kind }) => kind === "recovered").length;
    if (recoveryAttempts >= journal.run.reviewPolicy.maximumRecoveryAttempts) {
      const failed = await this.#append(journal, {
        kind: "failed",
        from: journal.state as "workspace-active" | "reviewing" | "reviewer-active",
        to: "failed",
        reviewerRecordDigest: null,
        reasonCode: "review-recovery-exhausted"
      });
      return reportFor(failed, "failed", "review-recovery-exhausted");
    }
    const result = await this.dependencies.recovery.reconcile({
      taskId: journal.run.runId,
      workspaceId: journal.run.workspaceId,
      attempt: 1,
      repositoryRoot: this.dependencies.repositoryRoot,
      baseRevision: journal.run.candidate.head.revision,
      processExecutionIds: journal.history.flatMap((event) =>
        event.kind === "reviewer-started" ? [event.executionId] : []
      )
    });
    if (result.status !== "inactive") {
      return reportFor(journal, "blocked", result.reasonCode);
    }
    const recovered = await this.#append(journal, {
      kind: "recovered",
      from: journal.state as "workspace-active" | "reviewing" | "reviewer-active",
      to: "ready",
      reasonCode: "inactive-review-workspace-recovered"
    });
    return this.#execute(recovered, reviewers);
  }

  async #execute(
    initial: FactoryExternalPullRequestReviewJournalSnapshot,
    reviewers: readonly ResolvedExternalPullRequestReviewer[]
  ): Promise<RunReport> {
    let journal = initial;
    let workspace: Awaited<
      ReturnType<FactoryExternalPullRequestReviewWorkspaceManager["prepare"]>
    > | null = null;
    let latestRecordDigest: Sha256Digest | null = null;
    try {
      if (factoryTimestampSchema.parse(this.dependencies.now()) > journal.run.deadlineAt) {
        const failed = await this.#append(journal, {
          kind: "failed",
          from: "ready",
          to: "failed",
          reviewerRecordDigest: null,
          reasonCode: "review-deadline-expired"
        });
        return reportFor(failed, "failed", "review-deadline-expired");
      }
      journal = await this.#append(journal, {
        kind: "workspace-started",
        from: "ready",
        to: "workspace-active",
        reasonCode: "exact-head-workspace-started"
      });
      workspace = await this.dependencies.workspaces.prepare({
        reviewRunId: journal.run.runId,
        workspaceId: journal.run.workspaceId,
        repositoryRoot: this.dependencies.repositoryRoot,
        candidate: journal.run.candidate,
        maximumPatchBytes: journal.run.reviewPolicy.maximumPatchBytes
      });
      journal = await this.#append(journal, {
        kind: "workspace-prepared",
        from: "workspace-active",
        to: "reviewing",
        patchDigest: workspace.patchDigest,
        patchArtifact: workspace.patchArtifact,
        reasonCode: "authenticated-paths-and-local-patch-match"
      });

      const selected = reviewers.slice(0, journal.run.reviewPolicy.minimumIndependentReviews);
      const prior = await this.#loadCompleted(journal, workspace.patchDigest);
      const records = [...prior.records];
      const results = [...prior.results];
      const meter = new FactoryBudgetMeter();
      for (const record of records) meter.addUsage(record.usage, record.usageComplete);
      for (const reviewer of selected) {
        if (results.some(({ reviewerId }) => reviewer.profile.id === reviewerId)) continue;
        this.#assertDeadline(journal, latestRecordDigest);
        const remaining = meter.remaining(
          journal.run.reviewPolicy.aggregateBudget,
          changeSet(journal.run.candidate),
          0
        );
        if (remaining === null) throw new ReviewFailure("review-aggregate-budget-exhausted", null);
        const execution = await this.#runReviewer(
          journal,
          reviewer,
          workspace,
          minimumFactoryBudget(reviewer.profile.budget, remaining)
        );
        journal = execution.journal;
        latestRecordDigest = execution.record.digest;
        records.push(execution.record.value);
        results.push(execution.result.value);
        meter.addUsage(execution.record.value.usage, execution.record.value.usageComplete);
      }
      if (results.length !== selected.length || !meter.complete) {
        throw new ReviewFailure("review-evidence-incomplete", latestRecordDigest);
      }
      if (
        meter.exceeds(journal.run.reviewPolicy.aggregateBudget, changeSet(journal.run.candidate), 0)
      ) {
        throw new ReviewFailure("review-aggregate-budget-exhausted", latestRecordDigest);
      }
      this.#assertDeadline(journal, latestRecordDigest);
      const sessions = records.map(({ providerSessionId }) => providerSessionId);
      if (
        sessions.some((session) => session === null) ||
        new Set(sessions).size !== sessions.length
      ) {
        throw new ReviewFailure("independent-review-session-identity-invalid", latestRecordDigest);
      }
      try {
        await workspace.assertUnchanged();
      } catch {
        throw new ReviewFailure("reviewer-mutated-workspace", latestRecordDigest, true);
      }
      await workspace.close();
      workspace = null;
      const approvalCount = results.filter(({ verdict }) => verdict === "approved").length;
      const decision =
        approvalCount === results.length
          ? "approved"
          : approvalCount === 0
            ? "changes-requested"
            : "human-review-required";
      const bundle = this.dependencies.documents.externalPullRequestReviewBundle({
        schemaVersion: "agentlab.external-pull-request-review-bundle.v1",
        reviewRunId: journal.run.runId,
        runDigest: journal.runDigest,
        repositoryId: journal.run.repositoryId,
        pullRequestNumber: journal.run.pullRequestNumber,
        candidateDigest: journal.run.candidateDigest,
        patchDigest: workspacePatchDigest(journal),
        reviewPolicyDigest: journal.run.reviewPolicyDigest,
        decision,
        reviewerRecords: records,
        reviews: results,
        aggregateUsage: meter.finish(changeSet(journal.run.candidate), 0),
        usageComplete: meter.complete,
        workspaceUnchanged: true,
        createdAt: factoryTimestampSchema.parse(this.dependencies.now())
      });
      const storedBundle = await this.#storeDocument(
        bundle,
        "application/vnd.agentlab.external-pull-request-review-bundle+json;version=1"
      );
      const event = this.#event(journal, {
        kind: "bundle-recorded",
        from: "reviewing",
        to: "recorded",
        bundleDigest: bundle.digest,
        bundleArtifact: storedBundle,
        reasonCode: "independent-review-evidence-recorded"
      });
      const recorded = await this.dependencies.repository.recordBundle(event, bundle);
      if (recorded === null) throw new Error("External PR review lost its bundle claim.");
      return await this.#complete(recorded);
    } catch (error: unknown) {
      if (workspace !== null) {
        try {
          await workspace.close();
        } catch (cleanupError: unknown) {
          throw new AggregateError(
            [error, cleanupError],
            "External PR review and workspace cleanup both failed.",
            { cause: error }
          );
        }
      }
      const current = await this.dependencies.repository.findByCandidate({
        candidateDigest: journal.run.candidateDigest,
        reviewPolicyDigest: journal.run.reviewPolicyDigest
      });
      if (current === null) throw error;
      if (current.state === "recorded") return this.#complete(current);
      if (!isActiveState(current.state)) throw error;
      const reasonCode =
        error instanceof ReviewFailure ? error.reasonCode : "external-pull-request-review-failed";
      const quarantined = error instanceof ReviewFailure && error.quarantine;
      const terminal = await this.#append(current, {
        kind: quarantined ? "quarantined" : "failed",
        from: current.state,
        to: quarantined ? "quarantined" : "failed",
        reviewerRecordDigest:
          error instanceof ReviewFailure ? error.reviewerRecordDigest : latestRecordDigest,
        reasonCode
      } as EventPayload);
      return reportFor(terminal, quarantined ? "quarantined" : "failed", reasonCode);
    }
  }

  async #runReviewer(
    journal: FactoryExternalPullRequestReviewJournalSnapshot,
    reviewer: ResolvedExternalPullRequestReviewer,
    workspace: NonNullable<
      Awaited<ReturnType<FactoryExternalPullRequestReviewWorkspaceManager["prepare"]>>
    >,
    budget: FactoryBudget
  ) {
    const prompt = renderExternalPullRequestReviewPrompt({
      candidate: journal.run.candidate,
      policy: journal.run.reviewPolicy,
      reviewerId: reviewer.profile.id,
      skills: reviewer.skills,
      patch: workspace.patch
    });
    if (new TextEncoder().encode(prompt).byteLength > journal.run.reviewPolicy.maximumPromptBytes) {
      throw new ReviewFailure("review-prompt-byte-ceiling-exceeded", null);
    }
    const [storedPrompt, storedSchema] = await Promise.all([
      this.dependencies.artifacts.putText(prompt),
      this.dependencies.artifacts.putText(externalPullRequestReviewOutputSchemaJson)
    ]);
    const executionId = this.dependencies.createId();
    const request = this.dependencies.documents.externalPullRequestReviewerRequest({
      schemaVersion: "agentlab.external-pull-request-reviewer-request.v1",
      executionId,
      reviewRunId: journal.run.runId,
      taskId: journal.run.runId,
      contractDigest: journal.runDigest,
      candidateDigest: journal.run.candidateDigest,
      reviewerId: reviewer.profile.id,
      role: "reviewer",
      attempt:
        journal.run.reviewPolicy.reviewerProfiles.findIndex(
          ({ id }) => id === reviewer.profile.id
        ) + 1,
      provider: reviewer.profile.provider,
      model: reviewer.profile.model,
      reasoning: reviewer.profile.reasoning,
      repository: {
        id: journal.run.repositoryId,
        baseRevision: journal.run.candidate.head.revision
      },
      pullRequest: {
        number: journal.run.pullRequestNumber,
        baseRevision: journal.run.candidate.base.revision,
        headRevision: journal.run.candidate.head.revision,
        patchDigest: workspace.patchDigest
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
      reasonCode: "independent-reviewer-started"
    });
    const provider = await this.dependencies.providers.resolve(
      reviewer.profile.provider,
      workspace.workspace.root
    );
    if (provider === null) throw new ReviewFailure("review-provider-unavailable", null);
    const output = await this.dependencies.agents.execute({
      request: request.value,
      policyBundleDigest: this.dependencies.costPolicyDigest,
      executable: provider.executable,
      providerVersion: provider.version,
      workspace: workspace.workspace,
      prompt,
      resourceLimits: narrowFactoryResourceLimits(
        journal.run.reviewPolicy.resourceLimits,
        budget.maxProcesses
      )
    });
    if (
      output.errorCode === factoryProcessCleanupUnconfirmedErrorCode ||
      output.isolation.isolationId !== executionId
    ) {
      throw new Error("External reviewer process cleanup or isolation identity is uncertain.");
    }
    const record = await this.#reviewerRecord(journal, reviewer, request.digest, output);
    await this.#storeDocument(
      record,
      "application/vnd.agentlab.external-pull-request-reviewer-record+json;version=1"
    );
    if (record.value.status !== "succeeded" || !record.value.usageComplete) {
      throw new ReviewFailure("independent-reviewer-run-failed", record.digest);
    }
    let decision;
    try {
      decision = factoryReviewDecisionSchema.parse(
        JSON.parse(output.finalOutput ?? "null") as unknown
      );
    } catch {
      throw new ReviewFailure("independent-reviewer-output-invalid", record.digest);
    }
    const result = this.dependencies.documents.externalPullRequestReviewResult({
      ...decision,
      schemaVersion: "agentlab.external-pull-request-review-result.v1",
      reviewRunId: journal.run.runId,
      runDigest: journal.runDigest,
      candidateDigest: journal.run.candidateDigest,
      patchDigest: workspace.patchDigest,
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
      reasonCode: "independent-reviewer-finished"
    });
    return { journal, record, result };
  }

  async #reviewerRecord(
    journal: FactoryExternalPullRequestReviewJournalSnapshot,
    reviewer: ResolvedExternalPullRequestReviewer,
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
      reviewRunId: journal.run.runId,
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

  async #loadCompleted(
    journal: FactoryExternalPullRequestReviewJournalSnapshot,
    patchDigest: Sha256Digest
  ): Promise<{
    readonly records: FactoryExternalPullRequestReviewerRecord[];
    readonly results: FactoryExternalPullRequestReviewResult[];
  }> {
    const records: FactoryExternalPullRequestReviewerRecord[] = [];
    const results: FactoryExternalPullRequestReviewResult[] = [];
    for (const event of journal.history) {
      if (event.kind !== "reviewer-finished") continue;
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
      await this.#assertRecoveredArtifacts(request.value, record.value, journal);
      if (
        request.digest !== event.requestDigest ||
        record.digest !== event.reviewerRecordDigest ||
        result.digest !== event.reviewResultDigest ||
        request.value.reviewRunId !== journal.run.runId ||
        request.value.taskId !== journal.run.runId ||
        request.value.contractDigest !== journal.runDigest ||
        request.value.candidateDigest !== journal.run.candidateDigest ||
        request.value.reviewerId !== event.reviewerId ||
        request.value.executionId !== event.executionId ||
        request.value.repository.id !== journal.run.repositoryId ||
        request.value.repository.baseRevision !== journal.run.candidate.head.revision ||
        request.value.pullRequest.number !== journal.run.pullRequestNumber ||
        request.value.pullRequest.baseRevision !== journal.run.candidate.base.revision ||
        request.value.pullRequest.headRevision !== journal.run.candidate.head.revision ||
        request.value.pullRequest.patchDigest !== patchDigest ||
        record.value.reviewRunId !== journal.run.runId ||
        record.value.runDigest !== journal.runDigest ||
        record.value.requestDigest !== request.digest ||
        record.value.reviewerId !== request.value.reviewerId ||
        record.value.executionId !== request.value.executionId ||
        record.value.provider !== request.value.provider ||
        record.value.model !== request.value.model ||
        record.value.reasoning !== request.value.reasoning ||
        result.value.reviewRunId !== journal.run.runId ||
        result.value.runDigest !== journal.runDigest ||
        result.value.patchDigest !== patchDigest ||
        result.value.reviewerRecordDigest !== record.digest ||
        result.value.reviewerId !== event.reviewerId ||
        result.value.executionId !== event.executionId ||
        result.value.requestDigest !== event.requestDigest
      ) {
        throw new Error(
          "Recovered external reviewer evidence failed immutable lineage validation."
        );
      }
      records.push(record.value);
      results.push(result.value);
    }
    return { records, results };
  }

  async #assertRecoveredArtifacts(
    request: FactoryExternalPullRequestReviewerRequest,
    record: FactoryExternalPullRequestReviewerRecord,
    journal: FactoryExternalPullRequestReviewJournalSnapshot
  ): Promise<void> {
    const finalOutput = record.finalOutputArtifact;
    if (finalOutput === null) {
      throw new Error("Recovered successful external review has no final output artifact.");
    }
    const [prompt, schema] = await Promise.all([
      this.#readExactArtifact(request.promptArtifact, journal.run.reviewPolicy.maximumPromptBytes),
      this.dependencies.artifacts.readText(request.outputSchemaDigest, 1 * 1_024 * 1_024),
      this.#readExactArtifact(record.stdoutArtifact, 16 * 1_024 * 1_024),
      this.#readExactArtifact(record.stderrArtifact, 16 * 1_024 * 1_024),
      this.#readExactArtifact(finalOutput, 4 * 1_024 * 1_024)
    ]);
    if (
      new TextEncoder().encode(prompt).byteLength > journal.run.reviewPolicy.maximumPromptBytes ||
      schema !== externalPullRequestReviewOutputSchemaJson
    ) {
      throw new Error("Recovered external review prompt or output schema changed.");
    }
  }

  async #readExactArtifact(
    reference: FactoryArtifactReference,
    maximumBytes: number
  ): Promise<string> {
    if (reference.sizeBytes > maximumBytes) {
      throw new Error("Recovered external review artifact exceeds its evidence ceiling.");
    }
    const content = await this.dependencies.artifacts.readText(
      reference.digest,
      Math.max(1, maximumBytes)
    );
    if (new TextEncoder().encode(content).byteLength !== reference.sizeBytes) {
      throw new Error("Recovered external review artifact size changed.");
    }
    return content;
  }

  async #complete(journal: FactoryExternalPullRequestReviewJournalSnapshot): Promise<RunReport> {
    if (journal.state !== "recorded" || journal.bundle === null) {
      throw new Error("External PR review completion requires a recorded bundle.");
    }
    const completed = await this.#append(journal, {
      kind: "completed",
      from: "recorded",
      to: "completed",
      decision: journal.bundle.decision,
      reasonCode: "external-pull-request-review-completed"
    });
    return reportFor(completed, "completed", null);
  }

  async #append(
    journal: FactoryExternalPullRequestReviewJournalSnapshot,
    payload: EventPayload
  ): Promise<FactoryExternalPullRequestReviewJournalSnapshot> {
    const event = this.#event(journal, payload);
    const result = await this.dependencies.repository.append(event);
    if (result === null) throw new Error("External PR review lost its journal append claim.");
    return result;
  }

  #event(journal: FactoryExternalPullRequestReviewJournalSnapshot, payload: EventPayload) {
    return this.dependencies.documents.externalPullRequestReviewEvent({
      schemaVersion: "agentlab.external-pull-request-review-event.v1",
      eventId: this.dependencies.createId(),
      reviewRunId: journal.run.runId,
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
      throw new Error("External PR review canonical artifact changed during publication.");
    }
    return artifact(stored, mediaType);
  }

  #assertPins(command: z.infer<typeof tickInputSchema>): void {
    if (
      command.expectedReviewPolicyDigest !== this.dependencies.reviewPolicy.digest ||
      command.expectedDiscoveryPolicyDigest !==
        this.dependencies.reviewPolicy.value.discoveryPolicyDigest ||
      command.expectedCostPolicyDigest !== this.dependencies.costPolicyDigest
    ) {
      throw new Error("External PR review policy changed after operator review.");
    }
  }

  #assertDeadline(
    journal: FactoryExternalPullRequestReviewJournalSnapshot,
    reviewerRecordDigest: Sha256Digest | null
  ): void {
    if (factoryTimestampSchema.parse(this.dependencies.now()) > journal.run.deadlineAt) {
      throw new ReviewFailure("review-deadline-expired", reviewerRecordDigest);
    }
  }

  #report(
    runs: readonly RunReport[],
    status: FactoryExternalPullRequestReviewTickReport["status"],
    reasonCodes: readonly string[]
  ): FactoryExternalPullRequestReviewTickReport {
    return {
      schemaVersion: "agentlab.external-pull-request-review-tick-result.v1",
      status,
      repositoryId: this.dependencies.reviewPolicy.value.repositoryId,
      reviewPolicyDigest: this.dependencies.reviewPolicy.digest,
      inspected: runs.length,
      completed: runs.filter(({ status: value }) => value === "completed").length,
      approved: runs.filter(({ decision }) => decision === "approved").length,
      changesRequested: runs.filter(({ decision }) => decision === "changes-requested").length,
      humanReviewRequired: runs.filter(({ decision }) => decision === "human-review-required")
        .length,
      failed: runs.filter(({ status: value }) => value === "failed").length,
      quarantined: runs.filter(({ status: value }) => value === "quarantined").length,
      reasonCodes: [...new Set(reasonCodes)].sort(),
      runs
    };
  }
}

class ReviewFailure extends Error {
  public constructor(
    public readonly reasonCode: string,
    public readonly reviewerRecordDigest: Sha256Digest | null,
    public readonly quarantine = false
  ) {
    super(reasonCode);
  }
}

function actor(runId: string): FactoryActor {
  return {
    kind: "control-plane",
    id: "agentlab/external-pull-request-review",
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

function changeSet(candidate: FactoryExternalPullRequestCandidate) {
  return {
    baseRevision: candidate.base.revision,
    headRevision: candidate.head.revision,
    changedPaths: candidate.changedFiles.map(({ path }) => path),
    binaryPaths: [],
    changedFiles: candidate.changedFiles.length,
    changedLines: candidate.changedLines
  };
}

function workspacePatchDigest(journal: FactoryExternalPullRequestReviewJournalSnapshot) {
  const event = [...journal.history].reverse().find(({ kind }) => kind === "workspace-prepared");
  if (event?.kind !== "workspace-prepared") {
    throw new Error("External PR review journal has no authenticated patch.");
  }
  return event.patchDigest;
}

function reportFor(
  journal: FactoryExternalPullRequestReviewJournalSnapshot,
  status: RunReport["status"],
  reasonCode: string | null
): RunReport {
  return {
    runId: journal.run.runId,
    runDigest: journal.runDigest,
    pullRequestNumber: journal.run.pullRequestNumber,
    status,
    decision: journal.bundle?.decision ?? null,
    bundleDigest: recordedBundleDigest(journal),
    reasonCode
  };
}

function recordedBundleDigest(
  journal: FactoryExternalPullRequestReviewJournalSnapshot
): Sha256Digest | null {
  const event = [...journal.history].reverse().find(({ kind }) => kind === "bundle-recorded");
  return event?.kind === "bundle-recorded" ? event.bundleDigest : null;
}

function isActiveState(
  state: FactoryExternalPullRequestReviewJournalSnapshot["state"]
): state is "ready" | "workspace-active" | "reviewing" | "reviewer-active" {
  return ["ready", "workspace-active", "reviewing", "reviewer-active"].includes(state);
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch (error: unknown) {
    throw new Error("External PR review artifact is invalid JSON.", { cause: error });
  }
}
