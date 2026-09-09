import {
  factoryAgentRunRequestSchema,
  maximumLedgerArtifactBytes,
  factoryLedgerOperationResultSchema,
  factoryLedgerOperationSchema,
  factoryResourceLimitsSchema,
  factoryTimestampSchema,
  type FactoryAgentRunRequest,
  type FactoryExecutionRole,
  type FactoryLedgerArtifactExecution,
  type FactoryLedgerOperation,
  type FactoryLedgerOperationResult,
  type FactoryResourceLimits,
  type ImmutableTaskContract,
  type Sha256Digest
} from "@agentlab/contracts";

import type { FactoryAgentExecutionOutput } from "../domain/factory-agent-executor.js";
import type { CanonicalFactoryDocument } from "../domain/factory-documents.js";
import { factoryTimestampDifferenceSeconds } from "../domain/factory-timestamp.js";
import type { FactoryTaskSnapshot } from "../domain/factory-task-repository.js";
import type {
  FactoryWorkspace,
  FactoryWorkspaceManager,
  FactoryWorkspacePatch
} from "../domain/factory-workspace.js";

type AgentResult = Extract<FactoryLedgerOperationResult, { kind: "agent" }>;

export interface FactoryLedgerExecutionPrincipal {
  readonly principal: FactoryLedgerOperation["principal"];
  readonly workerPolicyDigest: Sha256Digest;
}

export interface FactoryLedgerExecutionResult {
  readonly job: CanonicalFactoryDocument<FactoryLedgerOperation>;
  readonly result: CanonicalFactoryDocument<AgentResult>;
  readonly output: FactoryAgentExecutionOutput;
  readonly patch: FactoryWorkspacePatch;
}

export interface FactoryLedgerExecutionTransport {
  enqueue(job: CanonicalFactoryDocument<FactoryLedgerOperation>): Promise<Sha256Digest>;
  awaitResult(
    job: CanonicalFactoryDocument<FactoryLedgerOperation>,
    expiresAt: string
  ): Promise<CanonicalFactoryDocument<FactoryLedgerOperationResult>>;
}

export interface FactoryLedgerExecutionBridgeDependencies {
  readonly transport: FactoryLedgerExecutionTransport;
  readonly workspaces: FactoryWorkspaceManager;
  readonly principals: readonly FactoryLedgerExecutionPrincipal[];
  readonly digest: (bytes: Uint8Array) => Sha256Digest;
  readonly encode: <T>(value: T) => CanonicalFactoryDocument<T>;
  readonly now: () => string;
  readonly cleanupReserveSeconds?: number;
  readonly expiresAt?: (input: {
    readonly task: FactoryTaskSnapshot;
    readonly now: string;
    readonly maximumRunSeconds: number;
    readonly cleanupReserveSeconds: number;
  }) => string;
}

/**
 * Turns a journaled agent operation into one immutable ledger job and applies only the
 * worker's verified result back to the captain's exact workspace.
 */
export class FactoryLedgerExecutionBridge {
  readonly #cleanupReserveSeconds: number;

  public constructor(private readonly dependencies: FactoryLedgerExecutionBridgeDependencies) {
    const cleanupReserveSeconds = dependencies.cleanupReserveSeconds ?? 30;
    if (
      !Number.isSafeInteger(cleanupReserveSeconds) ||
      cleanupReserveSeconds < 30 ||
      cleanupReserveSeconds > 300
    ) {
      throw new Error("Ledger execution cleanup reserve must be between 30 and 300 seconds.");
    }
    this.#cleanupReserveSeconds = cleanupReserveSeconds;
  }

