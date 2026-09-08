import {
  factoryLedgerOperationSchema,
  factoryLedgerOperationResultSchema,
  factoryLedgerGateOutputSchema,
  factoryLedgerAgentOutputSchema,
  type FactoryProcessIsolation,
  factoryTimestampSchema,
  type FactoryLedgerOperation,
  type FactoryLedgerOperationResult,
  type Sha256Digest
} from "@agentlab/contracts";

import {
  factoryProcessCleanupUnconfirmedErrorCode,
  type FactoryAgentExecutor,
  type FactoryAgentProviderResolver
} from "../domain/factory-agent-executor.js";
import type { CanonicalFactoryDocument } from "../domain/factory-documents.js";
import type { FactoryGateExecutor } from "../domain/factory-gate.js";
import type { FactoryArtifactWireCodec } from "../domain/factory-ledger-artifacts.js";
import { factoryTimestampDifferenceSeconds } from "../domain/factory-timestamp.js";
import type {
  FactoryWorkspaceManager,
  FactoryWorkspace,
  FactoryWorkspacePatch
} from "../domain/factory-workspace.js";
import type { FactoryWorkspaceRecoveryReconciler } from "../domain/factory-workspace-recovery.js";

export interface FactoryLedgerOperationWorkerDependencies {
  readonly principal: FactoryLedgerOperation["principal"];
  readonly workerPolicyDigest: Sha256Digest;
  readonly factoryPolicyDigest: Sha256Digest;
  readonly repository: { readonly id: string; readonly root: string };
  readonly workspaces: FactoryWorkspaceManager;
  readonly recovery: FactoryWorkspaceRecoveryReconciler;
  readonly agents: FactoryAgentExecutor;
  readonly providers: FactoryAgentProviderResolver;
  readonly gates: FactoryGateExecutor;
  readonly wire: FactoryArtifactWireCodec;
  readonly encode: <T>(value: T) => CanonicalFactoryDocument<T>;
  readonly now: () => string;
}

/** Executes an already-claimed job in a fresh private checkout; it never owns the task ledger. */
export class FactoryLedgerOperationWorker {
  readonly #started = new Set<string>();
  readonly #uncertain = new Map<string, FactoryWorkspace | null>();
  #running = false;
  public constructor(private readonly dependencies: FactoryLedgerOperationWorkerDependencies) {}

