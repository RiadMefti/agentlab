import {
  factoryLedgerArtifactIntentSchema,
  factoryLedgerArtifactPolicySchema,
  factoryLedgerArtifactRequestSchema,
  factoryLedgerReadPolicySchema,
  factoryTimestampSchema,
  type FactoryLedgerArtifactPolicy,
  type FactoryLedgerArtifactResponse,
  type FactoryLedgerReadPolicy,
  type Sha256Digest
} from "@agentlab/contracts";

import { ConflictError } from "../domain/errors.js";
import {
  FactoryArtifactNotFoundError,
  type FactoryArtifactStore
} from "../domain/factory-artifact-store.js";
import type { CanonicalFactoryDocument } from "../domain/factory-documents.js";
import type {
  FactoryArtifactWireCodec,
  FactoryLedgerArtifactContexts,
  FactoryLedgerArtifactRepository
} from "../domain/factory-ledger-artifacts.js";
import { factoryTimestampDifferenceSeconds } from "../domain/factory-timestamp.js";

export interface FactoryLedgerArtifactDependencies {
  readonly peerPolicy: FactoryLedgerReadPolicy;
  readonly peerPolicyDigest: Sha256Digest;
  readonly policy: FactoryLedgerArtifactPolicy;
  readonly policyDigest: Sha256Digest;
  readonly contexts: FactoryLedgerArtifactContexts;
  readonly repository: FactoryLedgerArtifactRepository;
  readonly artifacts: FactoryArtifactStore;
  readonly wire: FactoryArtifactWireCodec;
  readonly encode: <T>(value: T) => CanonicalFactoryDocument<T>;
  readonly now: () => string;
}

/** Task-bound byte handoff. Nothing here mints evidence authority or advances a task. */
export class FactoryLedgerArtifacts {
  readonly #peers: FactoryLedgerReadPolicy;
  readonly #policy: FactoryLedgerArtifactPolicy;
  public constructor(private readonly dependencies: FactoryLedgerArtifactDependencies) {
    this.#peers = factoryLedgerReadPolicySchema.parse(dependencies.peerPolicy);
    this.#policy = factoryLedgerArtifactPolicySchema.parse(dependencies.policy);
    if (
      dependencies.encode(this.#peers).digest !== dependencies.peerPolicyDigest ||
      dependencies.encode(this.#policy).digest !== dependencies.policyDigest ||
      this.#policy.principals.some(
        (principal) =>
          !this.#peers.principals.some(
            (peer) =>
              peer.uid === principal.uid &&
              peer.id === principal.id &&
              (principal.kind === "reader" || peer.role === "worker")
          )
      )
    ) {
      throw new Error("Artifact grants must pin matching, separated peer identities.");
    }
  }

