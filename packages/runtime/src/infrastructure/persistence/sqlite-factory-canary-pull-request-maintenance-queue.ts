import { DatabaseSync } from "node:sqlite";

import {
  factoryIdentifierSchema,
  factoryTimestampSchema,
  gitObjectIdSchema,
  sha256DigestSchema
} from "@agentlab/contracts";
import { z } from "zod";

import type {
  FactoryCanaryPullRequestMaintenanceQueue,
  FactoryCanaryPullRequestMaintenanceQueueItem,
  FactoryCanaryPullRequestMaintenanceQueuePage,
  FactoryCanaryPullRequestMaintenanceQueueQuery
} from "../../domain/factory-canary-pull-request-maintenance.js";
import { openSqliteDatabase, type SqliteDatabaseOptions } from "./sqlite-database.js";

const observationMediaType = "application/vnd.agentlab.pull-request-observation.v1+json";
const authorizationMediaType = "application/vnd.agentlab.pull-request-repair-authorization.v1+json";

const querySchema = z
  .object({
    repositoryId: factoryIdentifierSchema,
    observedAt: factoryTimestampSchema,
    maintenanceSlot: factoryTimestampSchema,
    limit: z.number().int().min(1).max(100)
  })
  .strict()
  .superRefine((query, context) => {
    if (query.maintenanceSlot > query.observedAt) {
      context.addIssue({
        code: "custom",
        path: ["maintenanceSlot"],
        message: "Maintenance slot cannot follow observation time."
      });
    }
  });

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
    currentPullRequestRecordDigest: sha256DigestSchema,
    currentHeadRevision: gitObjectIdSchema,
    source: z.enum(["unobserved", "observed-actionable"]),
    observationDigest: sha256DigestSchema.nullable(),
    observationDisposition: z.enum(["actionable"]).nullable(),
    observationResult: z.enum(["fail"]).nullable()
  })
  .strict()
  .superRefine((row, context) => {
    const resumed = row.source === "observed-actionable";
    if (
      resumed !== (row.observationDigest !== null) ||
      resumed !== (row.observationDisposition === "actionable") ||
      resumed !== (row.observationResult === "fail")
    ) {
      context.addIssue({
        code: "custom",
        path: ["source"],
        message: "Maintenance source does not match its durable observation checkpoint."
      });
    }
  });

/** SQLite projection joining canary PR lineage to slot-bound observation and repair evidence. */
export class SqliteFactoryCanaryPullRequestMaintenanceQueue implements FactoryCanaryPullRequestMaintenanceQueue {
  readonly #database: DatabaseSync;

  public constructor(databasePath: string, options: SqliteDatabaseOptions = {}) {
    this.#database = openSqliteDatabase(databasePath, options);
  }

