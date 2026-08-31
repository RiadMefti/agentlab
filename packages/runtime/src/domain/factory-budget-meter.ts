import {
  factoryBudgetUsageSchema,
  type FactoryBudgetUsage,
  type FactoryBudget,
  type FactoryChangeSet
} from "@agentlab/contracts";

import type { FactoryAgentExecutionOutput } from "./factory-agent-executor.js";
import { factoryUsageFits } from "./factory-authority-limits.js";
import type { FactoryGateExecutionOutput } from "./factory-gate.js";

/** Accumulates observed task resource use; incomplete measurements remain fail-closed. */
export class FactoryBudgetMeter {
  #usage: FactoryBudgetUsage = zeroUsage();
  #complete = true;

  public addAgent(output: FactoryAgentExecutionOutput): void {
    this.#usage = sumUsage(this.#usage, output.usage);
    this.#complete &&= output.usageComplete;
  }

  public addGate(output: FactoryGateExecutionOutput): void {
    this.#usage = sumUsage(this.#usage, {
      ...zeroUsage(),
      wallClockSeconds: output.wallClockSeconds,
      processes: 1,
      outputBytes: output.outputBytes
    });
  }

  public finish(changeSet: FactoryChangeSet, repairAttempts: number): FactoryBudgetUsage {
    return factoryBudgetUsageSchema.parse({
      ...this.#usage,
      repairAttempts,
      changedFiles: changeSet.changedFiles,
      changedLines: changeSet.changedLines
    });
  }

  public exceeds(
    budget: FactoryBudget,
    changeSet: FactoryChangeSet,
    repairAttempts: number
  ): boolean {
    const usage = this.finish(changeSet, repairAttempts);
    return !factoryUsageFits(usage, budget);
  }

  public get complete(): boolean {
    return this.#complete;
  }
}

function sumUsage(left: FactoryBudgetUsage, right: FactoryBudgetUsage): FactoryBudgetUsage {
  return factoryBudgetUsageSchema.parse({
    wallClockSeconds: safeSum(left.wallClockSeconds, right.wallClockSeconds),
    agentTurns: safeSum(left.agentTurns, right.agentTurns),
    toolCalls: safeSum(left.toolCalls, right.toolCalls),
    inputTokens: safeSum(left.inputTokens, right.inputTokens),
    outputTokens: safeSum(left.outputTokens, right.outputTokens),
    costMicrousd: safeSum(left.costMicrousd, right.costMicrousd),
    processes: safeSum(left.processes, right.processes),
    outputBytes: safeSum(left.outputBytes, right.outputBytes),
    workers: Math.max(left.workers, right.workers),
    repairAttempts: safeSum(left.repairAttempts, right.repairAttempts),
    changedFiles: Math.max(left.changedFiles, right.changedFiles),
    changedLines: Math.max(left.changedLines, right.changedLines)
  });
}

function safeSum(left: number, right: number): number {
  const result = left + right;
  if (!Number.isSafeInteger(result)) throw new Error("Factory usage counter overflowed.");
  return result;
}

function zeroUsage(): FactoryBudgetUsage {
  return {
    wallClockSeconds: 0,
    agentTurns: 0,
    toolCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    costMicrousd: 0,
    processes: 0,
    outputBytes: 0,
    workers: 0,
    repairAttempts: 0,
    changedFiles: 0,
    changedLines: 0
  };
}