  public async execute(uid: number, input: unknown): Promise<FactoryLedgerArtifactResponse> {
    const parsed = factoryLedgerArtifactRequestSchema.safeParse(input);
    const denied = {
      schemaVersion: "agentlab.ledger-artifact-response.v1" as const,
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
      parsed.data.peerPolicyDigest !== this.dependencies.peerPolicyDigest ||
      parsed.data.artifactPolicyDigest !== this.dependencies.policyDigest ||
      now >= this.#peers.expiresAt ||
      now >= this.#policy.expiresAt
    )
      return denied;
    const request = parsed.data;
    const identity = request.operation === "artifact.submit" ? request.upload : request;
    if (
      !peer.tasks.some(
        (grant) =>
          grant.taskId === identity.taskId && grant.contractDigest === identity.contractDigest
      )
    )
      return denied;
    const task = await this.dependencies.contexts.task(identity.taskId);
    if (task?.contractDigest !== identity.contractDigest) return denied;
    if (request.operation === "artifact.read") {
      const artifact = await this.dependencies.repository.artifactReference(
        request.taskId,
        request.contractDigest,
        request.artifactDigest
      );
      if (artifact === null || artifact.sizeBytes > this.#policy.maximumArtifactBytes)
        return denied;
      let bytes: Uint8Array;
      try {
        bytes = await this.dependencies.artifacts.read(
          artifact.digest,
          Math.max(1, artifact.sizeBytes)
        );
      } catch (error: unknown) {
        if (error instanceof FactoryArtifactNotFoundError) return denied;
        throw error;
      }
      if (
        bytes.byteLength !== artifact.sizeBytes ||
        this.dependencies.wire.digest(bytes) !== artifact.digest
      )
        throw new Error("Stored artifact differs from its task-bound reference.");
      return {
        ...denied,
        status: "artifact",
        taskId: request.taskId,
        contractDigest: request.contractDigest,
        artifact,
        contentBase64: this.dependencies.wire.encodeBase64(bytes)
      };
    }
    if (request.operation === "artifact.receipt") {
      const reservation = await this.dependencies.repository.find(uid, request.idempotencyKey);
      if (
        reservation?.value.intentDigest !== request.intentDigest ||
        reservation.value.intent.principalId !== principal.id ||
        reservation.value.intent.upload.taskId !== request.taskId ||
        reservation.value.intent.upload.contractDigest !== request.contractDigest
      )
        return denied;
      const stored = await this.#stored(reservation.value.intent.upload.artifact);
      return {
        ...denied,
        status: "reservation",
        stored,
        reservation: reservation.value,
        reservationDigest: reservation.digest
      };
    }
    const { upload } = request;
    if (
      principal.kind === "reader" ||
      task.contract.expiresAt <= now ||
      upload.expiresAt <= now ||
      upload.expiresAt > task.contract.expiresAt ||
      upload.expiresAt > this.#policy.expiresAt ||
      upload.expiresAt > this.#peers.expiresAt ||
      factoryTimestampDifferenceSeconds(now, upload.expiresAt) > 120 ||
      upload.artifact.sizeBytes > this.#policy.maximumArtifactBytes ||
      upload.expectedTaskEventDigest !== task.lastEventDigest ||
      !["executing", "repairing", "verifying", "reviewing"].includes(task.state)
    )
      return denied;
    const execution = await this.dependencies.contexts.execution(
      task.contract.taskId,
      upload.execution
    );
    const operation = execution?.lastEvent;
    if (
      execution?.runDigest !== upload.execution.runDigest ||
      execution.run.runId !== upload.execution.runId ||
      execution.run.taskId !== task.contract.taskId ||
      execution.run.contractDigest !== task.contractDigest ||
      execution.lastEventDigest !== upload.execution.eventDigest ||
      operation?.kind !== "operation-started" ||
      operation.operationId !== upload.operationId ||
      operation.attempt !== upload.attempt ||
      !matchesProducer(principal.kind, operation)
    )
      return denied;
    let bytes: Uint8Array;
    try {
      bytes = this.dependencies.wire.decodeBase64(request.contentBase64);
    } catch {
      return denied;
    }
    if (
      bytes.byteLength !== upload.artifact.sizeBytes ||
      this.dependencies.wire.digest(bytes) !== upload.artifact.digest
    )
      return denied;
    const intent = this.dependencies.encode(
      factoryLedgerArtifactIntentSchema.parse({
        schemaVersion: "agentlab.ledger-artifact-intent.v1",
        principalUid: uid,
        principalId: principal.id,
        principalKind: principal.kind,
        peerPolicyDigest: request.peerPolicyDigest,
        artifactPolicyDigest: request.artifactPolicyDigest,
        upload
      })
    );
    try {
      const reservation = await this.dependencies.repository.reserve(
        intent,
        {
          maximumTaskBytes: Math.min(
            this.#policy.maximumTaskBytes,
            task.contract.budget.maxOutputBytes
          ),
          maximumTaskArtifacts: this.#policy.maximumTaskArtifacts,
          maximumTotalBytes: this.#policy.maximumTotalBytes,
          maximumTotalArtifacts: this.#policy.maximumTotalArtifacts
        },
        this.dependencies.now
      );
      if (factoryTimestampSchema.parse(this.dependencies.now()) >= upload.expiresAt) return denied;
      const stored = await this.dependencies.artifacts.put(bytes);
      if (
        stored.digest !== upload.artifact.digest ||
        stored.sizeBytes !== upload.artifact.sizeBytes
      )
        throw new Error("Artifact storage did not preserve its reserved content identity.");
      return {
        ...denied,
        status: "reservation",
        stored: true,
        reservation: reservation.value,
        reservationDigest: reservation.digest
      };
    } catch (error: unknown) {
      if (error instanceof ConflictError) return denied;
      throw error;
    }
  }

  async #stored(artifact: { digest: Sha256Digest; sizeBytes: number }): Promise<boolean> {
    if (artifact.sizeBytes > this.#policy.maximumArtifactBytes) return false;
    try {
      const bytes = await this.dependencies.artifacts.read(
        artifact.digest,
        Math.max(1, artifact.sizeBytes)
      );
      if (
        bytes.byteLength !== artifact.sizeBytes ||
        this.dependencies.wire.digest(bytes) !== artifact.digest
      )
        throw new Error("Reserved artifact failed content verification.");
      return true;
    } catch (error: unknown) {
      if (error instanceof FactoryArtifactNotFoundError) return false;
      throw error;
    }
  }
}

function matchesProducer(
  kind: "implementer" | "reviewer" | "gate-observer",
  operation: {
    operationKind: "agent" | "gate";
    role: "implementer" | "repairer" | "reviewer" | null;
  }
): boolean {
  return kind === "gate-observer"
    ? operation.operationKind === "gate"
    : operation.operationKind === "agent" &&
        (kind === "reviewer"
          ? operation.role === "reviewer"
          : operation.role === "implementer" || operation.role === "repairer");
}
