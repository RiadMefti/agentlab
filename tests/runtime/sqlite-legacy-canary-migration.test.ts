import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import { describe, expect, it, vi } from "vitest";

import {
  latestSchemaVersion,
  migrate
} from "../../packages/runtime/src/infrastructure/persistence/migrations.js";
import {
  testFactoryCanaryDocuments,
  testFactoryEvalDocuments
} from "../helpers/factory-evaluation.js";

describe("legacy database startup migration", () => {
  for (const version of [4, 12, 16]) {
    it(`opens schema ${String(version)} without losing saved projects or weakening canary guards`, () => {
      const database = historicalDatabase(version);
      try {
        if (version >= 12) removeLegacyRunDigest(database, version);
        insertProject(database);
        const projects = database.prepare("SELECT * FROM conversations").all();

        migrate(database);

        expect(userVersion(database)).toBe(latestSchemaVersion);
        expect(database.prepare("SELECT * FROM conversations").all()).toEqual(projects);
        expect(database.prepare("PRAGMA quick_check").all()).toEqual([{ quick_check: "ok" }]);
        expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
        expect(database.prepare("PRAGMA table_info(factory_canary_cohorts)").all()).toContainEqual(
          expect.objectContaining({ name: "run_digest", type: "TEXT", notnull: 1 })
        );
        expect(
          database
            .prepare("SELECT sql FROM sqlite_schema WHERE name = 'factory_canary_cohorts'")
            .get()
        ).toEqual(
          expect.objectContaining({ sql: expect.stringContaining("length(run_digest) = 71") })
        );
        expect(
          database
            .prepare(
              "SELECT name FROM sqlite_schema WHERE tbl_name = 'factory_canary_cohorts' AND type = 'trigger' ORDER BY name"
            )
            .all()
        ).toEqual([
          { name: "factory_canary_cohorts_identity_guard" },
          { name: "factory_canary_cohorts_no_delete" },
          { name: "factory_canary_cohorts_no_update" }
        ]);
        expect(() => {
          insert(database, "factory_canary_cohorts", cohortRow());
        }).toThrow(/identity mismatch/u);
      } finally {
        database.close();
      }
    });
  }

  it("leaves modern layouts unchanged on repeated startup", () => {
    const database = historicalDatabase(latestSchemaVersion);
    try {
      const before = database.prepare("SELECT * FROM sqlite_schema ORDER BY name").all();
      migrate(database);
      migrate(database);
      expect(database.prepare("SELECT * FROM sqlite_schema ORDER BY name").all()).toEqual(before);
      expect(userVersion(database)).toBe(latestSchemaVersion);
    } finally {
      database.close();
    }
  });

  it("refuses populated legacy authority before changing any schema, record, or version", () => {
    const database = historicalDatabase(12);
    try {
      populateCanary(database);
      removeLegacyRunDigest(database, 12);
      const before = legacySnapshot(database);

      expect(() => {
        migrate(database);
      }).toThrow(/contains immutable records; manual recovery/u);

      expect(legacySnapshot(database)).toEqual(before);
      expect(userVersion(database)).toBe(12);
      expect(() => {
        database.exec("DELETE FROM factory_canary_cohorts");
      }).toThrow(/immutable/u);
    } finally {
      database.close();
    }
  });

  it("refuses future schemas before applying the legacy compatibility repair", () => {
    const database = historicalDatabase(12);
    try {
      removeLegacyRunDigest(database, 12);
      database.exec(`PRAGMA user_version = ${String(latestSchemaVersion + 1)}`);
      const before = legacySnapshot(database);

      expect(() => {
        migrate(database);
      }).toThrow(/is newer than this app supports/u);

      expect(legacySnapshot(database)).toEqual(before);
      expect(userVersion(database)).toBe(latestSchemaVersion + 1);
    } finally {
      database.close();
    }
  });

  it("refuses an unrecognized legacy layout without partially adding the column", () => {
    const database = historicalDatabase(12);
    try {
      removeLegacyRunDigest(database, 12);
      database.exec("ALTER TABLE factory_canary_cohorts ADD COLUMN unexpected TEXT");
      const before = legacySnapshot(database);

      expect(() => {
        migrate(database);
      }).toThrow(/unsupported column layout/u);

      expect(legacySnapshot(database)).toEqual(before);
      expect(userVersion(database)).toBe(12);
    } finally {
      database.close();
    }
  });
});

function userVersion(database: DatabaseSync): number {
  return (database.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
}

/** Stops after a committed historical migration, before any later migration can run. */
function historicalDatabase(version: number): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  const complete = new Error("Historical migration complete.");
  const execute = database.exec.bind(database);
  const spy = vi.spyOn(database, "exec").mockImplementation((sql) => {
    execute(sql);
    if (userVersion(database) === version) throw complete;
  });
  try {
    expect(() => {
      migrate(database);
    }).toThrow(complete);
  } finally {
    spy.mockRestore();
  }
  expect(userVersion(database)).toBe(version);
  return database;
}

