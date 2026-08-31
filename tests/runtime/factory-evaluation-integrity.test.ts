import { describe, expect, it } from "vitest";

import {
  assertFactoryCanaryAuthorization,
  assertFactoryEvalAssessment,
  assertFactoryEvalRun
} from "../../packages/runtime/src/domain/factory-evaluation-integrity.js";
import { evaluateFactoryEvalRun } from "../../packages/runtime/src/domain/factory-evaluation-policy.js";
import { NodeFactoryDocumentCodec } from "../../packages/runtime/src/infrastructure/persistence/canonical-factory-documents.js";
import {
  TEST_CANARY_APPROVAL_ID,
  TEST_CANARY_COHORT_ID,
  TEST_EVAL_ASSESSMENT_ID,
  testEvalDigest,
  testFactoryEvalBudget,
  testFactoryEvalRun
} from "../helpers/factory-evaluation.js";

const documents = new NodeFactoryDocumentCodec();

describe("factory evaluation integrity", () => {
  it("requires canonical candidate digests and the exact ordered trial matrix", () => {
    const run = testFactoryEvalRun();
    const valid = documents.evalRun(run);
    const wrongSuite = documents.evalRun({ ...run, suiteDigest: testEvalDigest(900) });
    const reversed = documents.evalRun({ ...run, samples: [...run.samples].reverse() });

    expect(() => {
      assertFactoryEvalRun(valid, documents);
    }).not.toThrow();
    expect(() => {
      assertFactoryEvalRun(wrongSuite, documents);
    }).toThrow(/canonical suite/u);
    expect(() => {
      assertFactoryEvalRun(reversed, documents);
    }).toThrow(/ordered matched sample/u);
  });

  it("requires unique seeds and stable fixtures within each case", () => {
    const run = testFactoryEvalRun();
    const first = run.samples[0];
    const second = run.samples[1];
    if (first === undefined || second === undefined)
      throw new Error("Fixture requires two samples.");
    const repeatedSeed = documents.evalRun({
      ...run,
      samples: [first, { ...second, seedDigest: first.seedDigest }, ...run.samples.slice(2)]
    });
    const changedFixture = documents.evalRun({
      ...run,
      samples: [first, { ...second, fixtureDigest: testEvalDigest(901) }, ...run.samples.slice(2)]
    });

    expect(() => {
      assertFactoryEvalRun(repeatedSeed, documents);
    }).toThrow(/seeds must be unique/u);
    expect(() => {
      assertFactoryEvalRun(changedFixture, documents);
    }).toThrow(/changed fixtures/u);
  });

  it("recomputes every assessment metric and policy decision", () => {
    const run = documents.evalRun(testFactoryEvalRun());
    const result = evaluateFactoryEvalRun(run.value);
    const assessment = documents.evalAssessment({
      schemaVersion: "agentlab.eval-assessment.v1",
      assessmentId: TEST_EVAL_ASSESSMENT_ID,
      runId: run.value.runId,
      runDigest: run.digest,
      suiteDigest: run.value.suiteDigest,
      baselineCandidateDigest: run.value.baselineCandidateDigest,
      challengerCandidateDigest: run.value.challengerCandidateDigest,
      assessedAt: "2026-08-30T11:31:00.000Z",
      ...result,
      actor: {
        kind: "control-plane",
        role: "policy-engine",
        id: "agentlab-eval-policy",
        sessionId: null
      }
    });
    const tampered = documents.evalAssessment({
      ...assessment.value,
      metrics: {
        ...assessment.value.metrics,
        challengerCostMicrousd: assessment.value.metrics.challengerCostMicrousd + 1
      }
    });

    expect(() => {
      assertFactoryEvalAssessment(run, assessment, documents);
    }).not.toThrow();
    expect(() => {
      assertFactoryEvalAssessment(run, tampered, documents);
    }).toThrow(/deterministic run evaluation/u);
  });

  it("projects a passing assessment into one exact non-release canary cohort", () => {
    const run = documents.evalRun(testFactoryEvalRun());
    const evaluated = evaluateFactoryEvalRun(run.value);
    const assessment = documents.evalAssessment({
      schemaVersion: "agentlab.eval-assessment.v1",
      assessmentId: TEST_EVAL_ASSESSMENT_ID,
      runId: run.value.runId,
      runDigest: run.digest,
      suiteDigest: run.value.suiteDigest,
      baselineCandidateDigest: run.value.baselineCandidateDigest,
      challengerCandidateDigest: run.value.challengerCandidateDigest,
      assessedAt: "2026-08-30T11:31:00.000Z",
      ...evaluated,
      actor: {
        kind: "control-plane",
        role: "policy-engine",
        id: "agentlab-eval-policy",
        sessionId: null
      }
    });
    const evaluation = {
      run: run.value,
      runDigest: run.digest,
      assessment: assessment.value,
      assessmentDigest: assessment.digest
    };
    const approval = documents.canaryApproval({
      schemaVersion: "agentlab.canary-approval.v1",
      approvalId: TEST_CANARY_APPROVAL_ID,
      assessmentDigest: assessment.digest,
      challengerCandidateDigest: run.value.challengerCandidateDigest,
      stage: "brokered-draft-pr",
      repositoryIds: ["agentlab"],
      maximumRiskTier: "R1",
      maximumTasks: 2,
      budget: testFactoryEvalBudget(),
      humanSampleReviewDigest: testEvalDigest(902),
      humanSampleSize: 4,
      actor: {
        kind: "human",
        role: "release-controller",
        id: "release-controller",
        sessionId: null
      },
      occurredAt: "2026-08-30T12:00:00.000Z",
      expiresAt: "2026-08-31T12:00:00.000Z",
      reason: "Reviewed bounded promotion."
    });
    const cohort = documents.canaryCohort({
      schemaVersion: "agentlab.canary-cohort.v1",
      cohortId: TEST_CANARY_COHORT_ID,
      assessmentDigest: assessment.digest,
      runDigest: run.digest,
      challengerCandidateDigest: run.value.challengerCandidateDigest,
      approvalDigest: approval.digest,
      stage: approval.value.stage,
      repositoryIds: approval.value.repositoryIds,
      maximumRiskTier: approval.value.maximumRiskTier,
      maximumTasks: approval.value.maximumTasks,
      budget: approval.value.budget,
      issuedAt: approval.value.occurredAt,
      expiresAt: approval.value.expiresAt,
      autoMerge: false,
      release: false
    });

    expect(() => {
      assertFactoryCanaryAuthorization(evaluation, approval, cohort, documents);
    }).not.toThrow();

    const oversizedApproval = documents.canaryApproval({
      ...approval.value,
      approvalId: "10000000-0000-4000-8000-000000000006",
      maximumTasks: 5
    });
    const oversizedCohort = documents.canaryCohort({
      ...cohort.value,
      cohortId: "10000000-0000-4000-8000-000000000007",
      approvalDigest: oversizedApproval.digest,
      maximumTasks: 5
    });
    expect(() => {
      assertFactoryCanaryAuthorization(evaluation, oversizedApproval, oversizedCohort, documents);
    }).toThrow(/exceeds its exact passing eval authority/u);
  });
});
