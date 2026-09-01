import { DatabaseSync } from "node:sqlite";

import { sha256DigestSchema, type FactoryDailyQuotaReservation } from "@agentlab/contracts";
import { z } from "zod";

import {
  FactoryDailyQuotaCapacityError,
  type FactoryDailyQuotaRepository,
  type FactoryDailyQuotaReservationSnapshot
} from "../../domain/factory-daily-quota-repository.js";
import type {
  CanonicalFactoryDocument,
  FactoryDocumentCodec
} from "../../domain/factory-documents.js";
import { NodeFactoryDocumentCodec } from "./canonical-factory-documents.js";
import { openSqliteDatabase, type SqliteDatabaseOptions } from "./sqlite-database.js";

interface DailyQuotaReservationRow {
  readonly reservation_id: unknown;
  readonly reservation_digest: unknown;
  readonly task_id: unknown;
  readonly quota_policy_digest: unknown;
  readonly organization_id: unknown;
  readonly repository_id: unknown;
  readonly schedule_run_id: unknown;
  readonly canary_reservation_digest: unknown;
  readonly window_start: unknown;
  readonly reserved_at: unknown;
  readonly reservation_json: unknown;
}

const COLUMNS = `
  reservation_id, reservation_digest, task_id, quota_policy_digest, organization_id,
  repository_id, schedule_run_id, canary_reservation_digest, window_start, reserved_at,
  reservation_json
`;

export interface SqliteFactoryDailyQuotaRepositoryOptions extends SqliteDatabaseOptions {
  readonly documents?: FactoryDocumentCodec;
}

/** SQLite-backed organization-wide UTC-day quota ledger. */
export class SqliteFactoryDailyQuotaRepository implements FactoryDailyQuotaRepository {
  readonly #database: DatabaseSync;
  readonly #documents: FactoryDocumentCodec;

  public constructor(databasePath: string, options: SqliteFactoryDailyQuotaRepositoryOptions = {}) {
    this.#database = openSqliteDatabase(databasePath, options);
    this.#documents = options.documents ?? new NodeFactoryDocumentCodec();
  }

