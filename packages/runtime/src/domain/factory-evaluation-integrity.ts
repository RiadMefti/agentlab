import type {
  FactoryBudget,
  FactoryCanaryApproval,
  FactoryCanaryCohort,
  FactoryCanaryStage,
  FactoryEvalAssessment,
  FactoryEvalRun
} from "@agentlab/contracts";

import type { FactoryCanarySnapshot } from "./factory-canary-repository.js";
import type { CanonicalFactoryDocument, FactoryDocumentCodec } from "./factory-documents.js";
import type { FactoryEvalSnapshot } from "./factory-evaluation-repository.js";
import { evaluateFactoryEvalRun } from "./factory-evaluation-policy.js";
import { factoryTimestampDifferenceSeconds } from "./factory-timestamp.js";

type EvalRunDocuments = Pick<
  FactoryDocumentCodec,
  "configurationCandidate" | "evalSuite" | "evalRun"
>;

type EvalDocuments = EvalRunDocuments & Pick<FactoryDocumentCodec, "evalAssessment">;

export function assertFactoryEvalRun(
  run: CanonicalFactoryDocument<FactoryEvalRun>,
  documents: EvalRunDocuments
): void {
  const suite = documents.evalSuite(run.value.suite);
  const baseline = documents.configurationCandidate(run.value.baselineCandidate);
  const challenger = documents.configurationCandidate(run.value.challengerCandidate);
  if (
    suite.digest !== run.value.suiteDigest ||
    baseline.digest !== run.value.baselineCandidateDigest ||
    challenger.digest !== run.value.challengerCandidateDigest
  ) {
    throw new Error("Factory eval run does not match its canonical suite and candidates.");
  }
  if (
    baseline.value.repositoryId !== challenger.value.repositoryId ||
    baseline.value.baseRevision !== challenger.value.baseRevision ||
    baseline.value.createdAt > run.value.startedAt ||
    challenger.value.createdAt > run.value.startedAt
  ) {
    throw new Error("Factory eval candidates are not matched on repository, base, and time.");
  }
  const expectedCoordinates = run.value.suite.caseIds.flatMap((caseId) =>
    Array.from(
      { length: run.value.suite.trialsPerCase },
      (_, index) => `${caseId}\0${String(index + 1)}`
    )
  );
  const actualCoordinates = run.value.samples.map(
    ({ caseId, trial }) => `${caseId}\0${String(trial)}`
  );
  if (!sameValues(actualCoordinates, expectedCoordinates)) {
    throw new Error("Factory eval run does not contain the exact ordered matched sample matrix.");
  }
  const seedDigests = run.value.samples.map(({ seedDigest }) => seedDigest);
  if (new Set(seedDigests).size !== seedDigests.length) {
    throw new Error("Factory eval run seeds must be unique per matched sample.");
  }
  for (const caseId of run.value.suite.caseIds) {
    const fixtureDigests = new Set(
      run.value.samples
        .filter((sample) => sample.caseId === caseId)
        .map(({ fixtureDigest }) => fixtureDigest)
    );
    if (fixtureDigests.size !== 1) {
      throw new Error(`Factory eval case ${caseId} changed fixtures between matched trials.`);
    }
  }
}

export function assertFactoryEvalAssessment(
  run: CanonicalFactoryDocument<FactoryEvalRun>,
  assessment: CanonicalFactoryDocument<FactoryEvalAssessment>,
  documents: EvalDocuments
): void {
  assertFactoryEvalRun(run, documents);
  const evaluated = evaluateFactoryEvalRun(run.value);
  const expected = documents.evalAssessment({
    ...assessment.value,
    runId: run.value.runId,
    runDigest: run.digest,
    suiteDigest: run.value.suiteDigest,
    baselineCandidateDigest: run.value.baselineCandidateDigest,
    challengerCandidateDigest: run.value.challengerCandidateDigest,
    metrics: evaluated.metrics,
    decision: evaluated.decision,
    maximumEligibleStage: evaluated.maximumEligibleStage,
    reasonCodes: evaluated.reasonCodes,
    actor: {
      kind: "control-plane",
      role: "policy-engine",
      id: "agentlab-eval-policy",
      sessionId: null
    }
  });
  if (
    assessment.value.assessedAt < run.value.completedAt ||
    expected.digest !== assessment.digest ||
    expected.json !== assessment.json
  ) {
    throw new Error("Factory eval assessment does not match its deterministic run evaluation.");
  }
}

