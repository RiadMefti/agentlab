import {
  factoryAgentRunRequestSchema,
  factoryPreparationRunRequestSchema,
  type FactoryAgentRunRequest,
  type FactoryBudgetUsage,
  type FactoryPreparationRunRequest,
  type ProviderId
} from "@agentlab/contracts";

import type { CommandSpec } from "../../domain/command.js";
import type {
  FactoryAgentExecutionOutput,
  FactoryAgentExecutorCapability
} from "../../domain/factory-agent-executor.js";
import type { FactoryWorkspace } from "../../domain/factory-workspace.js";

export interface FactoryAgentCommand {
  readonly command: CommandSpec;
  readonly stdin: string;
  readonly harnessVersion: string;
}

export interface FactoryAgentParseInput {
  readonly request: FactoryProviderRunRequest;
  readonly providerVersion: string;
  readonly harnessVersion: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly stdout: string;
  readonly stderr: string;
}

export interface FactoryAgentAdapter {
  readonly id: ProviderId;
  readonly capability: FactoryAgentExecutorCapability;
  build(
    request: FactoryProviderRunRequest,
    executable: string,
    workspace: FactoryWorkspace,
    prompt: string
  ): FactoryAgentCommand;
  parse(input: FactoryAgentParseInput): FactoryAgentAdapterOutput;
}

export interface FactoryAgentAdapterOutput extends Omit<
  FactoryAgentExecutionOutput,
  "exitCode" | "status" | "errorCode" | "isolation" | "usageComplete"
> {
  readonly usageMeasurementsComplete: boolean;
  readonly reportedCostMicrousd: number | null;
}

export type FactoryProviderRunRequest = FactoryAgentRunRequest | FactoryPreparationRunRequest;

export function parseFactoryProviderRunRequest(input: unknown): FactoryProviderRunRequest {
  const execution = factoryAgentRunRequestSchema.safeParse(input);
  return execution.success ? execution.data : factoryPreparationRunRequestSchema.parse(input);
}

export function isFactoryPreparationRunRequest(
  request: FactoryProviderRunRequest
): request is FactoryPreparationRunRequest {
  return request.schemaVersion === "agentlab.preparation-run-request.v1";
}

export function emptyFactoryBudgetUsage(): FactoryBudgetUsage {
  return {
    wallClockSeconds: 0,
    agentTurns: 0,
    toolCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    costMicrousd: 0,
    processes: 0,
    outputBytes: 0,
    workers: 1,
    repairAttempts: 0,
    changedFiles: 0,
    changedLines: 0
  };
}