/** Reconstructs the original v12 layout, or the bad v14 guard left at v16 by failed upgrades. */
function removeLegacyRunDigest(database: DatabaseSync, version: number): void {
  const row = database
    .prepare("SELECT sql FROM sqlite_schema WHERE name = 'factory_canary_cohorts_identity_guard'")
    .get() as { sql: string };
  database.exec("DROP TRIGGER factory_canary_cohorts_identity_guard");
  database.exec("ALTER TABLE factory_canary_cohorts DROP COLUMN run_digest");
  const guard =
    version < 14
      ? row.sql
          .replace(/ {8}NEW\.run_digest IS NOT \([\s\S]*?\n {8}\) OR\n/u, "")
          .replace(
            / {8}json_extract\(NEW\.cohort_json, '\$\.runDigest'\) IS NOT NEW\.run_digest OR\n/u,
            ""
          )
      : row.sql;
  if (version < 14) expect(guard).not.toContain("run_digest");
  database.exec(guard);
}

function legacySnapshot(database: DatabaseSync): unknown {
  return {
    schema: database.prepare("SELECT * FROM sqlite_schema ORDER BY name").all(),
    cohorts: database.prepare("SELECT * FROM factory_canary_cohorts").all(),
    approvals: database.prepare("SELECT * FROM factory_canary_approvals").all(),
    runs: database.prepare("SELECT * FROM factory_eval_runs").all(),
    assessments: database.prepare("SELECT * FROM factory_eval_assessments").all()
  };
}

function insert(database: DatabaseSync, table: string, row: Record<string, SQLInputValue>): void {
  const columns = Object.keys(row);
  database
    .prepare(
      `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`
    )
    .run(...Object.values(row));
}

function insertProject(database: DatabaseSync): void {
  insert(database, "conversations", {
    id: "11111111-1111-4111-8111-111111111111",
    title: "Preserved project",
    provider: "codex",
    model: null,
    reasoning: null,
    captain_session_name: "agentlab__11111111-1111-4111-8111-111111111111__captain__codex",
    created_at: "2026-08-30T11:00:00.000Z",
    updated_at: "2026-08-30T11:00:00.000Z",
    workspace_path: "/work/preserved-project",
    lifecycle_state: "active",
    ownership_mode: "legacy-name",
    ownership_nonce: null
  });
}

function cohortRow(): Record<string, SQLInputValue> {
  const evaluation = testFactoryEvalDocuments();
  const { cohort } = testFactoryCanaryDocuments(evaluation.snapshot);
  return {
    cohort_id: cohort.value.cohortId,
    cohort_digest: cohort.digest,
    assessment_digest: cohort.value.assessmentDigest,
    run_digest: cohort.value.runDigest,
    approval_digest: cohort.value.approvalDigest,
    challenger_candidate_digest: cohort.value.challengerCandidateDigest,
    stage: cohort.value.stage,
    issued_at: cohort.value.issuedAt,
    expires_at: cohort.value.expiresAt,
    cohort_json: cohort.json
  };
}

function populateCanary(database: DatabaseSync): void {
  const { run, assessment, snapshot } = testFactoryEvalDocuments();
  const { approval } = testFactoryCanaryDocuments(snapshot);
  insert(database, "factory_eval_runs", {
    run_id: run.value.runId,
    run_digest: run.digest,
    suite_digest: run.value.suiteDigest,
    baseline_candidate_digest: run.value.baselineCandidateDigest,
    challenger_candidate_digest: run.value.challengerCandidateDigest,
    started_at: run.value.startedAt,
    completed_at: run.value.completedAt,
    correlation_id: run.value.correlationId,
    run_json: run.json
  });
  insert(database, "factory_eval_assessments", {
    assessment_id: assessment.value.assessmentId,
    assessment_digest: assessment.digest,
    run_id: assessment.value.runId,
    run_digest: assessment.value.runDigest,
    decision: assessment.value.decision,
    assessed_at: assessment.value.assessedAt,
    assessment_json: assessment.json
  });
  insert(database, "factory_canary_approvals", {
    approval_id: approval.value.approvalId,
    approval_digest: approval.digest,
    assessment_digest: approval.value.assessmentDigest,
    challenger_candidate_digest: approval.value.challengerCandidateDigest,
    stage: approval.value.stage,
    actor_id: approval.value.actor.id,
    occurred_at: approval.value.occurredAt,
    expires_at: approval.value.expiresAt,
    approval_json: approval.json
  });
  insert(database, "factory_canary_cohorts", cohortRow());
}
