import { DatabaseSync } from "node:sqlite";

import type { FactoryEvalAttestationRecord, Sha256Digest } from "@agentlab/contracts";

import type { FactoryDsseVerifier } from "../../domain/factory-eval-attestation-crypto.js";
import { assertFactoryEvalAttestationRecord } from "../../domain/factory-eval-attestation-integrity.js";
import type {
  FactoryEvalAttestationRepository,
  FactoryEvalAttestationSnapshot
} from "../../domain/factory-eval-attestation-repository.js";
import type {
  CanonicalFactoryDocument,
  FactoryDocumentCodec
} from "../../domain/factory-documents.js";
import type { FactoryEvaluationRepository } from "../../domain/factory-evaluation-repository.js";
import { NodeFactoryDocumentCodec } from "./canonical-factory-documents.js";
import { openSqliteDatabase, type SqliteDatabaseOptions } from "./sqlite-database.js";

interface EvalAttestationRow {
  readonly attestation_id: unknown;
  readonly attestation_digest: unknown;
  readonly assessment_digest: unknown;
  readonly run_id: unknown;
  readonly run_digest: unknown;
  readonly signed_attestation_digest: unknown;
  readonly statement_digest: unknown;
  readonly envelope_digest: unknown;
  readonly key_id: unknown;
  readonly issued_at: unknown;
  readonly expires_at: unknown;
  readonly verified_at: unknown;
  readonly attestation_json: unknown;
}

const ATTESTATION_COLUMNS = `
  attestation_id, attestation_digest, assessment_digest, run_id, run_digest,
  signed_attestation_digest, statement_digest, envelope_digest, key_id,
  issued_at, expires_at, verified_at, attestation_json
`;

export interface SqliteFactoryEvalAttestationRepositoryOptions extends SqliteDatabaseOptions {
  readonly documents?: FactoryDocumentCodec;
  readonly evaluations: Pick<FactoryEvaluationRepository, "findByRunId">;
  readonly verifier: FactoryDsseVerifier;
}

/** SQLite-backed immutable record of one cryptographically verified eval run. */
export class SqliteFactoryEvalAttestationRepository implements FactoryEvalAttestationRepository {
  readonly #database: DatabaseSync;
  readonly #documents: FactoryDocumentCodec;
  readonly #evaluations: Pick<FactoryEvaluationRepository, "findByRunId">;
  readonly #verifier: FactoryDsseVerifier;

  public constructor(databasePath: string, options: SqliteFactoryEvalAttestationRepositoryOptions) {
    this.#database = openSqliteDatabase(databasePath, options);
    this.#documents = options.documents ?? new NodeFactoryDocumentCodec();
    this.#evaluations = options.evaluations;
    this.#verifier = options.verifier;
  }

