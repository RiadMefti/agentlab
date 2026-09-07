import { DatabaseSync } from "node:sqlite";

import {
  sha256DigestSchema,
  type FactoryCanaryTaskReservation,
  type Sha256Digest
} from "@agentlab/contracts";
import { z } from "zod";

import { ConflictError } from "../../domain/errors.js";
import type {
  FactoryCanaryReservationRepository,
  FactoryCanaryReservationSnapshot,
  FactoryCanaryReservationWriteResult
} from "../../domain/factory-canary-reservation-repository.js";
import type {
  CanonicalFactoryDocument,
  FactoryDocumentCodec
} from "../../domain/factory-documents.js";
import { NodeFactoryDocumentCodec } from "./canonical-factory-documents.js";
import { openSqliteDatabase, type SqliteDatabaseOptions } from "./sqlite-database.js";

interface ReservationRow {
  readonly reservation_id: unknown;
  readonly reservation_digest: unknown;
  readonly cohort_id: unknown;
  readonly cohort_digest: unknown;
  readonly approval_digest: unknown;
  readonly assessment_digest: unknown;
  readonly attestation_digest: unknown;
  readonly role_identity_policy_digest: unknown;
  readonly challenger_candidate_digest: unknown;
  readonly schedule_policy_digest: unknown;
  readonly policy_bundle_digest: unknown;
  readonly stage: unknown;
  readonly repository_id: unknown;
  readonly base_revision: unknown;
  readonly task_id: unknown;
  readonly request_digest: unknown;
  readonly preparation_authority_digest: unknown;
  readonly maximum_risk_tier: unknown;
  readonly wall_clock_seconds: unknown;
  readonly max_agent_turns: unknown;
  readonly max_tool_calls: unknown;
  readonly max_input_tokens: unknown;
  readonly max_output_tokens: unknown;
  readonly max_cost_microusd: unknown;
  readonly max_processes: unknown;
  readonly max_output_bytes: unknown;
  readonly max_workers: unknown;
  readonly max_repair_attempts: unknown;
  readonly max_changed_files: unknown;
  readonly max_changed_lines: unknown;
  readonly reserved_at: unknown;
  readonly expires_at: unknown;
  readonly reservation_json: unknown;
}

const RESERVATION_COLUMNS = `
  reservation_id, reservation_digest, cohort_id, cohort_digest, approval_digest,
  assessment_digest, attestation_digest, role_identity_policy_digest,
  challenger_candidate_digest, schedule_policy_digest, policy_bundle_digest, stage,
  repository_id, base_revision, task_id, request_digest, preparation_authority_digest,
  maximum_risk_tier, wall_clock_seconds, max_agent_turns, max_tool_calls, max_input_tokens,
  max_output_tokens, max_cost_microusd, max_processes, max_output_bytes, max_workers,
  max_repair_attempts, max_changed_files, max_changed_lines, reserved_at, expires_at,
  reservation_json
`;

export interface SqliteFactoryCanaryReservationRepositoryOptions extends SqliteDatabaseOptions {
  readonly documents?: FactoryDocumentCodec;
}

/** SQLite-backed immutable task reservations with transactional cohort quota enforcement. */
export class SqliteFactoryCanaryReservationRepository implements FactoryCanaryReservationRepository {
  readonly #database: DatabaseSync;
  readonly #documents: FactoryDocumentCodec;

  public constructor(
    databasePath: string,
    options: SqliteFactoryCanaryReservationRepositoryOptions = {}
  ) {
    this.#database = openSqliteDatabase(databasePath, options);
    this.#documents = options.documents ?? new NodeFactoryDocumentCodec();
  }

