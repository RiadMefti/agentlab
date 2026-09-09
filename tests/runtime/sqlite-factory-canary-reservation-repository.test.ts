import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { latestSchemaVersion } from "../../packages/runtime/src/infrastructure/persistence/migrations.js";
import { SqliteFactoryCanaryRepository } from "../../packages/runtime/src/infrastructure/persistence/sqlite-factory-canary-repository.js";
import { SqliteFactoryCanaryReservationRepository } from "../../packages/runtime/src/infrastructure/persistence/sqlite-factory-canary-reservation-repository.js";
import { SqliteFactoryEvalAttestationRepository } from "../../packages/runtime/src/infrastructure/persistence/sqlite-factory-eval-attestation-repository.js";
import { SqliteFactoryEvaluationRepository } from "../../packages/runtime/src/infrastructure/persistence/sqlite-factory-evaluation-repository.js";
import { SqliteFactoryPreparationRepository } from "../../packages/runtime/src/infrastructure/persistence/sqlite-factory-preparation-repository.js";
import {
  testFactoryCanaryAdmissionFixture,
  testFactoryCanaryReservationDocument
} from "../helpers/factory-canary-admission.js";
import { testDigest } from "../helpers/factory.js";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe("SqliteFactoryCanaryReservationRepository", () => {
  it("persists idempotently and enforces exact authority plus aggregate cohort capacity", async () => {
    const databasePath = temporaryDatabase();
    const first = testFactoryCanaryAdmissionFixture();
    const repositories = await persistedAuthority(databasePath, first);
    const reservations = new SqliteFactoryCanaryReservationRepository(databasePath, {
      documents: first.documents
    });
    try {
      const correct = testFactoryCanaryReservationDocument(first);
      const tampered = first.documents.canaryTaskReservation({
        ...correct.value,
        budget: {
          ...correct.value.budget,
          maxCostMicrousd: correct.value.budget.maxCostMicrousd - 1
        }
      });
      expect(() => reservations.reserve(tampered)).toThrow(/identity mismatch/u);
      await expect(reservations.reserve(correct)).resolves.toMatchObject({
        status: "reserved",
        reservationDigest: correct.digest
      });
      await expect(reservations.reserve(correct)).resolves.toMatchObject({
        status: "existing",
        reservationDigest: correct.digest
      });
      await expect(reservations.findByTaskId(correct.value.taskId)).resolves.toEqual({
        reservation: correct.value,
        reservationDigest: correct.digest
      });
      await expect(reservations.findByReservationDigest(correct.digest)).resolves.toEqual({
        reservation: correct.value,
        reservationDigest: correct.digest
      });
      await expect(
        reservations.listByCohortDigest(correct.value.cohortDigest)
      ).resolves.toHaveLength(1);

      const second = testFactoryCanaryAdmissionFixture({
        taskId: "22222222-2222-4222-8222-222222222222",
        deduplicationKey: testDigest("e")
      });
      await repositories.preparations.register(second.request, second.authority, second.registered);
      const secondReservation = testFactoryCanaryReservationDocument(second, {
        reservationId: "20000000-0000-4000-8000-000000000010"
      });
      expect(() => reservations.reserve(secondReservation)).toThrow(/capacity exceeded/u);
    } finally {
      reservations.close();
      repositories.canaries.close();
      repositories.attestations.close();
      repositories.evaluations.close();
      repositories.preparations.close();
    }

    const database = new DatabaseSync(databasePath);
    try {
      expect(() =>
        database.prepare("UPDATE factory_canary_task_reservations SET stage = stage").run()
      ).toThrow(/immutable/u);
      expect(() => database.prepare("DELETE FROM factory_canary_task_reservations").run()).toThrow(
        /immutable/u
      );
      expect(
        (database.prepare("PRAGMA user_version").get() as { user_version: number }).user_version
      ).toBe(latestSchemaVersion);
    } finally {
      database.close();
    }
  });

  it("migrates a version-14 ledger forward without touching earlier records", () => {
    const databasePath = temporaryDatabase();
    new SqliteFactoryCanaryReservationRepository(databasePath).close();
    const legacy = new DatabaseSync(databasePath);
    try {
      legacy.exec(`
        DROP TRIGGER factory_schedule_events_daily_quota_finish_guard;
        DROP TRIGGER factory_schedule_events_daily_quota_claim_guard;
        DROP TABLE factory_daily_quota_reservations;
        DROP TRIGGER factory_pull_request_dispatches_canary_guard;
        DROP INDEX factory_pull_request_dispatches_canary_idx;
        ALTER TABLE factory_pull_request_dispatches DROP COLUMN canary_reservation_digest;
        DROP TRIGGER factory_schedule_events_canary_finish_guard;
        DROP TRIGGER factory_schedule_events_canary_claim_guard;
        DROP TABLE factory_canary_task_reservations;
        DROP TABLE factory_eval_production_events;
        DROP TABLE factory_eval_production_jobs;
        DROP TABLE factory_maintenance_discovery_events;
        DROP TABLE factory_maintenance_discovery_runs;
        DROP TABLE factory_external_pr_replacement_draft_records;
        DROP TABLE factory_external_pr_replacement_draft_events;
        DROP TABLE factory_external_pr_replacement_draft_runs;
        DROP TABLE factory_external_pr_repair_qualification_bundles;
        DROP TABLE factory_external_pr_repair_qualification_events;
        DROP TABLE factory_external_pr_repair_qualification_runs;
        DROP TABLE factory_external_pr_repair_execution_bundles;
        DROP TABLE factory_external_pr_repair_execution_events;
        DROP TABLE factory_external_pr_repair_execution_runs;
        DROP TABLE factory_external_pr_repair_authorizations;
        DROP TABLE factory_external_pr_repair_decisions;
        DROP TABLE factory_external_pr_feedback_records;
        DROP TABLE factory_external_pr_feedback_events;
        DROP TABLE factory_incident_containments;
        DROP TABLE factory_autonomous_merge_records;
        DROP TABLE factory_autonomous_merge_events;
        DROP TABLE factory_autonomous_merge_runs;
        DROP TABLE factory_ledger_operation_receipts; DROP TABLE factory_ledger_operation_claims; DROP TABLE factory_ledger_operations; DROP TABLE factory_ledger_artifact_reservations;
        DROP TABLE factory_ledger_authority_receipts;
        DROP TABLE factory_merge_control_events;
        DROP TRIGGER factory_control_events_identity_guard;
        DROP TABLE factory_external_pr_feedback_runs;
        DROP TABLE factory_external_pr_review_bundles;
        DROP TABLE factory_external_pr_review_events;
        DROP TABLE factory_external_pr_review_runs;
        DROP TABLE factory_external_pr_discovery_candidates;
        DROP TABLE factory_external_pr_discovery_snapshots;
        DROP TABLE factory_external_pr_discovery_events;
        DROP TABLE factory_external_pr_discovery_runs;
        PRAGMA user_version = 14;
      `);
    } finally {
      legacy.close();
    }

    const migrated = new SqliteFactoryCanaryReservationRepository(databasePath);
    migrated.close();
    const database = new DatabaseSync(databasePath);
    try {
      expect(
        (database.prepare("PRAGMA user_version").get() as { user_version: number }).user_version
      ).toBe(latestSchemaVersion);
      expect(
        database
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'factory_canary_task_reservations'"
          )
          .get()
      ).toEqual({ name: "factory_canary_task_reservations" });
    } finally {
      database.close();
    }
  });
});

