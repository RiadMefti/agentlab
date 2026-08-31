import { factoryCostPolicySchema, type FactoryBudgetUsage } from "@agentlab/contracts";
import { describe, expect, it } from "vitest";

import { FactoryCostAccountant } from "../../packages/runtime/src/domain/factory-cost-accounting.js";
import { testDigest } from "../helpers/factory.js";

const policyDigest = testDigest("c");
const costPolicy = factoryCostPolicySchema.parse({
  schemaVersion: "agentlab.cost-policy.v1",
  id: "agentlab/test-costs",
  version: "1.0.0",
  rules: [
    {
      provider: "codex",
      model: "gpt-5.4",
      accounting: {
        mode: "token-rate",
        inputMicrousdPerMillionTokens: 1_000_000,
        outputMicrousdPerMillionTokens: 2_000_000
      }
    },
    {
      provider: "claude",
      model: "claude-sonnet-4-6",
      accounting: { mode: "provider-reported" }
    }
  ]
});

describe("FactoryCostAccountant", () => {
  it("uses integer arithmetic and rounds token-rated cost up", () => {
    const result = accountant().account({
      policyBundleDigest: policyDigest,
      provider: "codex",
      model: "gpt-5.4",
      usage: usage({ inputTokens: 1, outputTokens: 1 }),
      usageMeasurementsComplete: true,
      reportedCostMicrousd: null
    });

    expect(result).toMatchObject({ usage: { costMicrousd: 3 }, usageComplete: true });

    expect(
      accountant().account({
        policyBundleDigest: policyDigest,
        provider: "codex",
        model: "gpt-5.4",
        usage: usage({ inputTokens: 1, outputTokens: 1 }),
        usageMeasurementsComplete: false,
        reportedCostMicrousd: null
      })
    ).toMatchObject({ usage: { costMicrousd: 3 }, usageComplete: false });
  });

  it("accepts only structurally valid provider-reported cost", () => {
    const complete = accountant().account({
      policyBundleDigest: policyDigest,
      provider: "claude",
      model: "claude-sonnet-4-6",
      usage: usage({ inputTokens: 10, outputTokens: 2 }),
      usageMeasurementsComplete: true,
      reportedCostMicrousd: 12_345
    });
    const incomplete = accountant().account({
      policyBundleDigest: policyDigest,
      provider: "claude",
      model: "claude-sonnet-4-6",
      usage: usage({}),
      usageMeasurementsComplete: true,
      reportedCostMicrousd: null
    });

    expect(complete).toMatchObject({ usage: { costMicrousd: 12_345 }, usageComplete: true });
    expect(incomplete).toMatchObject({ usage: { costMicrousd: 0 }, usageComplete: false });
  });

  it("fails closed for unpinned, unknown, or defaulted models", () => {
    expect(() => {
      accountant().preflight({
        policyBundleDigest: testDigest("d"),
        provider: "codex",
        model: "gpt-5.4"
      });
    }).toThrow(/digest/u);
    expect(() => {
      accountant().preflight({
        policyBundleDigest: policyDigest,
        provider: "codex",
        model: "unknown"
      });
    }).toThrow(/No exact cost rule/u);
    expect(() => {
      accountant().preflight({
        policyBundleDigest: policyDigest,
        provider: "codex",
        model: null
      });
    }).toThrow(/exact cost-accounted model/u);
  });

  it("rejects an accounting counter that cannot remain a safe integer", () => {
    const overflowPolicy = factoryCostPolicySchema.parse({
      schemaVersion: "agentlab.cost-policy.v1",
      id: "agentlab/overflow-test-costs",
      version: "1.0.0",
      rules: [
        {
          provider: "codex",
          model: "gpt-5.4",
          accounting: {
            mode: "token-rate",
            inputMicrousdPerMillionTokens: Number.MAX_SAFE_INTEGER,
            outputMicrousdPerMillionTokens: 0
          }
        }
      ]
    });
    const overflowAccountant = new FactoryCostAccountant(policyDigest, overflowPolicy);

    expect(() =>
      overflowAccountant.account({
        policyBundleDigest: policyDigest,
        provider: "codex",
        model: "gpt-5.4",
        usage: usage({ inputTokens: Number.MAX_SAFE_INTEGER }),
        usageMeasurementsComplete: true,
        reportedCostMicrousd: null
      })
    ).toThrow(/overflowed/u);
  });
});

function accountant(): FactoryCostAccountant {
  return new FactoryCostAccountant(policyDigest, costPolicy);
}

function usage(overrides: Partial<FactoryBudgetUsage>): FactoryBudgetUsage {
  return {
    wallClockSeconds: 1,
    agentTurns: 1,
    toolCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    costMicrousd: 0,
    processes: 1,
    outputBytes: 0,
    workers: 1,
    repairAttempts: 0,
    changedFiles: 0,
    changedLines: 0,
    ...overrides
  };
}