  public async record(
    recordClaim: CanonicalFactoryDocument<FactoryEvalAttestationRecord>
  ): Promise<FactoryEvalAttestationSnapshot> {
    const record = this.#verifiedRecord(recordClaim);
    await this.#assertRecord(record);
    const predicate = record.value.signedAttestation.statement.predicate;
    this.#database
      .prepare(
        `INSERT INTO factory_eval_attestations (
          attestation_id, attestation_digest, assessment_digest, run_id, run_digest,
          signed_attestation_digest, statement_digest, envelope_digest, key_id,
          issued_at, expires_at, verified_at, attestation_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        record.value.attestationId,
        record.digest,
        record.value.assessmentDigest,
        record.value.runId,
        record.value.runDigest,
        record.value.signedAttestationDigest,
        record.value.statementDigest,
        record.value.envelopeDigest,
        record.value.keyId,
        predicate.issuedAt,
        predicate.expiresAt,
        record.value.verifiedAt,
        record.json
      );
    return snapshotFrom(record);
  }

  public async findByRunDigest(
    runDigest: Sha256Digest
  ): Promise<FactoryEvalAttestationSnapshot | null> {
    const row = this.#database
      .prepare(`SELECT ${ATTESTATION_COLUMNS} FROM factory_eval_attestations WHERE run_digest = ?`)
      .get(runDigest) as EvalAttestationRow | undefined;
    return row === undefined ? null : this.#validatedSnapshot(this.#recordFromRow(row));
  }

  public async findByAttestationDigest(
    attestationDigest: Sha256Digest
  ): Promise<FactoryEvalAttestationSnapshot | null> {
    const row = this.#database
      .prepare(
        `SELECT ${ATTESTATION_COLUMNS}
         FROM factory_eval_attestations
         WHERE attestation_digest = ?`
      )
      .get(attestationDigest) as EvalAttestationRow | undefined;
    return row === undefined ? null : this.#validatedSnapshot(this.#recordFromRow(row));
  }

  public close(): void {
    this.#database.close();
  }

  async #validatedSnapshot(
    record: CanonicalFactoryDocument<FactoryEvalAttestationRecord>
  ): Promise<FactoryEvalAttestationSnapshot> {
    await this.#assertRecord(record);
    return snapshotFrom(record);
  }

  async #assertRecord(
    record: CanonicalFactoryDocument<FactoryEvalAttestationRecord>
  ): Promise<void> {
    const evaluation = await this.#evaluations.findByRunId(record.value.runId);
    if (
      evaluation?.runDigest !== record.value.runDigest ||
      evaluation.assessmentDigest !== record.value.assessmentDigest
    ) {
      throw new Error("Factory eval attestation is missing its exact assessment and run.");
    }
    const run = this.#documents.evalRun(evaluation.run);
    const signed = this.#documents.signedEvalAttestation(record.value.signedAttestation);
    const verification = await this.#verifier.verify(signed.value.envelope);
    assertFactoryEvalAttestationRecord(
      run,
      evaluation.assessmentDigest,
      record,
      signed.digest,
      verification,
      this.#documents
    );
  }

  #recordFromRow(row: EvalAttestationRow): CanonicalFactoryDocument<FactoryEvalAttestationRecord> {
    const record = this.#documents.evalAttestationRecord(
      parseJson(row.attestation_json, "factory eval attestation")
    );
    const predicate = record.value.signedAttestation.statement.predicate;
    if (
      row.attestation_id !== record.value.attestationId ||
      row.attestation_digest !== record.digest ||
      row.assessment_digest !== record.value.assessmentDigest ||
      row.run_id !== record.value.runId ||
      row.run_digest !== record.value.runDigest ||
      row.signed_attestation_digest !== record.value.signedAttestationDigest ||
      row.statement_digest !== record.value.statementDigest ||
      row.envelope_digest !== record.value.envelopeDigest ||
      row.key_id !== record.value.keyId ||
      row.issued_at !== predicate.issuedAt ||
      row.expires_at !== predicate.expiresAt ||
      row.verified_at !== record.value.verifiedAt ||
      row.attestation_json !== record.json
    ) {
      throw new Error(
        `Stored factory eval attestation ${record.value.attestationId} failed integrity validation.`
      );
    }
    return record;
  }

  #verifiedRecord(
    claimed: CanonicalFactoryDocument<FactoryEvalAttestationRecord>
  ): CanonicalFactoryDocument<FactoryEvalAttestationRecord> {
    const actual = this.#documents.evalAttestationRecord(claimed.value);
    if (actual.digest !== claimed.digest || actual.json !== claimed.json) {
      throw new Error("Claimed factory eval attestation is not canonical.");
    }
    return actual;
  }
}

function snapshotFrom(
  record: CanonicalFactoryDocument<FactoryEvalAttestationRecord>
): FactoryEvalAttestationSnapshot {
  return {
    attestation: record.value,
    attestationDigest: record.digest
  };
}

function parseJson(value: unknown, label: string): unknown {
  if (typeof value !== "string") throw new Error(`Stored ${label} is not text.`);
  try {
    return JSON.parse(value) as unknown;
  } catch (error: unknown) {
    throw new Error(`Stored ${label} is not valid JSON.`, { cause: error });
  }
}
