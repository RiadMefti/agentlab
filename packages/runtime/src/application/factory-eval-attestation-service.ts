import { factoryTimestampSchema, sha256DigestSchema, type Sha256Digest } from "@agentlab/contracts";
import { z } from "zod";

import { ConflictError, NotFoundError } from "../domain/errors.js";
import type { FactoryDsseVerifier } from "../domain/factory-eval-attestation-crypto.js";
import {
  assertFactoryEvalAttestationTiming,
  assertFactoryEvalAttestationTimingPolicy,
  type FactoryEvalAttestationTimingPolicy
} from "../domain/factory-eval-attestation-policy.js";
import {
  assertFactoryEvalAttestationRecord,
  assertFactorySignedEvalAttestation
} from "../domain/factory-eval-attestation-integrity.js";
import type {
  FactoryEvalAttestationRepository,
  FactoryEvalAttestationSnapshot
} from "../domain/factory-eval-attestation-repository.js";
import type { FactoryDocumentCodec } from "../domain/factory-documents.js";
import type {
  FactoryEvaluationRepository,
  FactoryEvalSnapshot
} from "../domain/factory-evaluation-repository.js";

const recordCommandSchema = z
  .object({
    assessmentDigest: sha256DigestSchema,
    signedAttestation: z.unknown()
  })
  .strict();

export interface FactoryEvalAttestationRecordResult extends FactoryEvalAttestationSnapshot {
  readonly schemaVersion: "agentlab.eval-attestation-result.v1";
  readonly status: "recorded" | "existing";
}

export interface FactoryEvalAttestationServiceDependencies {
  readonly evaluations: Pick<FactoryEvaluationRepository, "findByRunId" | "findByAssessmentDigest">;
  readonly attestations: FactoryEvalAttestationRepository;
  readonly verifier: FactoryDsseVerifier;
  readonly maximumIssuanceDelaySeconds: number;
  readonly maximumAttestationLifetimeSeconds: number;
  readonly documents: Pick<
    FactoryDocumentCodec,
    | "evalRun"
    | "evalAttestationStatement"
    | "dsseEnvelope"
    | "signedEvalAttestation"
    | "evalAttestationRecord"
  >;
  readonly now: () => string;
  readonly createId: () => string;
}

/** Verifies DSSE bytes and semantic run lineage before writing one immutable trust record. */
export class FactoryEvalAttestationService {
  readonly #timingPolicy: FactoryEvalAttestationTimingPolicy;

  public constructor(private readonly dependencies: FactoryEvalAttestationServiceDependencies) {
    this.#timingPolicy = {
      maximumIssuanceDelaySeconds: dependencies.maximumIssuanceDelaySeconds,
      maximumAttestationLifetimeSeconds: dependencies.maximumAttestationLifetimeSeconds
    };
    assertFactoryEvalAttestationTimingPolicy(this.#timingPolicy);
  }

