import type {
  FactoryCanaryApproval,
  FactoryCanaryCohort,
  FactoryEvalAssessment,
  FactoryEvalRun,
  Sha256Digest
} from "@agentlab/contracts";
import { describe, expect, it, vi } from "vitest";

import { FactoryCanaryAuthorityService } from "../../packages/runtime/src/application/factory-canary-authority-service.js";
import { FactoryEvaluationService } from "../../packages/runtime/src/application/factory-evaluation-service.js";
import type {
  FactoryCanaryRepository,
  FactoryCanarySnapshot
} from "../../packages/runtime/src/domain/factory-canary-repository.js";
import type { CanonicalFactoryDocument } from "../../packages/runtime/src/domain/factory-documents.js";
import type {
  FactoryEvaluationRepository,
  FactoryEvalSnapshot
} from "../../packages/runtime/src/domain/factory-evaluation-repository.js";
import { NodeFactoryDocumentCodec } from "../../packages/runtime/src/infrastructure/persistence/canonical-factory-documents.js";
import {
  TEST_CANARY_APPROVAL_ID,
  TEST_CANARY_COHORT_ID,
  TEST_EVAL_ASSESSMENT_ID,
  testEvalDigest,
  testFactoryConfigurationCandidate,
  testFactoryEvalBudget,
  testFactoryEvalDocuments,
  testFactoryEvalRun,
  testFactoryEvalSamples,
  testFactoryEvalSuite
} from "../helpers/factory-evaluation.js";

const documents = new NodeFactoryDocumentCodec();

describe("FactoryEvaluationService", () => {
  it("records one deterministic assessment and replays the exact run idempotently", async () => {
    const evaluations = new MemoryEvaluations();
    const createId = vi.fn(() => TEST_EVAL_ASSESSMENT_ID);
    const service = new FactoryEvaluationService({
      runnerId: "trusted-eval-runner",
      evaluations,
      documents,
      now: () => "2026-08-30T11:31:00.000Z",
      createId
    });
    const run = testFactoryEvalRun();

    const first = await service.assess(run);
    const second = await service.assess(run);

    expect(first).toEqual(second);
    expect(first.assessment).toMatchObject({
      assessmentId: TEST_EVAL_ASSESSMENT_ID,
      decision: "pass",
      maximumEligibleStage: "brokered-draft-pr",
      reasonCodes: []
    });
    expect(evaluations.recordCalls).toBe(1);
    expect(createId).toHaveBeenCalledTimes(1);
    await expect(service.inspect({ assessmentDigest: first.assessmentDigest })).resolves.toEqual(
      first
    );
  });

  it("rejects runner impersonation, stale assessment time, and immutable run-id conflicts", async () => {
    const evaluations = new MemoryEvaluations();
    const service = new FactoryEvaluationService({
      runnerId: "trusted-eval-runner",
      evaluations,
      documents,
      now: () => "2026-08-30T11:31:00.000Z",
      createId: () => TEST_EVAL_ASSESSMENT_ID
    });

    await expect(service.assess(testFactoryEvalRun({ actorId: "other-runner" }))).rejects.toThrow(
      /evaluator identity/u
    );
    const stale = new FactoryEvaluationService({
      runnerId: "trusted-eval-runner",
      evaluations: new MemoryEvaluations(),
      documents,
      now: () => "2026-08-30T11:29:59.000Z",
      createId: () => TEST_EVAL_ASSESSMENT_ID
    });
    await expect(stale.assess(testFactoryEvalRun())).rejects.toThrow(/precedes the completed run/u);

    const original = testFactoryEvalRun();
    await service.assess(original);
    const conflicting = testFactoryEvalRun({
      challengerCandidate: testFactoryConfigurationCandidate({
        candidateId: "challenger",
        version: "2.0.0",
        providerDigestIndex: 9
      })
    });
    await expect(service.assess(conflicting)).rejects.toThrow(/different immutable data/u);
    await expect(service.inspect({ assessmentDigest: testEvalDigest(999) })).rejects.toThrow(
      /does not exist/u
    );
  });
});