  public reserve(
    reservationClaim: CanonicalFactoryDocument<FactoryCanaryTaskReservation>
  ): Promise<FactoryCanaryReservationWriteResult> {
    const reservation = this.#verifiedReservation(reservationClaim);
    try {
      return Promise.resolve(
        this.#inTransaction(() => {
          const existing = this.#findByTaskId(reservation.value.taskId);
          if (existing !== null) {
            if (
              existing.reservationDigest !== reservation.digest ||
              this.#documents.canaryTaskReservation(existing.reservation).json !== reservation.json
            ) {
              throw new ConflictError(
                "Factory task already has different immutable canary authority."
              );
            }
            return { status: "existing" as const, ...existing };
          }
          const budget = reservation.value.budget;
          this.#database
            .prepare(
              `INSERT INTO factory_canary_task_reservations (
              ${RESERVATION_COLUMNS}
            ) VALUES (
              ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
              ?, ?, ?, ?, ?, ?
            )`
            )
            .run(
              reservation.value.reservationId,
              reservation.digest,
              reservation.value.cohortId,
              reservation.value.cohortDigest,
              reservation.value.approvalDigest,
              reservation.value.assessmentDigest,
              reservation.value.attestationDigest,
              reservation.value.roleIdentityPolicyDigest,
              reservation.value.challengerCandidateDigest,
              reservation.value.schedulePolicyDigest,
              reservation.value.policyBundleDigest,
              reservation.value.stage,
              reservation.value.repository.id,
              reservation.value.repository.baseRevision,
              reservation.value.taskId,
              reservation.value.requestDigest,
              reservation.value.preparationAuthorityDigest,
              reservation.value.maximumRiskTier,
              budget.wallClockSeconds,
              budget.maxAgentTurns,
              budget.maxToolCalls,
              budget.maxInputTokens,
              budget.maxOutputTokens,
              budget.maxCostMicrousd,
              budget.maxProcesses,
              budget.maxOutputBytes,
              budget.maxWorkers,
              budget.maxRepairAttempts,
              budget.maxChangedFiles,
              budget.maxChangedLines,
              reservation.value.reservedAt,
              reservation.value.expiresAt,
              reservation.json
            );
          return {
            status: "reserved" as const,
            reservation: reservation.value,
            reservationDigest: reservation.digest
          };
        })
      );
    } catch (error: unknown) {
      if (
        error instanceof Error &&
        error.message.includes("factory canary cohort reservation capacity exceeded")
      ) {
        throw new ConflictError("Factory canary cohort reservation capacity exceeded.");
      }
      throw error;
    }
  }

  public findByTaskId(taskIdInput: string): Promise<FactoryCanaryReservationSnapshot | null> {
    const taskId = z.uuid().parse(taskIdInput);
    return Promise.resolve(this.#findByTaskId(taskId));
  }

  public findByReservationDigest(
    reservationDigestInput: Sha256Digest
  ): Promise<FactoryCanaryReservationSnapshot | null> {
    const reservationDigest = sha256DigestSchema.parse(reservationDigestInput);
    const row = this.#database
      .prepare(
        `SELECT ${RESERVATION_COLUMNS}
         FROM factory_canary_task_reservations
         WHERE reservation_digest = ?`
      )
      .get(reservationDigest) as ReservationRow | undefined;
    return Promise.resolve(row === undefined ? null : this.#snapshot(row));
  }

  public listByCohortDigest(
    cohortDigestInput: Sha256Digest
  ): Promise<readonly FactoryCanaryReservationSnapshot[]> {
    const cohortDigest = sha256DigestSchema.parse(cohortDigestInput);
    const rows = this.#database
      .prepare(
        `SELECT ${RESERVATION_COLUMNS}
         FROM factory_canary_task_reservations
         WHERE cohort_digest = ?
         ORDER BY reserved_at, reservation_id
         LIMIT 101`
      )
      .all(cohortDigest) as unknown as ReservationRow[];
    if (rows.length > 100) {
      throw new Error("Factory canary cohort exceeds its reservation count ceiling.");
    }
    return Promise.resolve(rows.map((row) => this.#snapshot(row)));
  }

  public close(): void {
    this.#database.close();
  }

  #findByTaskId(taskId: string): FactoryCanaryReservationSnapshot | null {
    const row = this.#database
      .prepare(
        `SELECT ${RESERVATION_COLUMNS}
         FROM factory_canary_task_reservations
         WHERE task_id = ?`
      )
      .get(taskId) as ReservationRow | undefined;
    return row === undefined ? null : this.#snapshot(row);
  }

  #snapshot(row: ReservationRow): FactoryCanaryReservationSnapshot {
    const reservation = this.#documents.canaryTaskReservation(
      parseJson(row.reservation_json, "factory canary task reservation")
    );
    const budget = reservation.value.budget;
    if (
      row.reservation_id !== reservation.value.reservationId ||
      row.reservation_digest !== reservation.digest ||
      row.cohort_id !== reservation.value.cohortId ||
      row.cohort_digest !== reservation.value.cohortDigest ||
      row.approval_digest !== reservation.value.approvalDigest ||
      row.assessment_digest !== reservation.value.assessmentDigest ||
      row.attestation_digest !== reservation.value.attestationDigest ||
      row.role_identity_policy_digest !== reservation.value.roleIdentityPolicyDigest ||
      row.challenger_candidate_digest !== reservation.value.challengerCandidateDigest ||
      row.schedule_policy_digest !== reservation.value.schedulePolicyDigest ||
      row.policy_bundle_digest !== reservation.value.policyBundleDigest ||
      row.stage !== reservation.value.stage ||
      row.repository_id !== reservation.value.repository.id ||
      row.base_revision !== reservation.value.repository.baseRevision ||
      row.task_id !== reservation.value.taskId ||
      row.request_digest !== reservation.value.requestDigest ||
      row.preparation_authority_digest !== reservation.value.preparationAuthorityDigest ||
      row.maximum_risk_tier !== reservation.value.maximumRiskTier ||
      row.wall_clock_seconds !== budget.wallClockSeconds ||
      row.max_agent_turns !== budget.maxAgentTurns ||
      row.max_tool_calls !== budget.maxToolCalls ||
      row.max_input_tokens !== budget.maxInputTokens ||
      row.max_output_tokens !== budget.maxOutputTokens ||
      row.max_cost_microusd !== budget.maxCostMicrousd ||
      row.max_processes !== budget.maxProcesses ||
      row.max_output_bytes !== budget.maxOutputBytes ||
      row.max_workers !== budget.maxWorkers ||
      row.max_repair_attempts !== budget.maxRepairAttempts ||
      row.max_changed_files !== budget.maxChangedFiles ||
      row.max_changed_lines !== budget.maxChangedLines ||
      row.reserved_at !== reservation.value.reservedAt ||
      row.expires_at !== reservation.value.expiresAt ||
      row.reservation_json !== reservation.json
    ) {
      throw new Error(
        `Stored factory canary task reservation ${reservation.value.reservationId} failed integrity validation.`
      );
    }
    return { reservation: reservation.value, reservationDigest: reservation.digest };
  }

  #verifiedReservation(
    claimed: CanonicalFactoryDocument<FactoryCanaryTaskReservation>
  ): CanonicalFactoryDocument<FactoryCanaryTaskReservation> {
    const actual = this.#documents.canaryTaskReservation(claimed.value);
    if (actual.digest !== claimed.digest || actual.json !== claimed.json) {
      throw new Error("Claimed factory canary task reservation is not canonical.");
    }
    return actual;
  }

  #inTransaction<Value>(operation: () => Value): Value {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const value = operation();
      this.#database.exec("COMMIT");
      return value;
    } catch (error: unknown) {
      try {
        this.#database.exec("ROLLBACK");
      } catch {
        // Preserve the primary integrity or persistence error.
      }
      throw error;
    }
  }
}

function parseJson(value: unknown, label: string): unknown {
  if (typeof value !== "string") throw new Error(`Stored ${label} is not text.`);
  try {
    return JSON.parse(value) as unknown;
  } catch (error: unknown) {
    throw new Error(`Stored ${label} is not valid JSON.`, { cause: error });
  }
}
