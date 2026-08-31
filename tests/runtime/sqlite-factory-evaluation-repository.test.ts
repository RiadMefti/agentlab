import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { latestSchemaVersion } from "../../packages/runtime/src/infrastructure/persistence/migrations.js";
import { SqliteFactoryCanaryRepository } from "../../packages/runtime/src/infrastructure/persistence/sqlite-factory-canary-repository.js";
import { SqliteFactoryEvaluationRepository } from "../../packages/runtime/src/infrastructure/persistence/sqlite-factory-evaluation-repository.js";
import {
  testEvalDigest,
  testFactoryCanaryDocuments,
  testFactoryEvalDocuments
} from "../helpers/factory-evaluation.js";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe("SQLite factory evaluation repositories", () => {
  it("persists and reloads one immutable eval run and deterministic assessment", async () => {
    const databasePath = temporaryDatabase();
    const repository = new SqliteFactoryEvaluationRepository(databasePath);
    const fixture = testFactoryEvalDocuments();
    try {
      await expect(repository.record(fixture.run, fixture.assessment)).resolves.toEqual(
        fixture.snapshot
      );
      await expect(repository.findByRunId(fixture.run.value.runId)).resolves.toEqual(
        fixture.snapshot
      );
      await expect(repository.findByAssessmentDigest(fixture.assessment.digest)).resolves.toEqual(
        fixture.snapshot
      );
      expect(() => repository.record({ ...fixture.run, json: "{}" }, fixture.assessment)).toThrow(
        /not canonical/u
      );
    } finally {
      repository.close();
    }

    const database = new DatabaseSync(databasePath);
    try {
      expect(() =>
        database.prepare("UPDATE factory_eval_runs SET completed_at = completed_at").run()
      ).toThrow(/immutable/u);
      expect(() => database.prepare("DELETE FROM factory_eval_assessments").run()).toThrow(
        /immutable/u
      );
      expect(() =>
        database
          .prepare(
            `INSERT INTO factory_eval_runs (
              run_id, run_digest, suite_digest, baseline_candidate_digest,
              challenger_candidate_digest, started_at, completed_at, correlation_id, run_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            "10000000-0000-4000-8000-000000000099",
            testEvalDigest(990),
            testEvalDigest(991),
            fixture.run.value.baselineCandidateDigest,
            fixture.run.value.challengerCandidateDigest,
            fixture.run.value.startedAt,
            fixture.run.value.completedAt,
            fixture.run.value.correlationId,
            fixture.run.json
          )
      ).toThrow(/identity mismatch/u);
    } finally {
      database.close();
    }
  });

  it("persists one human approval and one structurally non-release cohort", async () => {
    const databasePath = temporaryDatabase();
    const evaluations = new SqliteFactoryEvaluationRepository(databasePath);
    const fixture = testFactoryEvalDocuments();
    await evaluations.record(fixture.run, fixture.assessment);
    const canaries = new SqliteFactoryCanaryRepository(databasePath, { evaluations });
    const authority = testFactoryCanaryDocuments(fixture.snapshot);
    try {
      const expected = {
        approval: authority.approval.value,
        approvalDigest: authority.approval.digest,
        cohort: authority.cohort.value,
        cohortDigest: authority.cohort.digest
      };
      await expect(canaries.authorize(authority.approval, authority.cohort)).resolves.toEqual(
        expected
      );
      await expect(canaries.findByAssessmentDigest(fixture.assessment.digest)).resolves.toEqual(
        expected
      );
      await expect(canaries.findByCohortDigest(authority.cohort.digest)).resolves.toEqual(expected);

      const oversized = testFactoryCanaryDocuments(fixture.snapshot, {
        approvalId: "10000000-0000-4000-8000-000000000006",
        cohortId: "10000000-0000-4000-8000-000000000007",
        maximumTasks: 5
      });
      await expect(canaries.authorize(oversized.approval, oversized.cohort)).rejects.toThrow(
        /exceeds its exact passing eval authority/u
      );
    } finally {
      canaries.close();
      evaluations.close();
    }

    const database = new DatabaseSync(databasePath);
    try {
      expect(() =>
        database.prepare("UPDATE factory_canary_approvals SET stage = stage").run()
      ).toThrow(/immutable/u);
      expect(() => database.prepare("DELETE FROM factory_canary_cohorts").run()).toThrow(
        /immutable/u
      );
    } finally {
      database.close();
    }
  });

  it("rejects a canary cohort whose eval-run digest does not match its assessment", async () => {
    const databasePath = temporaryDatabase();
    const evaluations = new SqliteFactoryEvaluationRepository(databasePath);
    const fixture = testFactoryEvalDocuments();
    await evaluations.record(fixture.run, fixture.assessment);
    evaluations.close();

    const authority = testFactoryCanaryDocuments(fixture.snapshot);
    const mismatchedRunDigest = testEvalDigest(999);
    const mismatchedCohortJson = authority.cohort.json.replace(
      authority.cohort.value.runDigest,
      mismatchedRunDigest
    );
    const database = new DatabaseSync(databasePath);
    try {
      database
        .prepare(
          `INSERT INTO factory_canary_approvals (
            approval_id, approval_digest, assessment_digest, challenger_candidate_digest,
            stage, actor_id, occurred_at, expires_at, approval_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          authority.approval.value.approvalId,
          authority.approval.digest,
          authority.approval.value.assessmentDigest,
          authority.approval.value.challengerCandidateDigest,
          authority.approval.value.stage,
          authority.approval.value.actor.id,
          authority.approval.value.occurredAt,
          authority.approval.value.expiresAt,
          authority.approval.json
        );
      expect(() =>
        database
          .prepare(
            `INSERT INTO factory_canary_cohorts (
              cohort_id, cohort_digest, assessment_digest, run_digest, approval_digest,
              challenger_candidate_digest, stage, issued_at, expires_at, cohort_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            authority.cohort.value.cohortId,
            authority.cohort.digest,
            authority.cohort.value.assessmentDigest,
            mismatchedRunDigest,
            authority.cohort.value.approvalDigest,
            authority.cohort.value.challengerCandidateDigest,
            authority.cohort.value.stage,
            authority.cohort.value.issuedAt,
            authority.cohort.value.expiresAt,
            mismatchedCohortJson
          )
      ).toThrow(/identity mismatch/u);
    } finally {
      database.close();
    }
  });

  it("migrates a version-11 database and retains all earlier schema", async () => {
    const databasePath = temporaryDatabase();
    new SqliteFactoryEvaluationRepository(databasePath).close();
    const legacy = new DatabaseSync(databasePath);
    try {
      legacy.exec(`
        DROP TABLE factory_eval_attestations;
        DROP TABLE factory_canary_cohorts;
        DROP TABLE factory_canary_approvals;
        DROP TABLE factory_eval_assessments;
        DROP TABLE factory_eval_runs;
        PRAGMA user_version = 11;
      `);
    } finally {
      legacy.close();
    }

    const migrated = new SqliteFactoryEvaluationRepository(databasePath);
    try {
      const fixture = testFactoryEvalDocuments();
      await expect(migrated.record(fixture.run, fixture.assessment)).resolves.toEqual(
        fixture.snapshot
      );
      const database = new DatabaseSync(databasePath);
      try {
        expect(
          (database.prepare("PRAGMA user_version").get() as { user_version: number }).user_version
        ).toBe(latestSchemaVersion);
        expect(
          database.prepare("SELECT COUNT(*) AS count FROM factory_schedule_runs").get()
        ).toEqual({ count: 0 });
      } finally {
        database.close();
      }
    } finally {
      migrated.close();
    }
  });
});

function temporaryDatabase(): string {
  const root = mkdtempSync(join(tmpdir(), "agentlab-factory-evaluation-"));
  temporaryRoots.push(root);
  return join(root, "agentlab.sqlite");
}
