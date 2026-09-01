import { DatabaseSync } from "node:sqlite";

import {
  factoryIdentifierSchema,
  factoryTimestampSchema,
  sha256DigestSchema
} from "@agentlab/contracts";
import { z } from "zod";

import type {
  FactoryCanaryBrokerQueue,
  FactoryCanaryBrokerQueueItem,
  FactoryCanaryBrokerQueuePage,
  FactoryCanaryBrokerQueueQuery
} from "../../domain/factory-canary-broker-queue.js";
import { openSqliteDatabase, type SqliteDatabaseOptions } from "./sqlite-database.js";

const querySchema = z
  .object({
    repositoryId: factoryIdentifierSchema,
    observedAt: factoryTimestampSchema,
    limit: z.number().int().min(1).max(100)
  })
  .strict();

const rowSchema = z
  .object({
    taskId: z.uuid(),
    reservationDigest: sha256DigestSchema,
    schedulePolicyDigest: sha256DigestSchema,
    factoryPolicyBundleDigest: sha256DigestSchema,
    roleIdentityPolicyDigest: sha256DigestSchema,
    handoffSchedulePolicyDigest: sha256DigestSchema,
    handoffFactoryPolicyBundleDigest: sha256DigestSchema,
    handoffRoleIdentityPolicyDigest: sha256DigestSchema,
    scheduledFor: factoryTimestampSchema,
    finishedAt: factoryTimestampSchema,
    reservedAt: factoryTimestampSchema,
    expiresAt: factoryTimestampSchema,
    source: z.enum(["undispatched", "recoverable"])
  })
  .strict();

/** SQLite read model joining immutable scheduler intent to incomplete broker observation. */
export class SqliteFactoryCanaryBrokerQueue implements FactoryCanaryBrokerQueue {
  readonly #database: DatabaseSync;

  public constructor(databasePath: string, options: SqliteDatabaseOptions = {}) {
    this.#database = openSqliteDatabase(databasePath, options);
  }

  public listPending(
    queryInput: FactoryCanaryBrokerQueueQuery
  ): Promise<FactoryCanaryBrokerQueuePage> {
    const query = querySchema.parse(queryInput);
    const rows = this.#database
      .prepare(
        `SELECT
           finished.task_id AS taskId,
           reservation.reservation_digest AS reservationDigest,
           reservation.schedule_policy_digest AS schedulePolicyDigest,
           reservation.policy_bundle_digest AS factoryPolicyBundleDigest,
           reservation.role_identity_policy_digest AS roleIdentityPolicyDigest,
           schedule_run.schedule_policy_digest AS handoffSchedulePolicyDigest,
           schedule_run.factory_policy_bundle_digest AS handoffFactoryPolicyBundleDigest,
           json_extract(schedule_run.run_json, '$.roleIdentityPolicyDigest')
             AS handoffRoleIdentityPolicyDigest,
           schedule_run.scheduled_for AS scheduledFor,
           finished.occurred_at AS finishedAt,
           reservation.reserved_at AS reservedAt,
           reservation.expires_at AS expiresAt,
           CASE WHEN dispatch.dispatch_id IS NULL THEN 'undispatched' ELSE 'recoverable' END
             AS source
         FROM factory_schedule_events AS finished
         JOIN factory_schedule_runs AS schedule_run ON schedule_run.run_id = finished.run_id
         JOIN factory_canary_task_reservations AS reservation
           ON reservation.task_id = finished.task_id
          AND reservation.reservation_digest = json_extract(
            finished.event_json, '$.canaryReservationDigest'
          )
         LEFT JOIN factory_pull_request_dispatches AS dispatch
           ON dispatch.task_id = finished.task_id
         WHERE finished.kind = 'task-finished'
           AND json_extract(finished.event_json, '$.schemaVersion')
             = 'agentlab.schedule-event.v2'
           AND json_extract(finished.event_json, '$.result') = 'ready-for-broker'
           AND json_extract(finished.event_json, '$.preparationState') = 'prepared'
           AND json_extract(finished.event_json, '$.taskState') = 'pr-proposed'
           AND reservation.repository_id = ?
           AND reservation.stage = 'brokered-draft-pr'
           AND (
             SELECT terminal.to_state
             FROM factory_schedule_events AS terminal
             WHERE terminal.run_id = schedule_run.run_id
             ORDER BY terminal.sequence DESC
             LIMIT 1
           ) = 'completed'
           AND (
             dispatch.dispatch_id IS NULL OR COALESCE((
               SELECT dispatch_event.to_state
               FROM factory_pull_request_dispatch_events AS dispatch_event
               WHERE dispatch_event.dispatch_id = dispatch.dispatch_id
               ORDER BY dispatch_event.sequence DESC
               LIMIT 1
             ), 'missing') <> 'completed'
           )
         ORDER BY
           CASE WHEN reservation.reserved_at <= ? AND ? < reservation.expires_at THEN 0 ELSE 1 END,
           CASE WHEN dispatch.dispatch_id IS NULL THEN 1 ELSE 0 END,
           finished.occurred_at,
           finished.task_id
         LIMIT ?`
      )
      .all(query.repositoryId, query.observedAt, query.observedAt, query.limit + 1) as unknown[];
    const parsed = rows.map((row) => rowSchema.parse(row));
    const items = parsed.slice(0, query.limit);
    assertUniqueTasks(items);
    return Promise.resolve({ items, truncated: parsed.length > query.limit });
  }

  public close(): void {
    this.#database.close();
  }
}

function assertUniqueTasks(items: readonly FactoryCanaryBrokerQueueItem[]): void {
  const taskIds = new Set<string>();
  for (const item of items) {
    if (taskIds.has(item.taskId)) {
      throw new Error(`Factory task ${item.taskId} has multiple pending broker handoffs.`);
    }
    taskIds.add(item.taskId);
  }
}
