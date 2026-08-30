import type { FactoryAgentRunRequest, FactoryBudgetUsage, ProviderId } from "@agentlab/contracts";

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
  readonly request: FactoryAgentRunRequest;
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
    request: FactoryAgentRunRequest,
    executable: string,
    workspace: FactoryWorkspace,
    prompt: string
  ): FactoryAgentCommand;
  parse(
    input: FactoryAgentParseInput
  ): Omit<FactoryAgentExecutionOutput, "exitCode" | "status" | "errorCode" | "isolation">;
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
