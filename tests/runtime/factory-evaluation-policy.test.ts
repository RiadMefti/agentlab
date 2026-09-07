import { describe, expect, it } from "vitest";

import { evaluateFactoryEvalRun } from "../../packages/runtime/src/domain/factory-evaluation-policy.js";
import {
  testFactoryEvalRun,
  testFactoryEvalSamples,
  testFactoryEvalSuite
} from "../helpers/factory-evaluation.js";

describe("evaluateFactoryEvalRun", () => {
  it("passes a complete matched run and derives conservative metrics from raw samples", () => {
    const result = evaluateFactoryEvalRun(testFactoryEvalRun());

    expect(result).toEqual({
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
      reasonCodes: []
    });
  });

  it("denies regressions, false positives, flakes, latency, and safety failures together", () => {
    const suite = testFactoryEvalSuite();
    const samples = testFactoryEvalSamples(suite);
    const first = samples[0];
    if (first === undefined) throw new Error("Fixture requires a sample.");
    samples[0] = {
      ...first,
      challenger: {
        ...first.challenger,
        taskSuccess: false,
        safetyPass: false,
        criticalSafetyViolation: true,
        falsePositive: true,
        latencyMilliseconds: 3_000
      }
    };

    const result = evaluateFactoryEvalRun(testFactoryEvalRun({ suite, samples }));

    expect(result.decision).toBe("deny");
    expect(result.maximumEligibleStage).toBeNull();
    expect(result.metrics).toMatchObject({
      challengerSuccessBasisPoints: 8_750,
      challengerSafetyBasisPoints: 8_750,
      successRegressionBasisPoints: 1_250,
      falsePositiveBasisPoints: 1_250,
      flakyCaseCount: 1,
      flakyCaseBasisPoints: 2_500,
      criticalSafetyViolations: 1,
      challengerP95LatencyMilliseconds: 3_000
    });
    expect(result.reasonCodes).toEqual([
      "challenger-safety-below-threshold",
      "challenger-success-below-threshold",
      "critical-safety-violation",
      "false-positive-rate-exceeded",
      "flake-rate-exceeded",
      "p95-latency-exceeded",
      "safety-confidence-below-threshold",
      "success-confidence-below-threshold",
      "success-regression-exceeded"
    ]);
  });

  it("fails closed on unbounded cost when the baseline has no cost", () => {
    const suite = testFactoryEvalSuite({
      thresholds: {
        ...testFactoryEvalSuite().thresholds,
        maximumCostRatioBasisPoints: 999_999
      }
    });
    const samples = testFactoryEvalSamples(suite).map((sample) => ({
      ...sample,
      baseline: { ...sample.baseline, costMicrousd: 0 }
    }));

    const nonzero = evaluateFactoryEvalRun(testFactoryEvalRun({ suite, samples }));
    const zero = evaluateFactoryEvalRun(
      testFactoryEvalRun({
        suite,
        samples: samples.map((sample) => ({
          ...sample,
          challenger: { ...sample.challenger, costMicrousd: 0 }
        }))
      })
    );

    expect(nonzero.metrics.costRatioBasisPoints).toBe(1_000_000);
    expect(nonzero.reasonCodes).toContain("cost-ratio-exceeded");
    expect(zero.metrics.costRatioBasisPoints).toBe(0);
    expect(zero.reasonCodes).not.toContain("cost-ratio-exceeded");
  });
});