async function persistedAuthority(
  databasePath: string,
  fixture: ReturnType<typeof testFactoryCanaryAdmissionFixture>
) {
  const evaluations = new SqliteFactoryEvaluationRepository(databasePath, {
    documents: fixture.documents
  });
  await evaluations.record(fixture.evaluation.run, fixture.evaluation.assessment);
  const verifier = {
    verify: () =>
      Promise.resolve({
        keyId: fixture.attestation.attestation.keyId,
        payload: Buffer.from(
          fixture.attestation.attestation.signedAttestation.envelope.payload,
          "base64"
        ).toString("utf8")
      })
  };
  const attestations = new SqliteFactoryEvalAttestationRepository(databasePath, {
    evaluations,
    verifier,
    expectedRoleIdentityPolicyDigest:
      fixture.attestation.attestation.signedAttestation.statement.predicate
        .roleIdentityPolicyDigest,
    documents: fixture.documents
  });
  await attestations.record(
    fixture.documents.evalAttestationRecord(fixture.attestation.attestation)
  );
  const canaries = new SqliteFactoryCanaryRepository(databasePath, {
    evaluations,
    attestations,
    documents: fixture.documents
  });
  await canaries.authorize(fixture.canary.approval, fixture.canary.cohort);
  const preparations = new SqliteFactoryPreparationRepository(databasePath, {
    documents: fixture.documents
  });
  await preparations.register(fixture.request, fixture.authority, fixture.registered);
  return { evaluations, attestations, canaries, preparations };
}

function temporaryDatabase(): string {
  const root = mkdtempSync(join(tmpdir(), "agentlab-factory-canary-reservation-"));
  temporaryRoots.push(root);
  return join(root, "agentlab.sqlite");
}