  public async execute(input: {
    readonly task: FactoryTaskSnapshot;
    readonly workspace: FactoryWorkspace;
    readonly request: FactoryAgentRunRequest;
    readonly requestDigest: Sha256Digest;
    readonly prompt: string;
    readonly providerVersion: string;
    readonly role: FactoryExecutionRole;
    readonly budget: ImmutableTaskContract["budget"];
    readonly attempt: number;
    readonly seedPatch: FactoryWorkspacePatch | null;
    readonly execution: FactoryLedgerArtifactExecution;
    readonly resourceLimits: FactoryResourceLimits;
  }): Promise<FactoryLedgerExecutionResult> {
    const request = factoryAgentRunRequestSchema.parse(input.request);
    const requestDocument = this.dependencies.encode(request);
    if (requestDocument.digest !== input.requestDigest) {
      throw new Error("Ledger request digest differs from its canonical agent request.");
    }
    if (
      request.taskId !== input.task.contract.taskId ||
      request.contractDigest !== input.task.contractDigest ||
      request.role !== input.role ||
      request.attempt !== input.attempt ||
      request.repository.id !== input.task.contract.repository.id ||
      request.repository.baseRevision !== input.task.contract.repository.baseRevision
    ) {
      throw new Error("Ledger request does not match its task and execution coordinates.");
    }
    if (
      input.workspace.taskId !== input.task.contract.taskId ||
      input.workspace.attempt !== input.attempt ||
      input.workspace.repositoryRoot === "" ||
      input.workspace.baseRevision !== input.task.contract.repository.baseRevision
    ) {
      throw new Error("Ledger workspace does not match its task and execution coordinates.");
    }
    const promptBytes = new TextEncoder().encode(input.prompt);
    if (
      promptBytes.byteLength !== request.promptArtifact.sizeBytes ||
      this.dependencies.digest(promptBytes) !== request.promptArtifact.digest
    ) {
      throw new Error("Ledger prompt bytes differ from the immutable request artifact.");
    }
    if (input.providerVersion.trim() === "") {
      throw new Error("Ledger operation requires a pinned provider version.");
    }
    if (input.budget.maxOutputBytes > maximumLedgerArtifactBytes) {
      throw new Error("Ledger operation output budget exceeds the bounded artifact transport.");
    }
    const now = factoryTimestampSchema.parse(this.dependencies.now());
    const principal = this.#principal(input.role);
    const maximumRunSeconds = input.budget.wallClockSeconds;
    const expiresAt = factoryTimestampSchema.parse(
      this.dependencies.expiresAt?.({
        task: input.task,
        now,
        maximumRunSeconds,
        cleanupReserveSeconds: this.#cleanupReserveSeconds
      }) ?? input.task.contract.expiresAt
    );
    if (
      now >= expiresAt ||
      expiresAt > input.task.contract.expiresAt ||
      factoryTimestampDifferenceSeconds(now, expiresAt) <
        maximumRunSeconds + this.#cleanupReserveSeconds
    ) {
      throw new Error("Ledger operation deadline is outside the immutable task budget.");
    }
    const resourceLimits = factoryResourceLimitsSchema.parse(input.resourceLimits);
    const job = this.dependencies.encode(
      factoryLedgerOperationSchema.parse({
        schemaVersion: "agentlab.ledger-operation.v1",
        kind: "agent",
        jobId: request.executionId,
        taskId: request.taskId,
        contractDigest: request.contractDigest,
        expectedTaskEventDigest: input.task.lastEventDigest,
        execution: input.execution,
        attempt: input.attempt,
        logicalWorkspaceId: input.workspace.id,
        principal: principal.principal,
        workerPolicyDigest: principal.workerPolicyDigest,
        factoryPolicyDigest: input.task.contract.gateProfile.policyDigest,
        repository: input.task.contract.repository,
        createdAt: now,
        expiresAt,
        resourceLimits,
        limits: {
          maximumChangedFiles: input.budget.maxChangedFiles,
          maximumChangedLines: input.budget.maxChangedLines,
          maximumPatchBytes: input.budget.maxOutputBytes,
          maximumResultBytes: input.budget.maxOutputBytes,
          maximumRunSeconds,
          cleanupReserveSeconds: this.#cleanupReserveSeconds
        },
        seedPatch: input.seedPatch,
        request,
        prompt: input.prompt,
        providerVersion: input.providerVersion
      })
    );
    const enqueuedDigest = await this.dependencies.transport.enqueue(job);
    if (enqueuedDigest !== job.digest) {
      throw new Error("Ledger dispatcher did not acknowledge the exact immutable job.");
    }
    const result = await this.dependencies.transport.awaitResult(job, expiresAt);
    const parsedResult = this.#validateResult(job, result, input);
    const current = await this.#collect(input.workspace, job.value);
    const expectedCurrent = input.seedPatch;
    if (expectedCurrent === null) {
      if (current.patch !== "" || current.changeSet.changedFiles !== 0) {
        throw new Error("Captain workspace was not clean before the brokered operation.");
      }
    } else if (!samePatch(this.dependencies.encode, current, expectedCurrent)) {
      throw new Error("Captain workspace no longer matches the immutable seed patch.");
    }
    if (!samePatch(this.dependencies.encode, current, parsedResult.value.patch)) {
      if (expectedCurrent !== null && expectedCurrent.patch !== "") {
        await this.dependencies.workspaces.apply(
          input.workspace,
          expectedCurrent.patch,
          job.value.limits.maximumPatchBytes,
          "reverse"
        );
      }
      if (parsedResult.value.patch.patch !== "") {
        await this.dependencies.workspaces.apply(
          input.workspace,
          parsedResult.value.patch.patch,
          job.value.limits.maximumPatchBytes,
          "forward"
        );
      }
      const applied = await this.#collect(input.workspace, job.value);
      if (!samePatch(this.dependencies.encode, applied, parsedResult.value.patch)) {
        throw new Error("Captain workspace differs from the verified worker result.");
      }
    }
    return {
      job,
      result: parsedResult,
      output: parsedResult.value.output,
      patch: parsedResult.value.patch
    };
  }

