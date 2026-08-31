import {
  factoryBudgetUsageSchema,
  factoryCostPolicySchema,
  sha256DigestSchema,
  type FactoryBudgetUsage,
  type FactoryCostPolicy,
  type FactoryCostRule,
  type ProviderId,
  type Sha256Digest
} from "@agentlab/contracts";

export interface FactoryCostAccountingCoordinate {
  readonly policyBundleDigest: Sha256Digest;
  readonly provider: ProviderId;
  readonly model: string | null;
}

export interface FactoryCostAccountingInput extends FactoryCostAccountingCoordinate {
  readonly usage: FactoryBudgetUsage;
  readonly usageMeasurementsComplete: boolean;
  readonly reportedCostMicrousd: number | null;
}

export interface FactoryCostAccountingResult {
  readonly usage: FactoryBudgetUsage;
  readonly usageComplete: boolean;
}

export interface FactoryCostAccounting {
  preflight(input: FactoryCostAccountingCoordinate): void;
  account(input: FactoryCostAccountingInput): FactoryCostAccountingResult;
}

/** Applies one policy-pinned exact-model rule; it never consults a provider or mutable price API. */
export class FactoryCostAccountant implements FactoryCostAccounting {
  readonly #policyBundleDigest: Sha256Digest;
  readonly #rules: ReadonlyMap<string, FactoryCostRule>;

  public constructor(policyBundleDigest: Sha256Digest, costPolicyInput: FactoryCostPolicy) {
    this.#policyBundleDigest = sha256DigestSchema.parse(policyBundleDigest);
    const costPolicy = factoryCostPolicySchema.parse(costPolicyInput);
    this.#rules = new Map(
      costPolicy.rules.map((rule) => [coordinate(rule.provider, rule.model), rule])
    );
  }

  public preflight(input: FactoryCostAccountingCoordinate): void {
    this.#rule(input);
  }

  public account(input: FactoryCostAccountingInput): FactoryCostAccountingResult {
    const rule = this.#rule(input);
    const observedUsage = factoryBudgetUsageSchema.parse(input.usage);
    const costMicrousd =
      rule.accounting.mode === "token-rate"
        ? tokenRatedCost(
            observedUsage.inputTokens,
            observedUsage.outputTokens,
            rule.accounting.inputMicrousdPerMillionTokens,
            rule.accounting.outputMicrousdPerMillionTokens
          )
        : reportedCost(input.reportedCostMicrousd);
    return {
      usage: factoryBudgetUsageSchema.parse({
        ...observedUsage,
        costMicrousd: costMicrousd ?? 0
      }),
      usageComplete: input.usageMeasurementsComplete && costMicrousd !== null
    };
  }

  #rule(input: FactoryCostAccountingCoordinate): FactoryCostRule {
    if (sha256DigestSchema.parse(input.policyBundleDigest) !== this.#policyBundleDigest) {
      throw new Error("Factory cost policy digest does not match the pinned task policy.");
    }
    if (input.model === null) {
      throw new Error("Autonomous factory runs require an exact cost-accounted model.");
    }
    const rule = this.#rules.get(coordinate(input.provider, input.model));
    if (rule === undefined) {
      throw new Error(`No exact cost rule exists for ${input.provider}/${input.model}.`);
    }
    return rule;
  }
}

function coordinate(provider: ProviderId, model: string): string {
  return `${provider}\0${model}`;
}

function tokenRatedCost(
  inputTokens: number,
  outputTokens: number,
  inputRate: number,
  outputRate: number
): number {
  const numerator =
    BigInt(inputTokens) * BigInt(inputRate) + BigInt(outputTokens) * BigInt(outputRate);
  const cost = (numerator + 999_999n) / 1_000_000n;
  if (cost > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("Factory token-rated cost overflowed its auditable counter.");
  }
  return Number(cost);
}

function reportedCost(value: number | null): number | null {
  return value !== null && Number.isSafeInteger(value) && value >= 0 ? value : null;
}
