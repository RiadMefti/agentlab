import { DatabaseSync } from "node:sqlite";

import {
  factoryIdentifierSchema,
  factoryTimestampSchema,
  type FactoryControlName,
  type FactoryDailyQuotaReservation,
  type FactoryScheduleEvent,
  type FactoryScheduleRun,
  type ImmutableTaskContract,
  type TaskEvent
} from "@agentlab/contracts";
import { z } from "zod";

import type { FactoryDocumentCodec } from "../../domain/factory-documents.js";
import type {
  FactoryOperationsHealthObservation,
  FactoryOperationsHealthQuery,
  FactoryOperationsHealthSource,
  FactoryOperationsScheduleObservation,
  FactoryOperationsTaskObservation
} from "../../domain/factory-operations-health-source.js";
import { isTerminalFactoryTaskState } from "../../domain/factory-task-state.js";
import { NodeFactoryDocumentCodec } from "./canonical-factory-documents.js";
import { FACTORY_DATABASE_SCHEMA_VERSION } from "./migrations.js";

interface ControlRow {
  readonly event_digest: unknown;
  readonly control_name: unknown;
  readonly enabled: unknown;
  readonly event_json: unknown;
}

interface ScheduleObservationRow {
  readonly run_id: unknown;
  readonly run_digest: unknown;
  readonly scheduled_for: unknown;
  readonly deadline_at: unknown;
  readonly created_at: unknown;
  readonly run_json: unknown;
  readonly event_digest: unknown;
  readonly event_sequence: unknown;
  readonly event_to_state: unknown;
  readonly event_occurred_at: unknown;
  readonly event_json: unknown;
}

interface TaskObservationRow {
  readonly task_id: unknown;
  readonly contract_digest: unknown;
  readonly created_at: unknown;
  readonly expires_at: unknown;
  readonly contract_json: unknown;
  readonly event_digest: unknown;
  readonly event_sequence: unknown;
  readonly event_to_state: unknown;
  readonly event_occurred_at: unknown;
  readonly event_json: unknown;
}

interface DailyQuotaRow {
  readonly reservation_digest: unknown;
  readonly task_id: unknown;
  readonly quota_policy_digest: unknown;
  readonly organization_id: unknown;
  readonly repository_id: unknown;
  readonly schedule_run_id: unknown;
  readonly schedule_run_digest: unknown;
  readonly canary_reservation_digest: unknown;
  readonly window_start: unknown;
  readonly window_end: unknown;
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
  readonly draft_pull_requests: unknown;
  readonly reserved_at: unknown;
  readonly correlation_id: unknown;
  readonly reservation_json: unknown;
}

const querySchema = z
  .object({
    lookbackStartedAt: factoryTimestampSchema,
    observedAt: factoryTimestampSchema,
    quotaWindowStart: factoryTimestampSchema,
    organizationId: factoryIdentifierSchema,
    repositoryIds: z.array(factoryIdentifierSchema).min(1).max(256),
    maximumRecordsPerSection: z.number().int().min(10).max(10_000)
  })
  .strict()
  .superRefine((query, context) => {
    if (query.lookbackStartedAt > query.observedAt) {
      context.addIssue({
        code: "custom",
        path: ["lookbackStartedAt"],
        message: "Health query lookback must not follow observation."
      });
    }
    if (new Set(query.repositoryIds).size !== query.repositoryIds.length) {
      context.addIssue({
        code: "custom",
        path: ["repositoryIds"],
        message: "Health query repositories must be unique."
      });
    }
  });

export interface SqliteFactoryOperationsHealthSourceOptions {
  readonly documents?: FactoryDocumentCodec;
  readonly createDatabase?: (databasePath: string) => DatabaseSync;
}

/** Opens the shared ledger query-only and validates every document used by the health projection. */
export class SqliteFactoryOperationsHealthSource implements FactoryOperationsHealthSource {
  readonly #database: DatabaseSync;
  readonly #documents: FactoryDocumentCodec;

