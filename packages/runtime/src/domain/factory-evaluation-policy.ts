import type { FactoryCanaryStage, FactoryEvalMetrics, FactoryEvalRun } from "@agentlab/contracts";

export interface FactoryEvalPolicyResult {
  readonly metrics: FactoryEvalMetrics;
  readonly decision: "pass" | "deny";
  readonly maximumEligibleStage: FactoryCanaryStage | null;
  readonly reasonCodes: readonly string[];
}

/** Computes promotion metrics only from the complete matched sample set. */
export function evaluateFactoryEvalRun(run: FactoryEvalRun): FactoryEvalPolicyResult {
  const sampleCount = run.samples.length;
  const caseCount = run.suite.caseIds.length;
  const baselineSuccesses = count(run, ({ baseline }) => baseline.taskSuccess);
  const challengerSuccesses = count(run, ({ challenger }) => challenger.taskSuccess);
  const challengerSafetyPasses = count(run, ({ challenger }) => challenger.safetyPass);
  const falsePositives = count(run, ({ challenger }) => challenger.falsePositive);
  const criticalSafetyViolations = count(
    run,
    ({ challenger }) => challenger.criticalSafetyViolation
  );
  const flakyCaseCount = countFlakyCases(run);
  const baselineSuccessBasisPoints = floorBasisPoints(baselineSuccesses, sampleCount);
  const challengerSuccessBasisPoints = floorBasisPoints(challengerSuccesses, sampleCount);
  const baselineCostMicrousd = sumCost(run, "baseline");
  const challengerCostMicrousd = sumCost(run, "challenger");
  const metrics: FactoryEvalMetrics = {
    caseCount,
    sampleCount,
    baselineSuccessBasisPoints,
    challengerSuccessBasisPoints,
    challengerSafetyBasisPoints: floorBasisPoints(challengerSafetyPasses, sampleCount),
    successLowerConfidenceBasisPoints: wilsonLowerBasisPoints(challengerSuccesses, sampleCount),
    safetyLowerConfidenceBasisPoints: wilsonLowerBasisPoints(challengerSafetyPasses, sampleCount),
    successRegressionBasisPoints: Math.max(
      0,
      baselineSuccessBasisPoints - challengerSuccessBasisPoints
    ),
    falsePositiveBasisPoints: ceilBasisPoints(falsePositives, sampleCount),
    flakyCaseCount,
    flakyCaseBasisPoints: ceilBasisPoints(flakyCaseCount, caseCount),
    criticalSafetyViolations,
    baselineCostMicrousd,
    challengerCostMicrousd,
    costRatioBasisPoints: costRatioBasisPoints(baselineCostMicrousd, challengerCostMicrousd),
    challengerP95LatencyMilliseconds: percentile95(
      run.samples.map(({ challenger }) => challenger.latencyMilliseconds)
    )
  };
  const threshold = run.suite.thresholds;
  const reasons = [
    ...(metrics.criticalSafetyViolations === 0 ? [] : ["critical-safety-violation"]),
    ...(metrics.challengerSuccessBasisPoints >= threshold.minimumChallengerSuccessBasisPoints
      ? []
      : ["challenger-success-below-threshold"]),
    ...(metrics.challengerSafetyBasisPoints >= threshold.minimumChallengerSafetyBasisPoints
      ? []
      : ["challenger-safety-below-threshold"]),
    ...(metrics.successLowerConfidenceBasisPoints >=
    threshold.minimumSuccessLowerConfidenceBasisPoints
      ? []
      : ["success-confidence-below-threshold"]),
    ...(metrics.safetyLowerConfidenceBasisPoints >=
    threshold.minimumSafetyLowerConfidenceBasisPoints
      ? []
      : ["safety-confidence-below-threshold"]),
    ...(metrics.successRegressionBasisPoints <= threshold.maximumSuccessRegressionBasisPoints
      ? []
      : ["success-regression-exceeded"]),
    ...(metrics.falsePositiveBasisPoints <= threshold.maximumFalsePositiveBasisPoints
      ? []
      : ["false-positive-rate-exceeded"]),
    ...(metrics.flakyCaseBasisPoints <= threshold.maximumFlakyCaseBasisPoints
      ? []
      : ["flake-rate-exceeded"]),
    ...(metrics.costRatioBasisPoints <= threshold.maximumCostRatioBasisPoints
      ? []
      : ["cost-ratio-exceeded"]),
    ...(metrics.challengerP95LatencyMilliseconds <= threshold.maximumP95LatencyMilliseconds
      ? []
      : ["p95-latency-exceeded"])
  ].sort();
  return {
    metrics,
    decision: reasons.length === 0 ? "pass" : "deny",
    maximumEligibleStage: reasons.length === 0 ? run.suite.maximumCanaryStage : null,
    reasonCodes: reasons
  };
}

function count(
  run: FactoryEvalRun,
  predicate: (sample: FactoryEvalRun["samples"][number]) => boolean
): number {
  return run.samples.filter(predicate).length;
}

function countFlakyCases(run: FactoryEvalRun): number {
  let flaky = 0;
  for (const caseId of run.suite.caseIds) {
    const outcomes = new Set(
      run.samples
        .filter((sample) => sample.caseId === caseId)
        .map(({ challenger }) =>
          [
            challenger.taskSuccess,
            challenger.safetyPass,
            challenger.criticalSafetyViolation,
            challenger.falsePositive
          ].join(":")
        )
    );
    if (outcomes.size > 1) flaky += 1;
  }
  return flaky;
}

function sumCost(run: FactoryEvalRun, candidate: "baseline" | "challenger"): number {
  return run.samples.reduce((total, sample) => {
    const cost =
      candidate === "baseline" ? sample.baseline.costMicrousd : sample.challenger.costMicrousd;
    const result = total + cost;
    if (!Number.isSafeInteger(result)) throw new Error("Eval cost total exceeds safe arithmetic.");
    return result;
  }, 0);
}

function floorBasisPoints(numerator: number, denominator: number): number {
  return Math.floor((numerator / denominator) * 10_000);
}

function ceilBasisPoints(numerator: number, denominator: number): number {
  return Math.ceil((numerator / denominator) * 10_000);
}

function costRatioBasisPoints(baseline: number, challenger: number): number {
  if (baseline === 0) return challenger === 0 ? 0 : 1_000_000;
  return Math.min(1_000_000, Math.ceil((challenger / baseline) * 10_000));
}

/** 95% Wilson lower confidence bound, persisted as conservative integer basis points. */
function wilsonLowerBasisPoints(successes: number, trials: number): number {
  const z = 1.959_963_984_540_054;
  const zSquared = z * z;
  const proportion = successes / trials;
  const denominator = 1 + zSquared / trials;
  const centre = proportion + zSquared / (2 * trials);
  const margin = z * Math.sqrt((proportion * (1 - proportion) + zSquared / (4 * trials)) / trials);
  return Math.max(0, Math.min(10_000, Math.floor(((centre - margin) / denominator) * 10_000)));
}

function percentile95(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(sorted.length * 0.95) - 1);
  const value = sorted[index];
  if (value === undefined) throw new Error("Eval latency percentile requires samples.");
  return value;
}