  public reserve(
    reservationClaim: CanonicalFactoryDocument<FactoryDailyQuotaReservation>
  ): Promise<FactoryDailyQuotaReservationSnapshot> {
    const reservation = this.#verified(reservationClaim);
    try {
      this.#database
        .prepare(
          `INSERT INTO factory_daily_quota_reservations (
            reservation_id, reservation_digest, task_id, quota_policy_digest,
            organization_id, repository_id, schedule_run_id, schedule_run_digest,
            canary_reservation_digest, window_start, window_end, wall_clock_seconds,
            max_agent_turns, max_tool_calls, max_input_tokens, max_output_tokens,
            max_cost_microusd, max_processes, max_output_bytes, max_workers,
            max_repair_attempts, max_changed_files, max_changed_lines,
            draft_pull_requests, reserved_at, correlation_id, reservation_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          reservation.value.reservationId,
          reservation.digest,
          reservation.value.taskId,
          reservation.value.quotaPolicyDigest,
          reservation.value.organizationId,
          reservation.value.repositoryId,
          reservation.value.scheduleRunId,
          reservation.value.scheduleRunDigest,
          reservation.value.canaryReservationDigest,
          reservation.value.windowStart,
          reservation.value.windowEnd,
          reservation.value.budget.wallClockSeconds,
          reservation.value.budget.maxAgentTurns,
          reservation.value.budget.maxToolCalls,
          reservation.value.budget.maxInputTokens,
          reservation.value.budget.maxOutputTokens,
          reservation.value.budget.maxCostMicrousd,
          reservation.value.budget.maxProcesses,
          reservation.value.budget.maxOutputBytes,
          reservation.value.budget.maxWorkers,
          reservation.value.budget.maxRepairAttempts,
          reservation.value.budget.maxChangedFiles,
          reservation.value.budget.maxChangedLines,
          reservation.value.draftPullRequests,
          reservation.value.reservedAt,
          reservation.value.correlationId,
          reservation.json
        );
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "";
      if (message.includes("factory daily repository quota capacity exceeded")) {
        throw new FactoryDailyQuotaCapacityError("repository");
      }
      if (message.includes("factory daily organization quota capacity exceeded")) {
        throw new FactoryDailyQuotaCapacityError("organization");
      }
      throw error;
    }
    return Promise.resolve(snapshot(reservation));
  }

  public findByTaskId(taskIdInput: string): Promise<FactoryDailyQuotaReservationSnapshot | null> {
    const taskId = z.uuid().parse(taskIdInput);
    return Promise.resolve(this.#find("task_id", taskId));
  }

  public findByReservationDigest(
    reservationDigestInput: string
  ): Promise<FactoryDailyQuotaReservationSnapshot | null> {
    const reservationDigest = sha256DigestSchema.parse(reservationDigestInput);
    return Promise.resolve(this.#find("reservation_digest", reservationDigest));
  }

  public close(): void {
    this.#database.close();
  }

  #find(
    column: "task_id" | "reservation_digest",
    value: string
  ): FactoryDailyQuotaReservationSnapshot | null {
    const row = this.#database
      .prepare(`SELECT ${COLUMNS} FROM factory_daily_quota_reservations WHERE ${column} = ?`)
      .get(value) as DailyQuotaReservationRow | undefined;
    return row === undefined ? null : snapshot(this.#fromRow(row));
  }

  #fromRow(row: DailyQuotaReservationRow): CanonicalFactoryDocument<FactoryDailyQuotaReservation> {
    const reservation = this.#documents.dailyQuotaReservation(
      parseJson(row.reservation_json, "factory daily quota reservation")
    );
    const policy = this.#documents.dailyQuotaPolicy(reservation.value.quotaPolicy);
    if (
      row.reservation_id !== reservation.value.reservationId ||
      row.reservation_digest !== reservation.digest ||
      row.task_id !== reservation.value.taskId ||
      row.quota_policy_digest !== reservation.value.quotaPolicyDigest ||
      row.quota_policy_digest !== policy.digest ||
      row.organization_id !== reservation.value.organizationId ||
      row.repository_id !== reservation.value.repositoryId ||
      row.schedule_run_id !== reservation.value.scheduleRunId ||
      row.canary_reservation_digest !== reservation.value.canaryReservationDigest ||
      row.window_start !== reservation.value.windowStart ||
      row.reserved_at !== reservation.value.reservedAt ||
      row.reservation_json !== reservation.json
    ) {
      throw new Error(
        `Stored factory daily quota reservation ${reservation.value.reservationId} failed integrity validation.`
      );
    }
    return reservation;
  }

  #verified(
    claim: CanonicalFactoryDocument<FactoryDailyQuotaReservation>
  ): CanonicalFactoryDocument<FactoryDailyQuotaReservation> {
    const reservation = this.#documents.dailyQuotaReservation(claim.value);
    const policy = this.#documents.dailyQuotaPolicy(reservation.value.quotaPolicy);
    if (
      reservation.json !== claim.json ||
      reservation.digest !== claim.digest ||
      policy.digest !== reservation.value.quotaPolicyDigest
    ) {
      throw new Error("Factory daily quota reservation canonical identity mismatch.");
    }
    return reservation;
  }
}

function snapshot(
  reservation: CanonicalFactoryDocument<FactoryDailyQuotaReservation>
): FactoryDailyQuotaReservationSnapshot {
  return {
    reservation: reservation.value,
    reservationDigest: reservation.digest
  };
}

function parseJson(value: unknown, label: string): unknown {
  if (typeof value !== "string") throw new Error(`Stored ${label} JSON is invalid.`);
  try {
    return JSON.parse(value) as unknown;
  } catch (error: unknown) {
    throw new Error(`Stored ${label} JSON is invalid.`, { cause: error });
  }
}