  public async execute(
    input: CanonicalFactoryDocument<FactoryLedgerOperation>
  ): Promise<CanonicalFactoryDocument<FactoryLedgerOperationResult>> {
    const job = this.#job(input);
    if (this.#running || this.#uncertain.size !== 0 || this.#started.has(job.jobId))
      throw new Error("Worker cannot overlap jobs or replay a consumed operation.");
    this.#started.add(job.jobId);
    this.#running = true;
    let workspace: FactoryWorkspace | null = null;
    let safeToClose = true;
    try {
      this.#timeRemaining(job);
      // Construction can fail after creating resources but before returning their handle.
      this.#uncertain.set(job.jobId, null);
      workspace = await this.dependencies.workspaces.create({
        taskId: job.taskId,
        attempt: job.attempt,
        workspaceId: job.jobId,
        repositoryRoot: this.dependencies.repository.root,
        baseRevision: job.repository.baseRevision
      });
      this.#uncertain.set(job.jobId, workspace);
      if (
        workspace.id !== job.jobId ||
        workspace.taskId !== job.taskId ||
        workspace.attempt !== job.attempt ||
        workspace.baseRevision !== job.repository.baseRevision ||
        workspace.repositoryRoot !== this.dependencies.repository.root
      )
        throw new Error("Worker workspace differs from its exact job identity.");
      if (job.seedPatch !== null && job.seedPatch.patch !== "")
        await this.dependencies.workspaces.apply(
          workspace,
          job.seedPatch.patch,
          job.limits.maximumPatchBytes
        );
      const before = await this.#collect(workspace, job);
      this.#patch(job, before);
      if (job.seedPatch !== null && !this.#samePatch(before, job.seedPatch))
        throw new Error("Reconstructed worker checkout differs from the immutable seed patch.");
      if (job.seedPatch === null && (before.patch !== "" || before.changeSet.changedFiles !== 0))
        throw new Error("Fresh worker checkout is not clean.");
      let result: FactoryLedgerOperationResult;
      if (job.kind === "agent") {
        const prompt = new TextEncoder().encode(job.prompt);
        if (
          this.dependencies.wire.digest(prompt) !== job.request.promptArtifact.digest ||
          prompt.byteLength !== job.request.promptArtifact.sizeBytes
        )
          throw new Error("Worker prompt differs from the immutable agent request.");
        const capability = this.dependencies.agents
          .capabilities()
          .find(({ provider }) => provider === job.request.provider);
        if (!capability?.roles.includes(job.request.role))
          throw new Error("Worker does not support the assigned agent role.");
        this.dependencies.agents.preflight({
          provider: job.request.provider,
          model: job.request.model,
          policyBundleDigest: job.factoryPolicyDigest
        });
        const provider = await this.dependencies.providers.resolve(
          job.request.provider,
          workspace.root
        );
        if (provider?.version !== job.providerVersion)
          throw new Error("Worker provider version differs from the pinned job.");
        this.#timeRemaining(job);
        safeToClose = false;
        const output = factoryLedgerAgentOutputSchema.parse(
          await this.dependencies.agents.execute({
            request: job.request,
            policyBundleDigest: job.factoryPolicyDigest,
            executable: provider.executable,
            providerVersion: provider.version,
            workspace,
            prompt: job.prompt,
            resourceLimits: job.resourceLimits
          })
        );
        if (output.errorCode === factoryProcessCleanupUnconfirmedErrorCode)
          throw new Error("Worker process cleanup is uncertain.");
        this.#isolation(job, output.isolation);
        safeToClose = true;
        const patch = await this.#collect(workspace, job);
        if (job.request.role === "reviewer" && !this.#samePatch(before, patch))
          throw new Error("Independent reviewer changed the candidate patch.");
        result = {
          schemaVersion: "agentlab.ledger-operation-result.v1",
          kind: "agent",
          jobId: job.jobId,
          jobDigest: input.digest,
          output,
          patch,
          workspace: "closed",
          completedAt: job.createdAt
        };
      } else {
        if (!this.dependencies.gates.availableGateIds().includes(job.gateId))
          throw new Error("Worker gate is not installed.");
        this.#timeRemaining(job);
        safeToClose = false;
        const output = factoryLedgerGateOutputSchema.parse(
          await this.dependencies.gates.execute({
            gateId: job.gateId,
            isolationId: job.jobId,
            workspace,
            resourceLimits: job.resourceLimits,
            maximumWallClockSeconds: job.limits.maximumRunSeconds,
            maximumOutputBytes: job.limits.maximumResultBytes
          })
        );
        this.#isolation(job, output.isolation);
        safeToClose = true;
        const patch = await this.#collect(workspace, job);
        if (!this.#samePatch(before, patch)) throw new Error("Gate changed the candidate patch.");
        result = {
          schemaVersion: "agentlab.ledger-operation-result.v1",
          kind: "gate",
          jobId: job.jobId,
          jobDigest: input.digest,
          output,
          patch,
          workspace: "closed",
          completedAt: job.createdAt
        };
      }
      this.#patch(job, result.patch);
      if (
        result.output.startedAt < job.createdAt ||
        result.output.finishedAt < result.output.startedAt ||
        ((result.kind === "agent"
          ? result.output.status === "succeeded"
          : result.output.result === "pass") &&
          factoryTimestampDifferenceSeconds(result.output.startedAt, result.output.finishedAt) >
            job.limits.maximumRunSeconds) ||
        (result.kind === "agent" &&
          job.kind === "agent" &&
          result.output.providerVersion !== job.providerVersion) ||
        (result.kind === "gate" && job.kind === "gate" && result.output.gateId !== job.gateId)
      )
        throw new Error("Worker result differs from its job, provider or isolation limits.");
      await workspace.closeAndWait();
      this.#uncertain.delete(job.jobId);
      workspace = null;
      const completedAt = factoryTimestampSchema.parse(this.dependencies.now());
      if (completedAt < result.output.finishedAt || completedAt >= job.expiresAt)
        throw new Error("Worker result missed its deadline or the clock regressed.");
      const encoded = this.dependencies.encode(
        factoryLedgerOperationResultSchema.parse({ ...result, completedAt })
      );
      if (new TextEncoder().encode(encoded.json).byteLength > job.limits.maximumResultBytes)
        throw new Error("Worker result exceeds its bounded transfer budget.");
      return encoded;
    } finally {
      try {
        if (workspace !== null && safeToClose) {
          await workspace.closeAndWait();
          this.#uncertain.delete(job.jobId);
        }
      } finally {
        this.#running = false;
      }
    }
  }

  /** Never retries execution: proves the exact prior process/worktree inactive before clearing it. */
  public async recover(input: CanonicalFactoryDocument<FactoryLedgerOperation>): Promise<void> {
    const job = this.#job(input);
    if (this.#running) throw new Error("Cannot recover a running worker job.");
    const outcome = await this.dependencies.recovery.reconcile({
      taskId: job.taskId,
      attempt: job.attempt,
      workspaceId: job.jobId,
      repositoryRoot: this.dependencies.repository.root,
      baseRevision: job.repository.baseRevision,
      processExecutionIds: [job.jobId]
    });
    if (outcome.status !== "inactive") throw new Error("Worker job cleanup remains uncertain.");
    await this.#uncertain.get(job.jobId)?.closeAndWait();
    this.#uncertain.delete(job.jobId);
    this.#started.add(job.jobId);
  }

  #job(input: CanonicalFactoryDocument<FactoryLedgerOperation>): FactoryLedgerOperation {
    const job = factoryLedgerOperationSchema.parse(input.value);
    const canonical = this.dependencies.encode(job);
    if (
      canonical.digest !== input.digest ||
      canonical.json !== input.json ||
      job.workerPolicyDigest !== this.dependencies.workerPolicyDigest ||
      job.factoryPolicyDigest !== this.dependencies.factoryPolicyDigest ||
      job.repository.id !== this.dependencies.repository.id ||
      job.principal.uid !== this.dependencies.principal.uid ||
      job.principal.id !== this.dependencies.principal.id ||
      job.principal.kind !== this.dependencies.principal.kind
    )
      throw new Error("Worker job is not assigned to this pinned local identity and policy.");
    if (new TextEncoder().encode(input.json).byteLength > 16_000_000)
      throw new Error("Worker job exceeds its transport budget.");
    return job;
  }
  #timeRemaining(job: FactoryLedgerOperation): void {
    const now = factoryTimestampSchema.parse(this.dependencies.now());
    if (
      now < job.createdAt ||
      factoryTimestampDifferenceSeconds(now, job.expiresAt) <
        job.limits.maximumRunSeconds + job.limits.cleanupReserveSeconds
    )
      throw new Error("Worker job has insufficient execution and cleanup time remaining.");
  }
  #patch(job: FactoryLedgerOperation, patch: FactoryWorkspacePatch): void {
    if (
      patch.changeSet.baseRevision !== job.repository.baseRevision ||
      patch.changeSet.headRevision !== null ||
      patch.changeSet.changedFiles > job.limits.maximumChangedFiles ||
      patch.changeSet.changedLines > job.limits.maximumChangedLines ||
      new TextEncoder().encode(patch.patch).byteLength > job.limits.maximumPatchBytes
    )
      throw new Error("Worker patch exceeds the exact-base change budget.");
  }
  #samePatch(left: FactoryWorkspacePatch, right: FactoryWorkspacePatch): boolean {
    return this.dependencies.encode(left).digest === this.dependencies.encode(right).digest;
  }

  #isolation(job: FactoryLedgerOperation, isolation: FactoryProcessIsolation): void {
    if (
      isolation.isolationId !== job.jobId ||
      isolation.scopeName !== `agentlab-factory-${job.jobId.replaceAll("-", "")}.scope` ||
      isolation.limits.maxMemoryBytes > job.resourceLimits.maxMemoryBytes ||
      isolation.limits.maxProcesses > job.resourceLimits.maxProcesses ||
      isolation.limits.cpuQuotaPercent > job.resourceLimits.cpuQuotaPercent
    )
      throw new Error("Worker result has unconfirmed job isolation identity or ceilings.");
  }

  #collect(
    workspace: FactoryWorkspace,
    job: FactoryLedgerOperation
  ): Promise<FactoryWorkspacePatch> {
    return this.dependencies.workspaces.collect(workspace, {
      maximumChangedFiles: job.limits.maximumChangedFiles,
      maximumChangedLines: job.limits.maximumChangedLines,
      maximumPatchBytes: job.limits.maximumPatchBytes
    });
  }
}