  public listPending(
    queryInput: FactoryCanaryPullRequestMaintenanceQueueQuery
  ): Promise<FactoryCanaryPullRequestMaintenanceQueuePage> {
    const query = querySchema.parse(queryInput);
    const rows = this.#database
      .prepare(
        `WITH completed_updates AS (
           SELECT
             update_run.task_id AS taskId,
             remote.record_digest AS recordDigest,
             remote.head_revision AS headRevision,
             ROW_NUMBER() OVER (
               PARTITION BY update_run.task_id
               ORDER BY update_run.contract_repair_attempt DESC
             ) AS updateRank
           FROM factory_pull_request_updates AS update_run
           JOIN factory_pull_request_update_events AS remote
             ON remote.update_id = update_run.update_id
            AND remote.kind = 'remote-updated'
           WHERE (
             SELECT terminal.to_state
             FROM factory_pull_request_update_events AS terminal
             WHERE terminal.update_id = update_run.update_id
             ORDER BY terminal.sequence DESC
             LIMIT 1
           ) = 'completed'
         ),
         eligible AS (
           SELECT
             dispatch.task_id AS taskId,
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
             COALESCE(completed_update.recordDigest, dispatch_remote.record_digest)
               AS currentPullRequestRecordDigest,
             COALESCE(completed_update.headRevision, dispatch_remote.head_revision)
               AS currentHeadRevision,
             dispatch.broker_id AS brokerId
           FROM factory_pull_request_dispatches AS dispatch
           JOIN factory_pull_request_dispatch_events AS dispatch_remote
             ON dispatch_remote.dispatch_id = dispatch.dispatch_id
            AND dispatch_remote.kind = 'remote-observed'
           JOIN factory_canary_task_reservations AS reservation
             ON reservation.task_id = dispatch.task_id
            AND reservation.reservation_digest = dispatch.canary_reservation_digest
           JOIN factory_schedule_events AS finished
             ON finished.task_id = dispatch.task_id
            AND finished.kind = 'task-finished'
            AND json_extract(finished.event_json, '$.canaryReservationDigest')
              = reservation.reservation_digest
           JOIN factory_schedule_runs AS schedule_run ON schedule_run.run_id = finished.run_id
           LEFT JOIN completed_updates AS completed_update
             ON completed_update.taskId = dispatch.task_id
            AND completed_update.updateRank = 1
           WHERE json_extract(dispatch.dispatch_json, '$.schemaVersion')
               = 'agentlab.pull-request-dispatch.v2'
             AND reservation.repository_id = ?
             AND reservation.stage = 'brokered-draft-pr'
             AND json_extract(finished.event_json, '$.schemaVersion')
               = 'agentlab.schedule-event.v2'
             AND json_extract(finished.event_json, '$.result') = 'ready-for-broker'
             AND (
               SELECT task_event.to_state
               FROM factory_task_events AS task_event
               WHERE task_event.task_id = dispatch.task_id
               ORDER BY task_event.sequence DESC
               LIMIT 1
             ) = 'pr-open'
             AND (
               SELECT terminal.to_state
               FROM factory_pull_request_dispatch_events AS terminal
               WHERE terminal.dispatch_id = dispatch.dispatch_id
               ORDER BY terminal.sequence DESC
               LIMIT 1
             ) = 'completed'
             AND (
               SELECT terminal.to_state
               FROM factory_schedule_events AS terminal
               WHERE terminal.run_id = schedule_run.run_id
               ORDER BY terminal.sequence DESC
               LIMIT 1
             ) = 'completed'
         ),
         maintenance_observations AS (
           SELECT
             evidence.task_id AS taskId,
             evidence.sequence AS evidenceSequence,
             evidence.policy_bundle_digest AS factoryPolicyBundleDigest,
             json_extract(item.value, '$.subjectDigest') AS observationDigest,
             json_extract(item.value, '$.result') AS observationResult,
             json_extract(item.value, '$.producer.id') AS brokerId,
             (
               SELECT json_extract(claim.value, '$.value')
               FROM json_each(item.value, '$.claims') AS claim
               WHERE json_extract(claim.value, '$.name') = 'disposition'
               LIMIT 1
             ) AS disposition,
             (
               SELECT json_extract(claim.value, '$.value')
               FROM json_each(item.value, '$.claims') AS claim
               WHERE json_extract(claim.value, '$.name') = 'maintenance-slot'
               LIMIT 1
             ) AS maintenanceSlot,
             (
               SELECT json_extract(claim.value, '$.value')
               FROM json_each(item.value, '$.claims') AS claim
               WHERE json_extract(claim.value, '$.name') = 'head-revision'
               LIMIT 1
             ) AS headRevision,
             (
               SELECT json_extract(claim.value, '$.value')
               FROM json_each(item.value, '$.claims') AS claim
               WHERE json_extract(claim.value, '$.name') = 'pull-request-record-digest'
               LIMIT 1
             ) AS recordDigest,
             (
               SELECT json_extract(claim.value, '$.value')
               FROM json_each(item.value, '$.claims') AS claim
               WHERE json_extract(claim.value, '$.name') = 'canary-reservation-digest'
               LIMIT 1
             ) AS reservationDigest,
             (
               SELECT json_extract(claim.value, '$.value')
               FROM json_each(item.value, '$.claims') AS claim
               WHERE json_extract(claim.value, '$.name') = 'schedule-policy-digest'
               LIMIT 1
             ) AS schedulePolicyDigest,
             (
               SELECT json_extract(claim.value, '$.value')
               FROM json_each(item.value, '$.claims') AS claim
               WHERE json_extract(claim.value, '$.name') = 'role-identity-policy-digest'
               LIMIT 1
             ) AS roleIdentityPolicyDigest
           FROM factory_evidence_bundles AS evidence,
                json_each(evidence.bundle_json, '$.items') AS item
           WHERE json_extract(item.value, '$.artifact.mediaType') = ?
         ),
         ranked_observations AS (
           SELECT
             maintenance_observations.*,
             ROW_NUMBER() OVER (
               PARTITION BY taskId, maintenanceSlot, headRevision
               ORDER BY evidenceSequence DESC
             ) AS observationRank
           FROM maintenance_observations
         ),
         repair_authorizations AS (
           SELECT DISTINCT
             evidence.task_id AS taskId,
             (
               SELECT json_extract(claim.value, '$.value')
               FROM json_each(item.value, '$.claims') AS claim
               WHERE json_extract(claim.value, '$.name') = 'observation-digest'
               LIMIT 1
             ) AS observationDigest
           FROM factory_evidence_bundles AS evidence,
                json_each(evidence.bundle_json, '$.items') AS item
           WHERE json_extract(item.value, '$.artifact.mediaType') = ?
         ),
         observed AS (
           SELECT
             eligible.*,
             observation.observationDigest,
             observation.disposition AS observationDisposition,
             observation.observationResult,
             authorization.observationDigest AS authorizedObservationDigest
           FROM eligible
           LEFT JOIN ranked_observations AS observation
             ON observation.taskId = eligible.taskId
            AND observation.observationRank = 1
            AND observation.maintenanceSlot = ?
            AND observation.headRevision = eligible.currentHeadRevision
            AND observation.recordDigest = eligible.currentPullRequestRecordDigest
            AND observation.reservationDigest = eligible.reservationDigest
            AND observation.schedulePolicyDigest = eligible.schedulePolicyDigest
            AND observation.factoryPolicyBundleDigest = eligible.factoryPolicyBundleDigest
            AND observation.roleIdentityPolicyDigest = eligible.roleIdentityPolicyDigest
            AND observation.brokerId = eligible.brokerId
           LEFT JOIN repair_authorizations AS authorization
             ON authorization.taskId = eligible.taskId
            AND authorization.observationDigest = observation.observationDigest
         )
         SELECT
           taskId,
           reservationDigest,
           schedulePolicyDigest,
           factoryPolicyBundleDigest,
           roleIdentityPolicyDigest,
           handoffSchedulePolicyDigest,
           handoffFactoryPolicyBundleDigest,
           handoffRoleIdentityPolicyDigest,
           scheduledFor,
           finishedAt,
           reservedAt,
           expiresAt,
           currentPullRequestRecordDigest,
           currentHeadRevision,
           CASE
             WHEN observationDigest IS NULL THEN 'unobserved'
             ELSE 'observed-actionable'
           END AS source,
           observationDigest,
           CASE WHEN observationDigest IS NULL THEN NULL ELSE observationDisposition END
             AS observationDisposition,
           CASE WHEN observationDigest IS NULL THEN NULL ELSE observationResult END
             AS observationResult
         FROM observed
         WHERE observationDigest IS NULL OR (
           observationDisposition = 'actionable'
           AND authorizedObservationDigest IS NULL
         )
         ORDER BY
           CASE WHEN reservedAt <= ? AND ? < expiresAt THEN 0 ELSE 1 END,
           CASE WHEN observationDigest IS NULL THEN 1 ELSE 0 END,
           finishedAt,
           taskId
         LIMIT ?`
      )
      .all(
        query.repositoryId,
        observationMediaType,
        authorizationMediaType,
        query.maintenanceSlot,
        query.observedAt,
        query.observedAt,
        query.limit + 1
      ) as unknown[];
    const parsed = rows.map((row) => rowSchema.parse(row));
    const items = parsed.slice(0, query.limit).map(stripProjectionFields);
    assertUniqueTasks(items);
    return Promise.resolve({ items, truncated: parsed.length > query.limit });
  }

