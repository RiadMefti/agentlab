import {
  factoryEvalCaseBankSchema,
  factoryEvalGraderResponseSchema,
  factoryEvalInvocationFailureEvidenceSchema,
  factoryEvalProductionEventSchema,
  factoryEvalProductionJobSchema,
  factoryEvalSubjectResponseSchema
} from "@agentlab/contracts";
import { describe, expect, it } from "vitest";

import { testEvalDigest } from "../helpers/factory-evaluation.js";
import {
  testFactoryEvalCaseBank,
  testFactoryEvalProductionJob,
  testFactoryEvalUsage
} from "../helpers/factory-eval-production.js";

describe("factory eval production contracts", () => {
  it("accepts one complete offline matched production job", () => {
    const job = factoryEvalProductionJobSchema.parse(testFactoryEvalProductionJob());

    expect(job.baselineHarness).toMatchObject({ network: "off", secrets: false });
    expect(job.challengerHarness).toMatchObject({ network: "off", secrets: false });
    expect(job.grader).toMatchObject({ network: "off", secrets: false });
    expect(job.aggregateBudget).toMatchObject({
      maxWorkers: 1,
      maxRepairAttempts: 0,
      maxChangedFiles: 0,
      maxChangedLines: 0
    });
  });

  it("rejects repeated seeds and mutating invocation budgets", () => {
    const bank = testFactoryEvalCaseBank();
    const first = bank.cases[0];
    if (first === undefined) throw new Error("Fixture requires a case.");

    expect(
      factoryEvalCaseBankSchema.safeParse({
        ...bank,
        cases: [
          { ...first, seedDigests: [testEvalDigest(1), testEvalDigest(1)] },
          ...bank.cases.slice(1)
        ]
      }).success
    ).toBe(false);
    expect(
      factoryEvalCaseBankSchema.safeParse({
        ...bank,
        cases: [
          {
            ...first,
            subjectBudgetCeiling: { ...first.subjectBudgetCeiling, maxChangedFiles: 1 }
          },
          ...bank.cases.slice(1)
        ]
      }).success
    ).toBe(false);
  });

  it("requires complete usage and structurally matched grader outcomes", () => {
    expect(
      factoryEvalSubjectResponseSchema.safeParse({
        schemaVersion: "agentlab.eval-subject-response.v1",
        status: "succeeded",
        usage: testFactoryEvalUsage(),
        usageComplete: false,
        reasonCode: null
      }).success
    ).toBe(false);
    expect(
      factoryEvalGraderResponseSchema.safeParse({
        schemaVersion: "agentlab.eval-grader-response.v1",
        status: "succeeded",
        baseline: null,
        challenger: {
          taskSuccess: true,
          safetyPass: true,
          criticalSafetyViolation: false,
          falsePositive: false
        },
        usage: testFactoryEvalUsage(),
        usageComplete: true,
        reasonCode: null
      }).success
    ).toBe(false);
  });

  it("rejects event field and actor substitutions", () => {
    const event = {
      schemaVersion: "agentlab.eval-production-event.v1",
      eventId: "20000000-0000-4000-8000-000000000010",
      jobId: "20000000-0000-4000-8000-000000000001",
      jobDigest: testEvalDigest(1),
      sequence: 1,
      previousEventDigest: null,
      kind: "registered",
      from: null,
      to: "ready",
      caseId: null,
      trial: null,
      candidateRole: null,
      executionId: null,
      evidenceDigest: null,
      sampleDigest: null,
      evalRunDigest: null,
      evalRunArtifact: null,
      usage: null,
      occurredAt: "2026-09-01T10:00:00.000Z",
      reasonCode: "job-registered",
      detail: "Registered.",
      correlationId: "20000000-0000-4000-8000-000000000002",
      actor: {
        kind: "control-plane",
        role: "gate-runner",
        id: "agentlab-eval-producer",
        sessionId: "20000000-0000-4000-8000-000000000001"
      }
    } as const;

    expect(factoryEvalProductionEventSchema.safeParse(event).success).toBe(true);
    expect(
      factoryEvalProductionEventSchema.safeParse({
        ...event,
        actor: { ...event.actor, id: "self-certifying-agent" }
      }).success
    ).toBe(false);
    expect(
      factoryEvalProductionEventSchema.safeParse({
        ...event,
        evalRunDigest: testEvalDigest(2)
      }).success
    ).toBe(false);
  });

  it("requires failed invocation evidence to distinguish complete and conservative usage", () => {
    const usage = testFactoryEvalUsage();
    const evidence = {
      schemaVersion: "agentlab.eval-invocation-failure-evidence.v1",
      jobId: "20000000-0000-4000-8000-000000000001",
      jobDigest: testEvalDigest(1),
      requestDigest: testEvalDigest(2),
      executionId: "20000000-0000-4000-8000-000000000003",
      phase: "subject",
      candidateRole: "baseline",
      descriptorDigest: testEvalDigest(3),
      executableDigest: testEvalDigest(4),
      caseId: "feature/simple",
      trial: 1,
      seedDigest: testEvalDigest(5),
      fixture: { digest: testEvalDigest(6), mediaType: "application/json", sizeBytes: 8 },
      status: "failed",
      reasonCode: "subject-rejected",
      stdoutArtifact: {
        digest: testEvalDigest(7),
        mediaType: "application/octet-stream",
        sizeBytes: 10
      },
      stderrArtifact: { digest: testEvalDigest(8), mediaType: "text/plain", sizeBytes: 0 },
      reportedUsage: usage,
      accountedUsage: usage,
      usageComplete: true,
      isolation: {
        isolationId: "20000000-0000-4000-8000-000000000003",
        mechanism: { id: "linux/systemd-user-scope", version: "257" },
        scopeName: "agentlab-factory-20000000000040008000000000000003.scope",
        limits: { maxProcesses: 4, maxMemoryBytes: 268435456, cpuQuotaPercent: 100 }
      },
      startedAt: "2026-09-01T10:00:00.000Z",
      finishedAt: "2026-09-01T10:00:01.000Z"
    } as const;

    expect(factoryEvalInvocationFailureEvidenceSchema.safeParse(evidence).success).toBe(true);
    expect(
      factoryEvalInvocationFailureEvidenceSchema.safeParse({
        ...evidence,
        reportedUsage: null,
        usageComplete: true
      }).success
    ).toBe(false);
  });
});
