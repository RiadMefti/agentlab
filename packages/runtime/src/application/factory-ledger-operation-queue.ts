import {
  factoryLedgerOperationSchema,
  factoryLedgerOperationResultSchema,
  factoryLedgerOperationPolicySchema,
  factoryLedgerArtifactPolicySchema,
  factoryLedgerOperationRequestSchema,
  factoryLedgerReadPolicySchema,
  factoryTimestampSchema,
  type FactoryLedgerOperation,
  type FactoryLedgerOperationPolicy,
  type FactoryLedgerOperationResponse,
  type FactoryLedgerReadPolicy,
  type Sha256Digest
} from "@agentlab/contracts";

import { ConflictError } from "../domain/errors.js";
import {
  FactoryArtifactNotFoundError,
  type FactoryArtifactStore
} from "../domain/factory-artifact-store.js";
import { factoryBudgetFits, factoryCapabilitiesFit } from "../domain/factory-authority-limits.js";
import type { CanonicalFactoryDocument } from "../domain/factory-documents.js";
import type {
  FactoryLedgerArtifactContexts,
  FactoryLedgerArtifactRepository,
  FactoryArtifactWireCodec
} from "../domain/factory-ledger-artifacts.js";
import type {
  FactoryLedgerOperationQueueRepository,
  FactoryLedgerQueuedOperation
} from "../domain/factory-ledger-operation-queue.js";

export interface FactoryLedgerOperationQueueDependencies {
  readonly peerPolicy: FactoryLedgerReadPolicy;
  readonly peerPolicyDigest: Sha256Digest;
  readonly policy: FactoryLedgerOperationPolicy;
  readonly policyDigest: Sha256Digest;
  readonly artifactPolicy: import("@agentlab/contracts").FactoryLedgerArtifactPolicy;
  readonly artifactPolicyDigest: Sha256Digest;
  readonly contexts: FactoryLedgerArtifactContexts;
  readonly repository: FactoryLedgerOperationQueueRepository;
  readonly artifactReservations: FactoryLedgerArtifactRepository;
  readonly artifacts: FactoryArtifactStore;
  readonly wire: FactoryArtifactWireCodec;
  readonly encode: <T>(value: T) => CanonicalFactoryDocument<T>;
  readonly now: () => string;
}

/** Only the trusted owner enqueues; a leaf can consume its exact job and submit a bounded claim. */
export class FactoryLedgerOperationQueue {
  readonly #peers: FactoryLedgerReadPolicy;
  readonly #policy: FactoryLedgerOperationPolicy;
  public constructor(private readonly dependencies: FactoryLedgerOperationQueueDependencies) {
    this.#peers = factoryLedgerReadPolicySchema.parse(dependencies.peerPolicy);
    this.#policy = factoryLedgerOperationPolicySchema.parse(dependencies.policy);
    const artifactPolicy = factoryLedgerArtifactPolicySchema.parse(dependencies.artifactPolicy);
    if (
      dependencies.encode(this.#peers).digest !== dependencies.peerPolicyDigest ||
      dependencies.encode(this.#policy).digest !== dependencies.policyDigest ||
      dependencies.encode(artifactPolicy).digest !== dependencies.artifactPolicyDigest ||
      this.#policy.principals.some(
        (principal) =>
          !this.#peers.principals.some(
            (peer) =>
              peer.uid === principal.uid && peer.id === principal.id && peer.role === "worker"
          )
      )
    )
      throw new Error(
        "Operation grants require matching separated worker principals and canonical policy pins."
      );
    this.#artifactPolicy = artifactPolicy;
  }

  readonly #artifactPolicy: import("@agentlab/contracts").FactoryLedgerArtifactPolicy;

