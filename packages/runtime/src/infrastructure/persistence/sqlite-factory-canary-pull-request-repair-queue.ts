import { DatabaseSync } from "node:sqlite";

import {
  factoryIdentifierSchema,
  factoryTaskStateSchema,
  factoryTimestampSchema,
  gitObjectIdSchema,
  sha256DigestSchema
} from "@agentlab/contracts";
import { z } from "zod";

import type {
  FactoryCanaryPullRequestRepairQueue,
  FactoryCanaryPullRequestRepairQueueItem,
  FactoryCanaryPullRequestRepairQueuePage,
  FactoryCanaryPullRequestRepairQueueQuery
} from "../../domain/factory-canary-pull-request-repair.js";
import { openSqliteDatabase, type SqliteDatabaseOptions } from "./sqlite-database.js";

const observationMediaType = "application/vnd.agentlab.pull-request-observation.v1+json";
const authorizationMediaType = "application/vnd.agentlab.pull-request-repair-authorization.v1+json";

const querySchema = z
  .object({
    observedAt: factoryTimestampSchema,
    schedulePolicyDigest: sha256DigestSchema,
    factoryPolicyBundleDigest: sha256DigestSchema,
    roleIdentityPolicyDigest: sha256DigestSchema,
    limit: z.number().int().min(1).max(100)
  })
  .strict();

const recoveryRowSchema = z
  .object({
    source: z.literal("recoverable"),
    taskId: z.uuid(),
    repositoryId: factoryIdentifierSchema,
    authorizationDigest: sha256DigestSchema,
    repairRunDigest: sha256DigestSchema,
    runPolicyBundleDigest: sha256DigestSchema,
    repairState: z.enum(["ready", "workspace-active", "operation-active", "abandoned"]),
    taskState: factoryTaskStateSchema,
    runCreatedAt: factoryTimestampSchema,
    lastEventAt: factoryTimestampSchema
  })
  .strict();

const authorizationRowSchema = z
  .object({
    source: z.literal("authorized"),
    taskId: z.uuid(),
    repositoryId: factoryIdentifierSchema,
    authorizationDigest: sha256DigestSchema,
    observationDigest: sha256DigestSchema,
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
    maintenanceSlot: factoryTimestampSchema,
    observationCreatedAt: factoryTimestampSchema,
    authorizationCreatedAt: factoryTimestampSchema,
    pullRequestRecordDigest: sha256DigestSchema,
    headRevision: gitObjectIdSchema
  })
  .strict();

/** SQLite projection that gives cleanup priority over fresh canary repair authority. */
export class SqliteFactoryCanaryPullRequestRepairQueue implements FactoryCanaryPullRequestRepairQueue {
  readonly #database: DatabaseSync;

  public constructor(databasePath: string, options: SqliteDatabaseOptions = {}) {
    this.#database = openSqliteDatabase(databasePath, options);
  }

  public listPending(
    queryInput: FactoryCanaryPullRequestRepairQueueQuery
  ): Promise<FactoryCanaryPullRequestRepairQueuePage> {
    const query = querySchema.parse(queryInput);
    const recoverable = this.#recoverable(query.limit + 1);
    if (recoverable.length > query.limit) {
      const items = recoverable.slice(0, query.limit);
      assertUniqueAuthorizations(items);
      return Promise.resolve({ items, truncated: true });
    }
    const authorized = this.#authorized(query, query.limit + 1 - recoverable.length);
    const combined: readonly FactoryCanaryPullRequestRepairQueueItem[] = [
      ...recoverable,
      ...authorized
    ];
    const items = combined.slice(0, query.limit);
    assertUniqueAuthorizations(items);
    return Promise.resolve({ items, truncated: combined.length > query.limit });
  }

  public close(): void {
    this.#database.close();
  }

