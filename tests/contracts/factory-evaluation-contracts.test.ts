import {
  factoryCanaryApprovalSchema,
  factoryCanaryCohortSchema,
  factoryCanaryRequestSchema,
  factoryConfigurationCandidateSchema,
  factoryEvalAssessmentSchema,
  factoryEvalRunSchema,
  factoryEvalSuiteSchema
} from "@agentlab/contracts";
import { describe, expect, it } from "vitest";

import {
  TEST_CANARY_APPROVAL_ID,
  TEST_CANARY_COHORT_ID,
  TEST_EVAL_ASSESSMENT_ID,
  testEvalDigest,
  testFactoryConfigurationCandidate,
  testFactoryEvalBudget,
  testFactoryEvalRun,
  testFactoryEvalSuite
} from "../helpers/factory-evaluation.js";

describe("factory evaluation contracts", () => {
  it("accepts one strict matched evaluation document", () => {
    const run = testFactoryEvalRun();

    expect(factoryEvalRunSchema.parse(run)).toEqual(run);
    expect(run.samples).toHaveLength(run.suite.caseIds.length * run.suite.trialsPerCase);
    expect(() => factoryEvalRunSchema.parse({ ...run, unexpected: true })).toThrow();
  });

  it("rejects ambiguous suites and candidates", () => {
    const suite = testFactoryEvalSuite();
    const candidate = testFactoryConfigurationCandidate({
      candidateId: "challenger",
      providerDigestIndex: 6
    });

    expect(() =>
      factoryEvalSuiteSchema.parse({
        ...suite,
        caseIds: [suite.caseIds[0], suite.caseIds[0]]
      })
    ).toThrow(/unique/u);
    expect(() =>
      factoryEvalSuiteSchema.parse({
        ...suite,
        thresholds: { ...suite.thresholds, minimumHumanSampleSize: 9 }
      })
    ).toThrow(/sample size/u);
    expect(() =>
      factoryConfigurationCandidateSchema.parse({
        ...candidate,
        skillPackageDigests: [testEvalDigest(7), testEvalDigest(7)]
      })
    ).toThrow(/unique/u);
  });

  it("rejects duplicate coordinates, self-comparisons, and contradictory safety outcomes", () => {
    const run = testFactoryEvalRun();
    const first = run.samples[0];
    if (first === undefined) throw new Error("Fixture requires an eval sample.");

    expect(() =>
      factoryEvalRunSchema.parse({
        ...run,
        samples: [...run.samples.slice(0, -1), first]
      })
    ).toThrow(/coordinates/u);
    expect(() =>
      factoryEvalRunSchema.parse({
        ...run,
        challengerCandidate: run.baselineCandidate,
        challengerCandidateDigest: run.baselineCandidateDigest
      })
    ).toThrow(/must differ/u);
    expect(() =>
      factoryEvalRunSchema.parse({
        ...run,
        samples: [
          {
            ...first,
            challenger: {
              ...first.challenger,
              criticalSafetyViolation: true,
              safetyPass: true
            }
          },
          ...run.samples.slice(1)
        ]
      })
    ).toThrow(/cannot be recorded as a safety pass/u);
  });

  it("binds assessments to deterministic policy actors and pass-stage consistency", () => {
    const run = testFactoryEvalRun();
    const assessment = {
      schemaVersion: "agentlab.eval-assessment.v1",
      assessmentId: TEST_EVAL_ASSESSMENT_ID,
      runId: run.runId,
      runDigest: testEvalDigest(800),
      suiteDigest: run.suiteDigest,
      baselineCandidateDigest: run.baselineCandidateDigest,
      challengerCandidateDigest: run.challengerCandidateDigest,
      assessedAt: "2026-08-30T11:31:00.000Z",
      metrics: {
        caseCount: 4,
        sampleCount: 8,
        baselineSuccessBasisPoints: 10_000,
        challengerSuccessBasisPoints: 10_000,
        challengerSafetyBasisPoints: 10_000,
        successLowerConfidenceBasisPoints: 6_755,
        safetyLowerConfidenceBasisPoints: 6_755,
        successRegressionBasisPoints: 0,
        falsePositiveBasisPoints: 0,
        flakyCaseCount: 0,
        flakyCaseBasisPoints: 0,
        criticalSafetyViolations: 0,
        baselineCostMicrousd: 8_000,
        challengerCostMicrousd: 8_800,
        costRatioBasisPoints: 11_000,
        challengerP95LatencyMilliseconds: 1_008
      },
      decision: "pass",
      maximumEligibleStage: "brokered-draft-pr",
      reasonCodes: [],
      actor: {
        kind: "control-plane",
        role: "policy-engine",
        id: "agentlab-eval-policy",
        sessionId: null
      }
    } as const;

    expect(factoryEvalAssessmentSchema.parse(assessment)).toEqual(assessment);
    expect(() =>
      factoryEvalAssessmentSchema.parse({
        ...assessment,
        decision: "deny",
        maximumEligibleStage: "read-only-shadow"
      })
    ).toThrow(/Only a passing/u);
    expect(() =>
      factoryEvalAssessmentSchema.parse({
        ...assessment,
        actor: { ...assessment.actor, kind: "agent" }
      })
    ).toThrow(/deterministic policy actor/u);
  });

  it("makes canary authority human, bounded, expiring, and structurally non-releasing", () => {
    const request = factoryCanaryRequestSchema.parse({
      schemaVersion: "agentlab.canary-request.v1",
      stage: "brokered-draft-pr",
      repositoryIds: ["agentlab"],
      maximumRiskTier: "R1",
      maximumTasks: 2,
      budget: testFactoryEvalBudget(),
      humanSampleReviewDigest: testEvalDigest(803),
      humanSampleSize: 4,
      expiresAt: "2026-08-31T12:00:00.000Z",
      reason: "Bounded reviewed canary."
    });
    const approval = {
      schemaVersion: "agentlab.canary-approval.v1",
      approvalId: TEST_CANARY_APPROVAL_ID,
      assessmentDigest: testEvalDigest(801),
      challengerCandidateDigest: testEvalDigest(802),
      stage: "brokered-draft-pr",
      repositoryIds: ["agentlab"],
      maximumRiskTier: "R1",
      maximumTasks: 2,
      budget: testFactoryEvalBudget(),
      humanSampleReviewDigest: testEvalDigest(803),
      humanSampleSize: 4,
      actor: {
        kind: "human",
        role: "release-controller",
        id: "release-controller",
        sessionId: null
      },
      occurredAt: "2026-08-30T12:00:00.000Z",
      expiresAt: "2026-08-31T12:00:00.000Z",
      reason: "Bounded reviewed canary."
    } as const;
    const parsedApproval = factoryCanaryApprovalSchema.parse(approval);
    const cohort = {
      schemaVersion: "agentlab.canary-cohort.v1",
      cohortId: TEST_CANARY_COHORT_ID,
      assessmentDigest: approval.assessmentDigest,
      runDigest: testEvalDigest(804),
      challengerCandidateDigest: approval.challengerCandidateDigest,
      approvalDigest: testEvalDigest(805),
      stage: approval.stage,
      repositoryIds: approval.repositoryIds,
      maximumRiskTier: approval.maximumRiskTier,
      maximumTasks: approval.maximumTasks,
      budget: approval.budget,
      issuedAt: approval.occurredAt,
      expiresAt: approval.expiresAt,
      autoMerge: false,
      release: false
    } as const;

    expect(parsedApproval.actor.role).toBe("release-controller");
    expect(request.schemaVersion).toBe("agentlab.canary-request.v1");
    expect(() => factoryCanaryRequestSchema.parse({ ...request, release: true })).toThrow();
    expect(factoryCanaryCohortSchema.parse(cohort)).toEqual(cohort);
    expect(() => factoryCanaryCohortSchema.parse({ ...cohort, autoMerge: true })).toThrow();
    expect(() => factoryCanaryCohortSchema.parse({ ...cohort, release: true })).toThrow();
    expect(() =>
      factoryCanaryApprovalSchema.parse({
        ...approval,
        actor: { ...approval.actor, kind: "control-plane" }
      })
    ).toThrow(/human release controller/u);
  });
});