  /** Internal owner capability, deliberately absent from the socket request union. */
  public async enqueue(
    input: CanonicalFactoryDocument<FactoryLedgerOperation>
  ): Promise<FactoryLedgerQueuedOperation> {
    const job = this.dependencies.encode(factoryLedgerOperationSchema.parse(input.value));
    if (
      job.digest !== input.digest ||
      job.json !== input.json ||
      !this.#assigned(job.value) ||
      !(await this.#current(job.value))
    )
      throw new ConflictError(
        "Operation is not assigned to the current immutable execution and policies."
      );
    const { maximumTaskJobs, maximumTotalJobs, maximumStoredJobBytes } = this.#policy;
    return this.dependencies.repository.enqueue(
      job,
      { maximumTaskJobs, maximumTotalJobs, maximumStoredJobBytes },
      this.dependencies.now
    );
  }

  public async execute(uid: number, input: unknown): Promise<FactoryLedgerOperationResponse> {
    const parsed = factoryLedgerOperationRequestSchema.safeParse(input);
    const denied = {
      schemaVersion: "agentlab.ledger-operation-response.v1" as const,
      requestId: parsed.success ? parsed.data.requestId : null,
      status: "denied" as const
    };
    const now = factoryTimestampSchema.parse(this.dependencies.now());
    const peer = this.#peers.principals.find((entry) => entry.uid === uid);
    const principal = this.#policy.principals.find((entry) => entry.uid === uid);
    if (
      !parsed.success ||
      peer === undefined ||
      principal === undefined ||
      now >= this.#peers.expiresAt ||
      now >= this.#policy.expiresAt ||
      parsed.data.peerPolicyDigest !== this.dependencies.peerPolicyDigest ||
      parsed.data.operationPolicyDigest !== this.dependencies.policyDigest ||
      !peer.tasks.some(
        (task) =>
          task.taskId === parsed.data.taskId && task.contractDigest === parsed.data.contractDigest
      )
    )
      return denied;
    const request = parsed.data;
    const task = await this.dependencies.contexts.task(request.taskId);
    if (task?.contractDigest !== request.contractDigest) return denied;
    const candidateIds =
      request.operation === "operation.next"
        ? await this.dependencies.repository.nextCandidateIds(
            uid,
            request.taskId,
            request.contractDigest,
            256
          )
        : [];
    const snapshot =
      request.operation === "operation.next"
        ? await this.#nextEligible(candidateIds)
        : await this.dependencies.repository.find(request.jobId);
    if (snapshot === null)
      return request.operation === "operation.next" ? { ...denied, status: "empty" } : denied;
    const job = snapshot.job.value;
    if (
      !this.#assigned(job) ||
      job.principal.uid !== uid ||
      job.taskId !== request.taskId ||
      job.contractDigest !== request.contractDigest ||
      (request.operation !== "operation.next" && snapshot.job.digest !== request.jobDigest)
    )
      return denied;
    try {
      if (request.operation === "operation.next" || request.operation === "operation.inspect")
        return response(denied.requestId, snapshot, false);
      if (request.operation === "operation.claim") {
        if (snapshot.claim === null && !(await this.#current(job))) return denied;
        const claimed = await this.dependencies.repository.claim(
          job.jobId,
          snapshot.job.digest,
          uid,
          request.invocationId,
          this.dependencies.now
        );
        return response(denied.requestId, claimed.snapshot, claimed.newlyClaimed);
      }
      if (
        snapshot.claim?.digest !== request.claimDigest ||
        (snapshot.receipt === null && !(await this.#current(job)))
      )
        return denied;
      const reservation = await this.dependencies.artifactReservations.find(
        uid,
        request.artifactReservationKey
      );
      const upload = reservation?.value.intent.upload;
      if (
        reservation?.digest !== request.artifactReservationDigest ||
        upload === undefined ||
        reservation.value.intent.principalId !== principal.id ||
        reservation.value.intent.principalKind !== principal.kind ||
        upload.taskId !== job.taskId ||
        upload.contractDigest !== job.contractDigest ||
        upload.operationId !== job.jobId ||
        upload.attempt !== job.attempt ||
        upload.expectedTaskEventDigest !== job.expectedTaskEventDigest ||
        this.dependencies.encode(upload.execution).digest !==
          this.dependencies.encode(job.execution).digest ||
        upload.artifact.mediaType !== "application/vnd.agentlab.ledger-operation-result+json" ||
        upload.artifact.sizeBytes > job.limits.maximumResultBytes
      )
        return denied;
      const bytes = await this.dependencies.artifacts.read(
        upload.artifact.digest,
        Math.max(1, upload.artifact.sizeBytes)
      );
      if (
        bytes.byteLength !== upload.artifact.sizeBytes ||
        this.dependencies.wire.digest(bytes) !== upload.artifact.digest
      )
        throw new Error("Operation result artifact failed reserved content verification.");
      let json: string;
      let untrusted: unknown;
      try {
        json = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        untrusted = JSON.parse(json) as unknown;
      } catch {
        return denied;
      }
      const parsedResult = factoryLedgerOperationResultSchema.safeParse(untrusted);
      if (!parsedResult.success) return denied;
      const result = this.dependencies.encode(parsedResult.data);
      const value = result.value;
      const isolation = value.output.isolation;
      const protectedPatch = job.kind === "gate" || job.principal.kind === "reviewer";
      if (
        result.json !== json ||
        result.digest !== upload.artifact.digest ||
        value.jobId !== job.jobId ||
        value.jobDigest !== snapshot.job.digest ||
        value.kind !== job.kind ||
        value.completedAt < value.output.finishedAt ||
        value.completedAt >= job.expiresAt ||
        value.output.startedAt < snapshot.claim.value.claimedAt ||
        value.output.finishedAt < value.output.startedAt ||
        value.completedAt > now ||
        (value.kind === "agent" && value.output.errorCode === "process-cleanup-failed") ||
        isolation.isolationId !== job.jobId ||
        isolation.scopeName !== `agentlab-factory-${job.jobId.replaceAll("-", "")}.scope` ||
        isolation.limits.maxMemoryBytes > job.resourceLimits.maxMemoryBytes ||
        isolation.limits.maxProcesses > job.resourceLimits.maxProcesses ||
        isolation.limits.cpuQuotaPercent > job.resourceLimits.cpuQuotaPercent ||
        value.patch.changeSet.baseRevision !== job.repository.baseRevision ||
        value.patch.changeSet.headRevision !== null ||
        value.patch.changeSet.changedFiles > job.limits.maximumChangedFiles ||
        value.patch.changeSet.changedLines > job.limits.maximumChangedLines ||
        new TextEncoder().encode(value.patch.patch).byteLength > job.limits.maximumPatchBytes ||
        (job.kind === "agent" &&
          value.kind === "agent" &&
          value.output.providerVersion !== job.providerVersion) ||
        (job.kind === "gate" && value.kind === "gate" && value.output.gateId !== job.gateId) ||
        (protectedPatch &&
          (job.seedPatch === null
            ? value.patch.patch !== "" || value.patch.changeSet.changedFiles !== 0
            : this.dependencies.encode(value.patch).digest !==
              this.dependencies.encode(job.seedPatch).digest))
      )
        return denied;
      const reported = await this.dependencies.repository.report(
        {
          schemaVersion: "agentlab.ledger-operation-receipt.v1",
          jobId: job.jobId,
          jobDigest: snapshot.job.digest,
          claimDigest: request.claimDigest,
          principalUid: uid,
          artifactReservationDigest: reservation.digest,
          resultArtifact: upload.artifact
        },
        this.dependencies.now
      );
      return response(denied.requestId, reported, false);
    } catch (error: unknown) {
      if (error instanceof ConflictError || error instanceof FactoryArtifactNotFoundError)
        return denied;
      throw error;
    }
  }

  async #nextEligible(
    candidateIds: readonly string[]
  ): Promise<FactoryLedgerQueuedOperation | null> {
    for (const jobId of candidateIds) {
      const candidate = await this.dependencies.repository.find(jobId);
      if (candidate === null) continue;
      const job = candidate.job.value;
      if (!this.#assigned(job)) continue;
      // An unresolved claim is returned for reconciliation even when its execution deadline
      // or task state has moved on. A pending job must still bind to the live journal head.
      if (candidate.claim !== null || (await this.#current(job))) return candidate;
    }
    return null;
  }

  #assigned(job: FactoryLedgerOperation): boolean {
    const now = factoryTimestampSchema.parse(this.dependencies.now());
    const principal = this.#policy.principals.find(({ uid }) => uid === job.principal.uid);
    return (
      now < this.#policy.expiresAt &&
      now < this.#peers.expiresAt &&
      principal?.id === job.principal.id &&
      principal.kind === job.principal.kind &&
      principal.workerPolicyDigest === job.workerPolicyDigest &&
      job.expiresAt <= this.#policy.expiresAt &&
      job.expiresAt <= this.#peers.expiresAt &&
      job.expiresAt <= this.#artifactPolicy.expiresAt &&
      this.#peers.principals.some(
        (peer) =>
          peer.uid === job.principal.uid &&
          peer.tasks.some(
            (task) => task.taskId === job.taskId && task.contractDigest === job.contractDigest
          )
      )
    );
  }

  async #current(job: FactoryLedgerOperation): Promise<boolean> {
    const task = await this.dependencies.contexts.task(job.taskId);
    const now = factoryTimestampSchema.parse(this.dependencies.now());
    if (
      task?.contractDigest !== job.contractDigest ||
      task.lastEventDigest !== job.expectedTaskEventDigest ||
      !["executing", "repairing", "verifying", "reviewing"].includes(task.state) ||
      now < job.createdAt ||
      now >= job.expiresAt ||
      job.expiresAt > task.contract.expiresAt ||
      job.factoryPolicyDigest !== task.contract.gateProfile.policyDigest ||
      job.repository.id !== task.contract.repository.id ||
      job.repository.baseRevision !== task.contract.repository.baseRevision ||
      job.resourceLimits.maxProcesses > task.contract.budget.maxProcesses ||
      job.limits.maximumChangedFiles > task.contract.budget.maxChangedFiles ||
      job.limits.maximumChangedLines > task.contract.budget.maxChangedLines ||
      job.limits.maximumResultBytes > task.contract.budget.maxOutputBytes ||
      job.limits.maximumResultBytes > this.#artifactPolicy.maximumArtifactBytes
    )
      return false;
    if (
      job.kind === "agent" &&
      (!factoryBudgetFits(job.request.budget, task.contract.budget) ||
        !factoryCapabilitiesFit(job.request.capabilities, task.contract.capabilities) ||
        !task.contract.agentPolicy.workerProfiles.some(
          (profile) =>
            profile.provider === job.request.provider &&
            profile.model === job.request.model &&
            profile.reasoning === job.request.reasoning &&
            profile.roles.includes(job.request.role)
        ))
    )
      return false;
    const execution = await this.dependencies.contexts.execution(job.taskId, job.execution);
    const event = execution?.lastEvent;
    return (
      execution?.run.runId === job.execution.runId &&
      execution.runDigest === job.execution.runDigest &&
      execution.run.taskId === job.taskId &&
      execution.run.contractDigest === job.contractDigest &&
      execution.lastEventDigest === job.execution.eventDigest &&
      event?.kind === "operation-started" &&
      event.operationId === job.jobId &&
      event.attempt === job.attempt &&
      event.workspaceId === job.logicalWorkspaceId &&
      event.operationKind === job.kind &&
      (job.kind === "agent"
        ? event.role === job.request.role &&
          event.requestDigest === this.dependencies.encode(job.request).digest
        : event.gateId === job.gateId)
    );
  }
}

function response(
  requestId: string | null,
  snapshot: FactoryLedgerQueuedOperation,
  newlyClaimed: boolean
): FactoryLedgerOperationResponse {
  return {
    schemaVersion: "agentlab.ledger-operation-response.v1",
    requestId,
    status: "job",
    job: snapshot.job.value,
    jobDigest: snapshot.job.digest,
    claim: snapshot.claim?.value ?? null,
    claimDigest: snapshot.claim?.digest ?? null,
    receipt: snapshot.receipt?.value ?? null,
    receiptDigest: snapshot.receipt?.digest ?? null,
    newlyClaimed
  };
}