  public async record(input: unknown): Promise<FactoryEvalAttestationRecordResult> {
    const command = recordCommandSchema.parse(input);
    const evaluation = await this.dependencies.evaluations.findByAssessmentDigest(
      command.assessmentDigest
    );
    if (evaluation === null) {
      throw new NotFoundError(
        `Factory eval assessment ${command.assessmentDigest} does not exist.`
      );
    }
    const run = this.dependencies.documents.evalRun(evaluation.run);
    if (run.digest !== evaluation.runDigest) {
      throw new Error("Factory eval repository returned a non-canonical run digest.");
    }
    const signed = this.dependencies.documents.signedEvalAttestation(command.signedAttestation);
    const existing = await this.dependencies.attestations.findByRunDigest(run.digest);
    if (existing !== null) {
      if (existing.attestation.signedAttestationDigest !== signed.digest) {
        throw new ConflictError(
          "Factory eval run already has a different immutable signed attestation."
        );
      }
      await this.#verifySnapshot(existing, evaluation, this.#now());
      return result("existing", existing);
    }
    const verifiedAt = this.#now();
    const verification = await this.dependencies.verifier.verify(signed.value.envelope);
    assertFactorySignedEvalAttestation(run, signed, verification, this.dependencies.documents);
    const predicate = signed.value.statement.predicate;
    assertFactoryEvalAttestationTiming(
      predicate.completedAt,
      predicate.issuedAt,
      predicate.expiresAt,
      this.#timingPolicy
    );
    if (verifiedAt < predicate.issuedAt || verifiedAt >= predicate.expiresAt) {
      throw new ConflictError("Factory eval attestation is not currently valid.");
    }
    const record = this.dependencies.documents.evalAttestationRecord({
      schemaVersion: "agentlab.eval-attestation-record.v1",
      attestationId: this.dependencies.createId(),
      assessmentDigest: evaluation.assessmentDigest,
      runId: run.value.runId,
      runDigest: run.digest,
      signedAttestationDigest: signed.digest,
      statementDigest: signed.value.statementDigest,
      envelopeDigest: signed.value.envelopeDigest,
      keyId: verification.keyId,
      verifiedAt,
      verifier: {
        kind: "control-plane",
        role: "policy-engine",
        id: "agentlab-eval-attestation",
        sessionId: null
      },
      signedAttestation: signed.value
    });
    assertFactoryEvalAttestationRecord(
      run,
      evaluation.assessmentDigest,
      record,
      signed.digest,
      verification,
      this.dependencies.documents
    );
    try {
      return result("recorded", await this.dependencies.attestations.record(record));
    } catch (error: unknown) {
      const raced = await this.dependencies.attestations.findByRunDigest(run.digest);
      if (raced === null) throw error;
      if (raced.attestation.signedAttestationDigest !== signed.digest) throw error;
      await this.#verifySnapshot(raced, evaluation, verifiedAt);
      return result("existing", raced);
    }
  }

  public async requireVerified(
    runDigestInput: Sha256Digest,
    validAtInput?: string
  ): Promise<FactoryEvalAttestationSnapshot> {
    const runDigest = sha256DigestSchema.parse(runDigestInput);
    const snapshot = await this.dependencies.attestations.findByRunDigest(runDigest);
    if (snapshot === null) {
      throw new ConflictError(`Factory eval run ${runDigest} has no verified attestation.`);
    }
    const evaluation = await this.dependencies.evaluations.findByRunId(snapshot.attestation.runId);
    if (evaluation?.runDigest !== runDigest) {
      throw new Error("Factory eval attestation is missing its exact assessed run.");
    }
    await this.#verifySnapshot(
      snapshot,
      evaluation,
      validAtInput === undefined ? this.#now() : factoryTimestampSchema.parse(validAtInput)
    );
    return snapshot;
  }

  async #verifySnapshot(
    snapshot: FactoryEvalAttestationSnapshot,
    evaluation: FactoryEvalSnapshot,
    validAt: string
  ): Promise<void> {
    const run = this.dependencies.documents.evalRun(evaluation.run);
    const record = this.dependencies.documents.evalAttestationRecord(snapshot.attestation);
    if (record.digest !== snapshot.attestationDigest) {
      throw new Error("Stored factory eval attestation digest is not canonical.");
    }
    const signed = this.dependencies.documents.signedEvalAttestation(
      record.value.signedAttestation
    );
    const verification = await this.dependencies.verifier.verify(signed.value.envelope);
    assertFactoryEvalAttestationRecord(
      run,
      evaluation.assessmentDigest,
      record,
      signed.digest,
      verification,
      this.dependencies.documents
    );
    const predicate = signed.value.statement.predicate;
    assertFactoryEvalAttestationTiming(
      predicate.completedAt,
      predicate.issuedAt,
      predicate.expiresAt,
      this.#timingPolicy
    );
    if (validAt < predicate.issuedAt || validAt >= predicate.expiresAt) {
      throw new ConflictError("Verified factory eval attestation is outside its validity window.");
    }
  }

  #now(): string {
    return factoryTimestampSchema.parse(this.dependencies.now());
  }
}

function result(
  status: FactoryEvalAttestationRecordResult["status"],
  snapshot: FactoryEvalAttestationSnapshot
): FactoryEvalAttestationRecordResult {
  return {
    schemaVersion: "agentlab.eval-attestation-result.v1",
    status,
    ...snapshot
  };
}