  public constructor(
    databasePath: string,
    options: SqliteFactoryOperationsHealthSourceOptions = {}
  ) {
    this.#documents = options.documents ?? new NodeFactoryDocumentCodec();
    this.#database = (
      options.createDatabase ?? ((path) => new DatabaseSync(path, { readOnly: true }))
    )(databasePath);
    try {
      this.#database.exec("PRAGMA query_only = ON");
      const version = this.#database.prepare("PRAGMA user_version").get() as
        { readonly user_version?: unknown } | undefined;
      if (version?.user_version !== FACTORY_DATABASE_SCHEMA_VERSION) {
        throw new Error(
          `Factory operations health requires database schema ${String(FACTORY_DATABASE_SCHEMA_VERSION)}.`
        );
      }
    } catch (error: unknown) {
      try {
        this.#database.close();
      } catch (closeError: unknown) {
        throw new AggregateError(
          [error, closeError],
          "Factory operations health initialization and cleanup both failed.",
          { cause: error }
        );
      }
      throw error;
    }
  }

  public observe(input: FactoryOperationsHealthQuery): Promise<FactoryOperationsHealthObservation> {
    const query = querySchema.parse(input);
    this.#database.exec("BEGIN");
    try {
      const limit = query.maximumRecordsPerSection + 1;
      const scheduleRows = this.#scheduleRows(query.lookbackStartedAt, limit);
      const taskRows = this.#taskRows(query.lookbackStartedAt, limit);
      const quotaRows = this.#dailyQuotaRows(query.organizationId, query.quotaWindowStart, limit);
      const truncatedSections: ("schedules" | "tasks" | "daily-quotas")[] = [];
      if (scheduleRows.length > query.maximumRecordsPerSection) {
        truncatedSections.push("schedules");
      }
      if (taskRows.length > query.maximumRecordsPerSection) truncatedSections.push("tasks");
      if (quotaRows.length > query.maximumRecordsPerSection) {
        truncatedSections.push("daily-quotas");
      }
      const observation: FactoryOperationsHealthObservation = {
        authority: {
          scheduler: this.#control("scheduler"),
          prBroker: this.#control("pr-broker"),
          mergeBroker: this.#control("merge-broker")
        },
        schedules: scheduleRows
          .slice(0, query.maximumRecordsPerSection)
          .map((row) => this.#schedule(row)),
        tasks: taskRows.slice(0, query.maximumRecordsPerSection).map((row) => this.#task(row)),
        dailyQuotaReservations: quotaRows
          .slice(0, query.maximumRecordsPerSection)
          .map((row) => this.#dailyQuota(row, query.repositoryIds)),
        truncatedSections
      };
      this.#database.exec("COMMIT");
      return Promise.resolve(observation);
    } catch (error: unknown) {
      try {
        this.#database.exec("ROLLBACK");
      } catch (rollbackError: unknown) {
        throw new AggregateError(
          [error, rollbackError],
          "Factory operations health observation and rollback both failed.",
          { cause: error }
        );
      }
      throw error;
    }
  }

  public close(): void {
    this.#database.close();
  }

  #control(control: FactoryControlName): boolean {
    const table =
      control === "merge-broker" ? "factory_merge_control_events" : "factory_control_events";
    const row = this.#database
      .prepare(
        `SELECT event_digest, control_name, enabled, event_json
         FROM ${table} WHERE control_name = ? ORDER BY sequence DESC LIMIT 1`
      )
      .get(control) as ControlRow | undefined;
    if (row === undefined) return false;
    const event = this.#documents.controlEvent(parseJson(row.event_json, "control event"));
    if (
      row.event_digest !== event.digest ||
      row.control_name !== event.value.control ||
      row.enabled !== (event.value.enabled ? 1 : 0) ||
      event.value.control !== control
    ) {
      throw new Error("Factory operations health observed invalid control state.");
    }
    return event.value.enabled;
  }

  #scheduleRows(lookbackStartedAt: string, limit: number): readonly ScheduleObservationRow[] {
    return this.#database
      .prepare(
        `SELECT
           run.run_id, run.run_digest, run.scheduled_for, run.deadline_at,
           run.created_at, run.run_json, event.event_digest,
           event.sequence AS event_sequence, event.to_state AS event_to_state,
           event.occurred_at AS event_occurred_at, event.event_json
         FROM factory_schedule_runs AS run
         JOIN factory_schedule_events AS event ON event.run_id = run.run_id
         WHERE event.sequence = (
           SELECT MAX(latest.sequence) FROM factory_schedule_events AS latest
           WHERE latest.run_id = run.run_id
         ) AND (event.occurred_at >= ? OR event.to_state <> 'completed')
         ORDER BY run.scheduled_for DESC, run.run_id DESC
         LIMIT ?`
      )
      .all(lookbackStartedAt, limit) as unknown as ScheduleObservationRow[];
  }

  #taskRows(lookbackStartedAt: string, limit: number): readonly TaskObservationRow[] {
    return this.#database
      .prepare(
        `SELECT
           contract.task_id, contract.contract_digest, contract.created_at, contract.expires_at,
           contract.contract_json, event.event_digest,
           event.sequence AS event_sequence, event.to_state AS event_to_state,
           event.occurred_at AS event_occurred_at, event.event_json
         FROM factory_task_contracts AS contract
         JOIN factory_task_events AS event ON event.task_id = contract.task_id
         WHERE event.sequence = (
           SELECT MAX(latest.sequence) FROM factory_task_events AS latest
           WHERE latest.task_id = contract.task_id
         ) AND (
           event.occurred_at >= ? OR event.to_state NOT IN (
             'completed', 'needs-attention', 'rejected', 'cancelled', 'expired',
             'failed', 'quarantined', 'rolled-back'
           )
         )
         ORDER BY event.occurred_at DESC, contract.task_id DESC
         LIMIT ?`
      )
      .all(lookbackStartedAt, limit) as unknown as TaskObservationRow[];
  }

  #dailyQuotaRows(
    organizationId: string,
    windowStart: string,
    limit: number
  ): readonly DailyQuotaRow[] {
    return this.#database
      .prepare(
        `SELECT
           reservation_digest, task_id, quota_policy_digest, organization_id, repository_id,
           schedule_run_id, schedule_run_digest, canary_reservation_digest,
           window_start, window_end, wall_clock_seconds, max_agent_turns, max_tool_calls,
           max_input_tokens, max_output_tokens, max_cost_microusd, max_processes,
           max_output_bytes, max_workers, max_repair_attempts, max_changed_files,
           max_changed_lines, draft_pull_requests, reserved_at, correlation_id, reservation_json
         FROM factory_daily_quota_reservations
         WHERE organization_id = ? AND window_start = ?
         ORDER BY reservation_id
         LIMIT ?`
      )
      .all(organizationId, windowStart, limit) as unknown as DailyQuotaRow[];
  }

  #schedule(row: ScheduleObservationRow): FactoryOperationsScheduleObservation {
    const runDocument = this.#documents.scheduleRun(parseJson(row.run_json, "schedule run"));
    const eventDocument = this.#documents.scheduleEvent(
      parseJson(row.event_json, "schedule event")
    );
    const run: FactoryScheduleRun = runDocument.value;
    const event: FactoryScheduleEvent = eventDocument.value;
    if (
      row.run_id !== run.runId ||
      row.run_digest !== runDocument.digest ||
      row.scheduled_for !== run.scheduledFor ||
      row.deadline_at !== run.deadlineAt ||
      row.created_at !== run.createdAt ||
      row.event_digest !== eventDocument.digest ||
      row.event_sequence !== event.sequence ||
      row.event_to_state !== event.to ||
      row.event_occurred_at !== event.occurredAt ||
      event.runId !== run.runId ||
      event.runDigest !== runDocument.digest ||
      event.correlationId !== run.correlationId
    ) {
      throw new Error("Factory operations health observed invalid schedule projection.");
    }
    return { run, state: event.to, lastEvent: event };
  }

  #task(row: TaskObservationRow): FactoryOperationsTaskObservation {
    const contractDocument = this.#documents.taskContract(
      parseJson(row.contract_json, "task contract")
    );
    const eventDocument = this.#documents.taskEvent(parseJson(row.event_json, "task event"));
    const contract: ImmutableTaskContract = contractDocument.value;
    const event: TaskEvent = eventDocument.value;
    if (
      row.task_id !== contract.taskId ||
      row.contract_digest !== contractDocument.digest ||
      row.created_at !== contract.createdAt ||
      row.expires_at !== contract.expiresAt ||
      row.event_digest !== eventDocument.digest ||
      row.event_sequence !== event.sequence ||
      row.event_to_state !== event.to ||
      row.event_occurred_at !== event.occurredAt ||
      event.taskId !== contract.taskId ||
      event.contractDigest !== contractDocument.digest
    ) {
      throw new Error("Factory operations health observed invalid task projection.");
    }
    if (isTerminalFactoryTaskState(event.to) && event.occurredAt < contract.createdAt) {
      throw new Error("Factory operations health observed invalid terminal task time.");
    }
    return { contract, state: event.to, lastEvent: event };
  }

  #dailyQuota(row: DailyQuotaRow, repositoryIds: readonly string[]): FactoryDailyQuotaReservation {
    const document = this.#documents.dailyQuotaReservation(
      parseJson(row.reservation_json, "daily quota reservation")
    );
    const reservation = document.value;
    const embeddedPolicy = this.#documents.dailyQuotaPolicy(reservation.quotaPolicy);
    if (
      row.reservation_digest !== document.digest ||
      row.task_id !== reservation.taskId ||
      row.quota_policy_digest !== reservation.quotaPolicyDigest ||
      embeddedPolicy.digest !== reservation.quotaPolicyDigest ||
      row.organization_id !== reservation.organizationId ||
      row.repository_id !== reservation.repositoryId ||
      !repositoryIds.includes(reservation.repositoryId) ||
      row.schedule_run_id !== reservation.scheduleRunId ||
      row.schedule_run_digest !== reservation.scheduleRunDigest ||
      row.canary_reservation_digest !== reservation.canaryReservationDigest ||
      row.window_start !== reservation.windowStart ||
      row.window_end !== reservation.windowEnd ||
      row.wall_clock_seconds !== reservation.budget.wallClockSeconds ||
      row.max_agent_turns !== reservation.budget.maxAgentTurns ||
      row.max_tool_calls !== reservation.budget.maxToolCalls ||
      row.max_input_tokens !== reservation.budget.maxInputTokens ||
      row.max_output_tokens !== reservation.budget.maxOutputTokens ||
      row.max_cost_microusd !== reservation.budget.maxCostMicrousd ||
      row.max_processes !== reservation.budget.maxProcesses ||
      row.max_output_bytes !== reservation.budget.maxOutputBytes ||
      row.max_workers !== reservation.budget.maxWorkers ||
      row.max_repair_attempts !== reservation.budget.maxRepairAttempts ||
      row.max_changed_files !== reservation.budget.maxChangedFiles ||
      row.max_changed_lines !== reservation.budget.maxChangedLines ||
      row.draft_pull_requests !== reservation.draftPullRequests ||
      row.reserved_at !== reservation.reservedAt ||
      row.correlation_id !== reservation.correlationId
    ) {
      throw new Error("Factory operations health observed invalid daily quota projection.");
    }
    return reservation;
  }
}

function parseJson(value: unknown, label: string): unknown {
  if (typeof value !== "string") throw new Error(`Stored factory ${label} is not text.`);
  try {
    return JSON.parse(value) as unknown;
  } catch (error: unknown) {
    throw new Error(`Stored factory ${label} is invalid JSON.`, { cause: error });
  }
}
