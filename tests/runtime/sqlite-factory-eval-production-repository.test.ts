import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { NodeFactoryDocumentCodec } from "../../packages/runtime/src/infrastructure/persistence/canonical-factory-documents.js";
import { SqliteFactoryEvalProductionRepository } from "../../packages/runtime/src/infrastructure/persistence/sqlite-factory-eval-production-repository.js";
import { latestSchemaVersion } from "../../packages/runtime/src/infrastructure/persistence/migrations.js";
import {
  testFactoryEvalProductionJob,
  testFactoryEvalUsage
} from "../helpers/factory-eval-production.js";

const documents = new NodeFactoryDocumentCodec();
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("SqliteFactoryEvalProductionRepository", () => {
  it("records an immutable job and append-only exact event chain", async () => {
    const databasePath = temporaryDatabase();
    const repository = new SqliteFactoryEvalProductionRepository(databasePath);
    const job = documents.evalProductionJob(testFactoryEvalProductionJob());
    const registered = documents.evalProductionEvent({
      ...eventBase(job.value, job.digest),
      eventId: "40000000-0000-4000-8000-000000000001",
      sequence: 1,
      previousEventDigest: null,
      kind: "registered",
      from: null,
      to: "ready",
      occurredAt: job.value.createdAt,
      reasonCode: "job-registered",
      detail: "Registered."
    });
    const first = await repository.register(job, registered);
    const started = documents.evalProductionEvent({
      ...eventBase(job.value, job.digest),
      eventId: "40000000-0000-4000-8000-000000000002",
      sequence: 2,
      previousEventDigest: registered.digest,
      kind: "subject-started",
      from: "ready",
      to: "subject-active",
      caseId: job.value.suite.caseIds[0],
      trial: 1,
      candidateRole: "baseline",
      executionId: "40000000-0000-4000-8000-000000000003",
      occurredAt: "2026-09-01T10:01:00.000Z",
      reasonCode: "subject-started",
      detail: "Started."
    });
    let current = await repository.append(started);
    const usage = testFactoryEvalUsage();
    const remaining = [
      {
        kind: "subject-finished",
        from: "subject-active",
        to: "subject-active",
        caseId: job.value.suite.caseIds[0],
        trial: 1,
        candidateRole: "baseline",
        executionId: "40000000-0000-4000-8000-000000000003",
        evidenceDigest: `sha256:${"1".repeat(64)}`,
        usage
      },
      {
        kind: "subject-started",
        from: "subject-active",
        to: "subject-active",
        caseId: job.value.suite.caseIds[0],
        trial: 1,
        candidateRole: "challenger",
        executionId: "40000000-0000-4000-8000-000000000004"
      },
      {
        kind: "subject-finished",
        from: "subject-active",
        to: "subject-active",
        caseId: job.value.suite.caseIds[0],
        trial: 1,
        candidateRole: "challenger",
        executionId: "40000000-0000-4000-8000-000000000004",
        evidenceDigest: `sha256:${"2".repeat(64)}`,
        usage
      },
      {
        kind: "grader-started",
        from: "subject-active",
        to: "grader-active",
        caseId: job.value.suite.caseIds[0],
        trial: 1,
        executionId: "40000000-0000-4000-8000-000000000005"
      },
      {
        kind: "sample-recorded",
        from: "grader-active",
        to: "subject-active",
        caseId: job.value.suite.caseIds[0],
        trial: 1,
        executionId: "40000000-0000-4000-8000-000000000005",
        evidenceDigest: `sha256:${"3".repeat(64)}`,
        sampleDigest: `sha256:${"4".repeat(64)}`,
        usage
      },
      {
        kind: "completed",
        from: "subject-active",
        to: "completed",
        evalRunDigest: `sha256:${"5".repeat(64)}`,
        evalRunArtifact: {
          digest: `sha256:${"5".repeat(64)}`,
          mediaType: "application/vnd.agentlab.eval-run+json",
          sizeBytes: 1_024
        },
        usage: { ...usage, wallClockSeconds: 3, costMicrousd: 30 }
      }
    ] as const;
    for (const [index, fields] of remaining.entries()) {
      const sequence = index + 3;
      const event = documents.evalProductionEvent({
        ...eventBase(job.value, job.digest),
        ...fields,
        eventId: `40000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`,
        sequence,
        previousEventDigest: current.events.at(-1)?.eventDigest ?? null,
        occurredAt: `2026-09-01T10:0${String(sequence)}:00.000Z`,
        reasonCode: fields.kind,
        detail: `${fields.kind}.`
      });
      current = await repository.append(event);
    }

    expect(first.events).toHaveLength(1);
    expect(current.events.map(({ event }) => event.kind)).toEqual([
      "registered",
      "subject-started",
      "subject-finished",
      "subject-started",
      "subject-finished",
      "grader-started",
      "sample-recorded",
      "completed"
    ]);
    await expect(repository.findByJobId(job.value.jobId)).resolves.toEqual(current);
    repository.close();

    const database = new DatabaseSync(databasePath);
    try {
      expect(
        (database.prepare("PRAGMA user_version").get() as { user_version: number }).user_version
      ).toBe(latestSchemaVersion);
      expect(() =>
        database.prepare("UPDATE factory_eval_production_jobs SET runner_id = runner_id").run()
      ).toThrow(/immutable/u);
      expect(() => database.prepare("DELETE FROM factory_eval_production_events").run()).toThrow(
        /append-only/u
      );
    } finally {
      database.close();
    }
  });

  it("rejects event chain and indexed-coordinate substitutions", async () => {
    const databasePath = temporaryDatabase();
    const repository = new SqliteFactoryEvalProductionRepository(databasePath);
    const job = documents.evalProductionJob(testFactoryEvalProductionJob());
    const registered = documents.evalProductionEvent({
      ...eventBase(job.value, job.digest),
      eventId: "40000000-0000-4000-8000-000000000011",
      sequence: 1,
      previousEventDigest: null,
      kind: "registered",
      from: null,
      to: "ready",
      occurredAt: job.value.createdAt,
      reasonCode: "job-registered",
      detail: "Registered."
    });
    await repository.register(job, registered);
    const skipped = documents.evalProductionEvent({
      ...eventBase(job.value, job.digest),
      eventId: "40000000-0000-4000-8000-000000000012",
      sequence: 3,
      previousEventDigest: registered.digest,
      kind: "subject-started",
      from: "ready",
      to: "subject-active",
      caseId: job.value.suite.caseIds[0],
      trial: 1,
      candidateRole: "baseline",
      executionId: "40000000-0000-4000-8000-000000000013",
      occurredAt: "2026-09-01T10:01:00.000Z",
      reasonCode: "subject-started",
      detail: "Started."
    });
    expect(() => repository.append(skipped)).toThrow(/chain/u);
    repository.close();

    const database = new DatabaseSync(databasePath);
    try {
      expect(() =>
        database
          .prepare(
            `INSERT INTO factory_eval_production_events (
              event_id, job_id, job_digest, sequence, event_digest, previous_event_digest,
              kind, from_state, to_state, case_id, trial, candidate_role, execution_id,
              evidence_digest, sample_digest, eval_run_digest, eval_run_artifact_json,
              usage_json, occurred_at, reason_code, correlation_id, event_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            "40000000-0000-4000-8000-000000000099",
            job.value.jobId,
            job.digest,
            2,
            `sha256:${"f".repeat(64)}`,
            registered.digest,
            "subject-started",
            "ready",
            "subject-active",
            "substituted/case",
            1,
            "baseline",
            "40000000-0000-4000-8000-000000000099",
            null,
            null,
            null,
            null,
            null,
            "2026-09-01T10:01:00.000Z",
            "subject-started",
            job.value.correlationId,
            JSON.stringify({ ...skipped.value, sequence: 2 })
          )
      ).toThrow(/identity mismatch/u);
    } finally {
      database.close();
    }
  });
});

function eventBase(job: ReturnType<typeof testFactoryEvalProductionJob>, jobDigest: string) {
  return {
    schemaVersion: "agentlab.eval-production-event.v1" as const,
    jobId: job.jobId,
    jobDigest,
    caseId: null,
    trial: null,
    candidateRole: null,
    executionId: null,
    evidenceDigest: null,
    sampleDigest: null,
    evalRunDigest: null,
    evalRunArtifact: null,
    usage: null,
    correlationId: job.correlationId,
    actor: {
      kind: "control-plane" as const,
      role: "gate-runner" as const,
      id: "agentlab-eval-producer",
      sessionId: job.jobId
    }
  };
}

function temporaryDatabase(): string {
  const root = mkdtempSync(join(tmpdir(), "agentlab-eval-production-"));
  roots.push(root);
  return join(root, "agentlab.sqlite");
}