  #principal(role: FactoryExecutionRole): FactoryLedgerExecutionPrincipal {
    const kind = role === "reviewer" ? "reviewer" : "implementer";
    const matches = this.dependencies.principals.filter(({ principal }) => principal.kind === kind);
    if (matches.length !== 1) {
      throw new Error(`Ledger requires exactly one ${kind} worker principal.`);
    }
    return matches[0] as FactoryLedgerExecutionPrincipal;
  }

  #validateResult(
    job: CanonicalFactoryDocument<FactoryLedgerOperation>,
    inputResult: CanonicalFactoryDocument<FactoryLedgerOperationResult>,
    input: {
      readonly task: FactoryTaskSnapshot;
      readonly role: FactoryExecutionRole;
      readonly seedPatch: FactoryWorkspacePatch | null;
      readonly execution: FactoryLedgerArtifactExecution;
    }
  ): CanonicalFactoryDocument<AgentResult> {
    const parsed = factoryLedgerOperationResultSchema.parse(inputResult.value);
    const result = this.dependencies.encode(parsed);
    const jobValue = job.value;
    if (jobValue.kind !== "agent") {
      throw new Error("Ledger worker returned an agent result for a non-agent operation.");
    }
    if (
      result.digest !== inputResult.digest ||
      result.json !== inputResult.json ||
      parsed.kind !== "agent" ||
      parsed.jobId !== jobValue.jobId ||
      parsed.jobDigest !== job.digest ||
      parsed.output.providerVersion !== jobValue.providerVersion ||
      parsed.output.errorCode === "process-cleanup-failed" ||
      parsed.completedAt < parsed.output.finishedAt ||
      parsed.completedAt >= jobValue.expiresAt ||
      parsed.output.startedAt < jobValue.createdAt ||
      parsed.output.finishedAt < parsed.output.startedAt ||
      parsed.output.isolation.isolationId !== jobValue.jobId ||
      parsed.output.isolation.scopeName !==
        `agentlab-factory-${jobValue.jobId.replaceAll("-", "")}.scope` ||
      parsed.output.isolation.limits.maxMemoryBytes > jobValue.resourceLimits.maxMemoryBytes ||
      parsed.output.isolation.limits.maxProcesses > jobValue.resourceLimits.maxProcesses ||
      parsed.output.isolation.limits.cpuQuotaPercent > jobValue.resourceLimits.cpuQuotaPercent ||
      parsed.patch.changeSet.baseRevision !== jobValue.repository.baseRevision ||
      parsed.patch.changeSet.headRevision !== null ||
      parsed.patch.changeSet.changedFiles > jobValue.limits.maximumChangedFiles ||
      parsed.patch.changeSet.changedLines > jobValue.limits.maximumChangedLines ||
      new TextEncoder().encode(parsed.patch.patch).byteLength > jobValue.limits.maximumPatchBytes ||
      (input.role === "reviewer" &&
        (input.seedPatch === null
          ? parsed.patch.patch !== "" || parsed.patch.changeSet.changedFiles !== 0
          : !samePatch(this.dependencies.encode, parsed.patch, input.seedPatch))) ||
      job.value.expectedTaskEventDigest !== input.task.lastEventDigest
    ) {
      throw new Error("Ledger worker result is not bound to the immutable operation.");
    }
    return result as CanonicalFactoryDocument<AgentResult>;
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

function samePatch<Left, Right>(
  encode: <Value>(value: Value) => CanonicalFactoryDocument<Value>,
  left: Left,
  right: Right
): boolean {
  return encode(left).digest === encode(right).digest;
}