describe("FactoryCanaryAuthorityService", () => {
  it("issues one exact human cohort and replays the same request idempotently", async () => {
    const evaluation = testFactoryEvalDocuments().snapshot;
    const evaluations = new MemoryEvaluations(evaluation);
    const canaries = new MemoryCanaries();
    const ids = [TEST_CANARY_APPROVAL_ID, TEST_CANARY_COHORT_ID];
    const createId = vi.fn(() => {
      const id = ids.shift();
      if (id === undefined) throw new Error("Unexpected extra authority ID.");
      return id;
    });
    const service = new FactoryCanaryAuthorityService({
      operatorId: "release-controller",
      evaluations,
      canaries,
      documents,
      now: () => "2026-08-30T12:00:00.000Z",
      createId
    });
    const command = canaryCommand(evaluation.assessmentDigest);

    const first = await service.authorize(command);
    const second = await service.authorize(command);

    expect(first).toMatchObject({
      schemaVersion: "agentlab.canary-authority-result.v1",
      status: "authorized",
      approval: {
        actor: { kind: "human", role: "release-controller", id: "release-controller" }
      },
      cohort: { autoMerge: false, release: false, maximumTasks: 2 }
    });
    expect(second).toEqual({ ...first, status: "existing" });
    expect(canaries.authorizeCalls).toBe(1);
    expect(createId).toHaveBeenCalledTimes(2);
  });

  it("rejects expired, widened, conflicting, and denied promotion requests", async () => {
    const evaluation = testFactoryEvalDocuments().snapshot;
    const serviceFixture = canaryService(evaluation);

    await expect(
      serviceFixture.service.authorize({
        ...canaryCommand(evaluation.assessmentDigest),
        request: {
          ...canaryCommand(evaluation.assessmentDigest).request,
          expiresAt: "2026-08-30T11:59:59.000Z"
        }
      })
    ).rejects.toThrow(/already expired/u);
    await expect(
      serviceFixture.service.authorize({
        ...canaryCommand(evaluation.assessmentDigest),
        request: { ...canaryCommand(evaluation.assessmentDigest).request, maximumTasks: 5 }
      })
    ).rejects.toThrow(/exceeds its exact passing eval authority/u);

    await serviceFixture.service.authorize(canaryCommand(evaluation.assessmentDigest));
    await expect(
      serviceFixture.service.authorize({
        ...canaryCommand(evaluation.assessmentDigest),
        request: {
          ...canaryCommand(evaluation.assessmentDigest).request,
          reason: "Different immutable authority."
        }
      })
    ).rejects.toThrow(/different immutable canary authority/u);
    const expiredRetry = new FactoryCanaryAuthorityService({
      operatorId: "release-controller",
      evaluations: new MemoryEvaluations(evaluation),
      canaries: serviceFixture.canaries,
      documents,
      now: () => "2026-09-01T12:00:00.000Z",
      createId: () => "10000000-0000-4000-8000-000000000099"
    });
    await expect(
      expiredRetry.authorize(canaryCommand(evaluation.assessmentDigest))
    ).rejects.toThrow(/has expired/u);

    const suite = testFactoryEvalSuite();
    const samples = testFactoryEvalSamples(suite);
    const first = samples[0];
    if (first === undefined) throw new Error("Fixture requires a sample.");
    samples[0] = {
      ...first,
      challenger: { ...first.challenger, taskSuccess: false }
    };
    const denied = testFactoryEvalDocuments({
      run: testFactoryEvalRun({ suite, samples }),
      assessmentId: "10000000-0000-4000-8000-000000000008"
    }).snapshot;
    await expect(
      canaryService(denied).service.authorize(canaryCommand(denied.assessmentDigest))
    ).rejects.toThrow(/exceeds its exact passing eval authority/u);
  });
});

class MemoryEvaluations implements FactoryEvaluationRepository {
  readonly #byRun = new Map<string, FactoryEvalSnapshot>();
  readonly #byAssessment = new Map<Sha256Digest, FactoryEvalSnapshot>();
  public recordCalls = 0;