export function assertFactoryCanaryAuthorization(
  evaluation: FactoryEvalSnapshot,
  approval: CanonicalFactoryDocument<FactoryCanaryApproval>,
  cohort: CanonicalFactoryDocument<FactoryCanaryCohort>,
  documents: Pick<FactoryDocumentCodec, "canaryApproval" | "canaryCohort">
): void {
  const suite = evaluation.run.suite;
  if (
    evaluation.assessment.decision !== "pass" ||
    evaluation.assessment.maximumEligibleStage === null ||
    approval.value.assessmentDigest !== evaluation.assessmentDigest ||
    approval.value.challengerCandidateDigest !== evaluation.run.challengerCandidateDigest ||
    approval.value.repositoryIds[0] !== evaluation.run.challengerCandidate.repositoryId ||
    !stageWithin(approval.value.stage, evaluation.assessment.maximumEligibleStage) ||
    approval.value.maximumTasks > suite.canaryLimits.maximumTasks ||
    !budgetWithin(approval.value.budget, suite.canaryLimits.maximumBudget) ||
    approval.value.humanSampleSize < suite.thresholds.minimumHumanSampleSize ||
    approval.value.humanSampleSize > evaluation.run.samples.length ||
    approval.value.occurredAt < evaluation.assessment.assessedAt ||
    factoryTimestampDifferenceSeconds(approval.value.occurredAt, approval.value.expiresAt) >
      suite.canaryLimits.maximumLifetimeSeconds ||
    (approval.value.stage === "read-only-shadow") !== (approval.value.maximumRiskTier === "R0")
  ) {
    throw new Error("Factory canary approval exceeds its exact passing eval authority.");
  }
  const canonicalApproval = documents.canaryApproval(approval.value);
  if (canonicalApproval.digest !== approval.digest || canonicalApproval.json !== approval.json) {
    throw new Error("Factory canary approval is not canonical.");
  }
  const expectedCohort = documents.canaryCohort({
    schemaVersion: "agentlab.canary-cohort.v1",
    cohortId: cohort.value.cohortId,
    assessmentDigest: evaluation.assessmentDigest,
    runDigest: evaluation.runDigest,
    challengerCandidateDigest: evaluation.run.challengerCandidateDigest,
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
  if (expectedCohort.digest !== cohort.digest || expectedCohort.json !== cohort.json) {
    throw new Error("Factory canary cohort does not exactly project its human approval.");
  }
}

export function assertFactoryCanarySnapshot(
  evaluation: FactoryEvalSnapshot,
  snapshot: FactoryCanarySnapshot,
  documents: Pick<FactoryDocumentCodec, "canaryApproval" | "canaryCohort">
): void {
  const approval = documents.canaryApproval(snapshot.approval);
  const cohort = documents.canaryCohort(snapshot.cohort);
  if (approval.digest !== snapshot.approvalDigest || cohort.digest !== snapshot.cohortDigest) {
    throw new Error("Stored factory canary snapshot failed canonical integrity validation.");
  }
  assertFactoryCanaryAuthorization(evaluation, approval, cohort, documents);
}

function stageWithin(requested: FactoryCanaryStage, maximum: FactoryCanaryStage): boolean {
  const rank: Readonly<Record<FactoryCanaryStage, number>> = {
    "read-only-shadow": 0,
    "local-proposal": 1,
    "brokered-draft-pr": 2
  };
  return rank[requested] <= rank[maximum];
}

function budgetWithin(requested: FactoryBudget, maximum: FactoryBudget): boolean {
  return (
    requested.wallClockSeconds <= maximum.wallClockSeconds &&
    requested.maxAgentTurns <= maximum.maxAgentTurns &&
    requested.maxToolCalls <= maximum.maxToolCalls &&
    requested.maxInputTokens <= maximum.maxInputTokens &&
    requested.maxOutputTokens <= maximum.maxOutputTokens &&
    requested.maxCostMicrousd <= maximum.maxCostMicrousd &&
    requested.maxProcesses <= maximum.maxProcesses &&
    requested.maxOutputBytes <= maximum.maxOutputBytes &&
    requested.maxWorkers <= maximum.maxWorkers &&
    requested.maxRepairAttempts <= maximum.maxRepairAttempts &&
    requested.maxChangedFiles <= maximum.maxChangedFiles &&
    requested.maxChangedLines <= maximum.maxChangedLines
  );
}

function sameValues(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