  #recoverable(limit: number): readonly FactoryCanaryPullRequestRepairQueueItem[] {
    const rows = this.#database
      .prepare(
        `WITH ranked_repair_events AS (
           SELECT
             event.*,
             ROW_NUMBER() OVER (
               PARTITION BY event.run_id
               ORDER BY event.sequence DESC
             ) AS eventRank
           FROM factory_pull_request_repair_events AS event
         ),
         ranked_task_events AS (
           SELECT
             event.*,
             ROW_NUMBER() OVER (
               PARTITION BY event.task_id
               ORDER BY event.sequence DESC
             ) AS eventRank
           FROM factory_task_events AS event
         )
         SELECT
           'recoverable' AS source,
           run.task_id AS taskId,
           run.repository_id AS repositoryId,
           run.authorization_digest AS authorizationDigest,
           run.run_digest AS repairRunDigest,
           run.policy_bundle_digest AS runPolicyBundleDigest,
           repair_event.to_state AS repairState,
           task_event.to_state AS taskState,
           run.created_at AS runCreatedAt,
           repair_event.occurred_at AS lastEventAt
         FROM factory_pull_request_repair_runs AS run
         JOIN ranked_repair_events AS repair_event
           ON repair_event.run_id = run.run_id
          AND repair_event.eventRank = 1
         JOIN ranked_task_events AS task_event
           ON task_event.task_id = run.task_id
          AND task_event.eventRank = 1
         WHERE repair_event.to_state IN ('ready', 'workspace-active', 'operation-active')
            OR (
              repair_event.to_state = 'abandoned'
              AND task_event.to_state NOT IN (
                'completed', 'needs-attention', 'rejected', 'cancelled', 'expired', 'failed',
                'quarantined', 'rolled-back'
              )
            )
         ORDER BY run.created_at, run.task_id, run.contract_repair_attempt
         LIMIT ?`
      )
      .all(limit) as unknown[];
    return rows.map((row) => recoveryRowSchema.parse(row));
  }

  #authorized(
    query: z.infer<typeof querySchema>,
    limit: number
  ): readonly FactoryCanaryPullRequestRepairQueueItem[] {
    if (limit < 1) return [];
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
             reservation.repository_id AS repositoryId,
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
               AS pullRequestRecordDigest,
             COALESCE(completed_update.headRevision, dispatch_remote.head_revision)
               AS headRevision,
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
             AND reservation.stage = 'brokered-draft-pr'
             AND reservation.schedule_policy_digest = ?
             AND reservation.policy_bundle_digest = ?
             AND reservation.role_identity_policy_digest = ?
             AND schedule_run.schedule_policy_digest = ?
             AND schedule_run.factory_policy_bundle_digest = ?
             AND json_extract(schedule_run.run_json, '$.roleIdentityPolicyDigest') = ?
             AND json_extract(finished.event_json, '$.schemaVersion') IN (
               'agentlab.schedule-event.v2', 'agentlab.schedule-event.v3'
             )
             AND json_extract(finished.event_json, '$.result') = 'ready-for-broker'
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
             AND (
               SELECT task_event.to_state
               FROM factory_task_events AS task_event
               WHERE task_event.task_id = dispatch.task_id
               ORDER BY task_event.sequence DESC
               LIMIT 1
             ) = 'pr-open'
         ),
         maintenance_observations AS (
           SELECT
             evidence.task_id AS taskId,
             evidence.sequence AS evidenceSequence,
             evidence.policy_bundle_digest AS factoryPolicyBundleDigest,
             json_extract(item.value, '$.subjectDigest') AS observationDigest,
             json_extract(item.value, '$.result') AS observationResult,
             json_extract(item.value, '$.producer.kind') AS producerKind,
             json_extract(item.value, '$.producer.role') AS producerRole,
             json_extract(item.value, '$.producer.id') AS brokerId,
             json_extract(item.value, '$.createdAt') AS observationCreatedAt,
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
             ) AS pullRequestRecordDigest,
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
           SELECT
             evidence.task_id AS taskId,
             evidence.sequence AS evidenceSequence,
             evidence.policy_bundle_digest AS factoryPolicyBundleDigest,
             json_extract(item.value, '$.subjectDigest') AS authorizationDigest,
             json_extract(item.value, '$.result') AS authorizationResult,
             json_extract(item.value, '$.producer.kind') AS producerKind,
             json_extract(item.value, '$.producer.role') AS producerRole,
             json_extract(item.value, '$.producer.id') AS brokerId,
             json_extract(item.value, '$.createdAt') AS authorizationCreatedAt,
             (
               SELECT json_extract(claim.value, '$.value')
               FROM json_each(item.value, '$.claims') AS claim
               WHERE json_extract(claim.value, '$.name') = 'observation-digest'
               LIMIT 1
             ) AS observationDigest,
             (
               SELECT json_extract(claim.value, '$.value')
               FROM json_each(item.value, '$.claims') AS claim
               WHERE json_extract(claim.value, '$.name') = 'pull-request-record-digest'
               LIMIT 1
             ) AS pullRequestRecordDigest,
             (
               SELECT json_extract(claim.value, '$.value')
               FROM json_each(item.value, '$.claims') AS claim
               WHERE json_extract(claim.value, '$.name') = 'head-revision'
               LIMIT 1
             ) AS headRevision
           FROM factory_evidence_bundles AS evidence,
                json_each(evidence.bundle_json, '$.items') AS item
           WHERE json_extract(item.value, '$.artifact.mediaType') = ?
         ),
         ranked_authorizations AS (
           SELECT
             repair_authorizations.*,
             ROW_NUMBER() OVER (
               PARTITION BY taskId, observationDigest
               ORDER BY evidenceSequence DESC
             ) AS authorizationRank
           FROM repair_authorizations
         )
         SELECT
           'authorized' AS source,
           eligible.taskId,
           eligible.repositoryId,
           authorization.authorizationDigest,
           observation.observationDigest,
           eligible.reservationDigest,
           eligible.schedulePolicyDigest,
           eligible.factoryPolicyBundleDigest,
           eligible.roleIdentityPolicyDigest,
           eligible.handoffSchedulePolicyDigest,
           eligible.handoffFactoryPolicyBundleDigest,
           eligible.handoffRoleIdentityPolicyDigest,
           eligible.scheduledFor,
           eligible.finishedAt,
           eligible.reservedAt,
           eligible.expiresAt,
           observation.maintenanceSlot,
           observation.observationCreatedAt,
           authorization.authorizationCreatedAt,
           eligible.pullRequestRecordDigest,
           eligible.headRevision
         FROM eligible
         JOIN ranked_observations AS observation
           ON observation.taskId = eligible.taskId
          AND observation.observationRank = 1
          AND observation.observationResult = 'fail'
          AND observation.disposition = 'actionable'
          AND observation.producerKind = 'broker'
          AND observation.producerRole = 'pr-broker'
          AND observation.brokerId = eligible.brokerId
          AND observation.factoryPolicyBundleDigest = eligible.factoryPolicyBundleDigest
          AND observation.headRevision = eligible.headRevision
          AND observation.pullRequestRecordDigest = eligible.pullRequestRecordDigest
          AND observation.reservationDigest = eligible.reservationDigest
          AND observation.schedulePolicyDigest = eligible.schedulePolicyDigest
          AND observation.roleIdentityPolicyDigest = eligible.roleIdentityPolicyDigest
         JOIN ranked_authorizations AS authorization
           ON authorization.taskId = eligible.taskId
          AND authorization.authorizationRank = 1
          AND authorization.observationDigest = observation.observationDigest
          AND authorization.authorizationResult = 'pass'
          AND authorization.producerKind = 'broker'
          AND authorization.producerRole = 'pr-broker'
          AND authorization.brokerId = eligible.brokerId
          AND authorization.factoryPolicyBundleDigest = eligible.factoryPolicyBundleDigest
          AND authorization.pullRequestRecordDigest = eligible.pullRequestRecordDigest
          AND authorization.headRevision = eligible.headRevision
          AND authorization.authorizationCreatedAt >= observation.observationCreatedAt
         LEFT JOIN factory_pull_request_repair_runs AS repair_run
           ON repair_run.authorization_digest = authorization.authorizationDigest
         WHERE repair_run.run_id IS NULL
         ORDER BY
           CASE WHEN eligible.reservedAt <= ? AND ? < eligible.expiresAt THEN 0 ELSE 1 END,
           authorization.authorizationCreatedAt,
           eligible.taskId
         LIMIT ?`
      )
      .all(
        query.schedulePolicyDigest,
        query.factoryPolicyBundleDigest,
        query.roleIdentityPolicyDigest,
        query.schedulePolicyDigest,
        query.factoryPolicyBundleDigest,
        query.roleIdentityPolicyDigest,
        observationMediaType,
        authorizationMediaType,
        query.observedAt,
        query.observedAt,
        limit
      ) as unknown[];
    return rows.map((row) => authorizationRowSchema.parse(row));
  }
}

function assertUniqueAuthorizations(
  items: readonly FactoryCanaryPullRequestRepairQueueItem[]
): void {
  const digests = new Set<string>();
  for (const item of items) {
    if (digests.has(item.authorizationDigest)) {
      throw new Error(`Repair authorization ${item.authorizationDigest} appears more than once.`);
    }
    digests.add(item.authorizationDigest);
  }
}