  public constructor(initial?: FactoryEvalSnapshot) {
    if (initial !== undefined) this.#store(initial);
  }

  public record(
    run: CanonicalFactoryDocument<FactoryEvalRun>,
    assessment: CanonicalFactoryDocument<FactoryEvalAssessment>
  ): Promise<FactoryEvalSnapshot> {
    this.recordCalls += 1;
    const snapshot = {
      run: run.value,
      runDigest: run.digest,
      assessment: assessment.value,
      assessmentDigest: assessment.digest
    };
    this.#store(snapshot);
    return Promise.resolve(snapshot);
  }

  public findByRunId(runId: string): Promise<FactoryEvalSnapshot | null> {
    return Promise.resolve(this.#byRun.get(runId) ?? null);
  }

  public findByAssessmentDigest(
    assessmentDigest: Sha256Digest
  ): Promise<FactoryEvalSnapshot | null> {
    return Promise.resolve(this.#byAssessment.get(assessmentDigest) ?? null);
  }

  public close(): void {
    this.#byRun.clear();
    this.#byAssessment.clear();
  }

  #store(snapshot: FactoryEvalSnapshot): void {
    this.#byRun.set(snapshot.run.runId, snapshot);
    this.#byAssessment.set(snapshot.assessmentDigest, snapshot);
  }
}

class MemoryCanaries implements FactoryCanaryRepository {
  readonly #byAssessment = new Map<Sha256Digest, FactoryCanarySnapshot>();
  readonly #byCohort = new Map<Sha256Digest, FactoryCanarySnapshot>();
  public authorizeCalls = 0;

  public authorize(
    approval: CanonicalFactoryDocument<FactoryCanaryApproval>,
    cohort: CanonicalFactoryDocument<FactoryCanaryCohort>
  ): Promise<FactoryCanarySnapshot> {
    this.authorizeCalls += 1;
    const snapshot = {
      approval: approval.value,
      approvalDigest: approval.digest,
      cohort: cohort.value,
      cohortDigest: cohort.digest
    };
    this.#byAssessment.set(approval.value.assessmentDigest, snapshot);
    this.#byCohort.set(cohort.digest, snapshot);
    return Promise.resolve(snapshot);
  }

  public findByAssessmentDigest(
    assessmentDigest: Sha256Digest
  ): Promise<FactoryCanarySnapshot | null> {
    return Promise.resolve(this.#byAssessment.get(assessmentDigest) ?? null);
  }

  public findByCohortDigest(cohortDigest: Sha256Digest): Promise<FactoryCanarySnapshot | null> {
    return Promise.resolve(this.#byCohort.get(cohortDigest) ?? null);
  }

  public close(): void {
    this.#byAssessment.clear();
    this.#byCohort.clear();
  }
}

function canaryCommand(assessmentDigest: Sha256Digest) {
  return {
    assessmentDigest,
    request: {
      schemaVersion: "agentlab.canary-request.v1",
      stage: "brokered-draft-pr",
      repositoryIds: ["agentlab"],
      maximumRiskTier: "R1",
      maximumTasks: 2,
      budget: testFactoryEvalBudget(),
      humanSampleReviewDigest: testEvalDigest(902),
      humanSampleSize: 4,
      expiresAt: "2026-08-31T12:00:00.000Z",
      reason: "Reviewed bounded promotion."
    },
    confirmation: "authorize-canary"
  } as const;
}

function canaryService(evaluation: FactoryEvalSnapshot) {
  const evaluations = new MemoryEvaluations(evaluation);
  const canaries = new MemoryCanaries();
  const ids = [TEST_CANARY_APPROVAL_ID, TEST_CANARY_COHORT_ID];
  return {
    canaries,
    service: new FactoryCanaryAuthorityService({
      operatorId: "release-controller",
      evaluations,
      canaries,
      documents,
      now: () => "2026-08-30T12:00:00.000Z",
      createId: () => ids.shift() ?? "10000000-0000-4000-8000-000000000099"
    })
  };
}