  public close(): void {
    this.#database.close();
  }
}

function stripProjectionFields(
  row: z.infer<typeof rowSchema>
): FactoryCanaryPullRequestMaintenanceQueueItem {
  return {
    taskId: row.taskId,
    reservationDigest: row.reservationDigest,
    schedulePolicyDigest: row.schedulePolicyDigest,
    factoryPolicyBundleDigest: row.factoryPolicyBundleDigest,
    roleIdentityPolicyDigest: row.roleIdentityPolicyDigest,
    handoffSchedulePolicyDigest: row.handoffSchedulePolicyDigest,
    handoffFactoryPolicyBundleDigest: row.handoffFactoryPolicyBundleDigest,
    handoffRoleIdentityPolicyDigest: row.handoffRoleIdentityPolicyDigest,
    scheduledFor: row.scheduledFor,
    finishedAt: row.finishedAt,
    reservedAt: row.reservedAt,
    expiresAt: row.expiresAt,
    currentPullRequestRecordDigest: row.currentPullRequestRecordDigest,
    currentHeadRevision: row.currentHeadRevision,
    source: row.source,
    observationDigest: row.observationDigest
  };
}

function assertUniqueTasks(items: readonly FactoryCanaryPullRequestMaintenanceQueueItem[]): void {
  const taskIds = new Set<string>();
  for (const item of items) {
    if (taskIds.has(item.taskId)) {
      throw new Error(`Factory task ${item.taskId} has multiple pending PR maintenance heads.`);
    }
    taskIds.add(item.taskId);
  }
}
