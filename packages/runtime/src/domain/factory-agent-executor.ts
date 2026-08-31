import type {
  FactoryAgentRunRequest,
  FactoryAgentRunStatus,
  FactoryBudgetUsage,
  FactoryProcessIsolation,
  FactoryPreparationPhase,
  FactoryPreparationRunRequest,
  FactoryResourceLimits,
  ProviderId
} from "@agentlab/contracts";

import type { FactoryWorkspace } from "./factory-workspace.js";

export interface FactoryAgentExecutionInput {
  readonly request: FactoryAgentRunRequest;
  readonly executable: string;
  readonly providerVersion: string;
  readonly workspace: FactoryWorkspace;
  readonly prompt: string;
  readonly resourceLimits: FactoryResourceLimits;
}

export interface FactoryPreparationAgentExecutionInput extends Omit<
  FactoryAgentExecutionInput,
  "request"
> {
  readonly request: FactoryPreparationRunRequest;
}

export interface FactoryAgentExecutionOutput {
  readonly status: FactoryAgentRunStatus;
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly finalOutput: string | null;
  readonly providerSessionId: string | null;
  readonly providerVersion: string;
  readonly harnessVersion: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly usage: FactoryBudgetUsage;
  readonly usageComplete: boolean;
  readonly errorCode: string | null;
  readonly isolation: FactoryProcessIsolation;
}

export interface FactoryAgentExecutorCapability {
  readonly provider: ProviderId;
  readonly roles: readonly ("implementer" | "repairer" | "reviewer")[];
  readonly preparationPhases: readonly FactoryPreparationPhase[];
  readonly maximumToolFilesystemAccess: "read-only" | "workspace-write";
  readonly toolNetwork: "off";
  readonly acceptsCommandAllowlist: boolean;
  readonly acceptsSecrets: false;
}

export interface FactoryAgentExecutor {
  capabilities(): readonly FactoryAgentExecutorCapability[];
  execute(input: FactoryAgentExecutionInput): Promise<FactoryAgentExecutionOutput>;
}

export interface FactoryPreparationAgentExecutor {
  capabilities(): readonly FactoryAgentExecutorCapability[];
  execute(input: FactoryPreparationAgentExecutionInput): Promise<FactoryAgentExecutionOutput>;
}

export interface ResolvedFactoryAgentProvider {
  readonly executable: string;
  readonly version: string;
}

export interface FactoryAgentProviderResolver {
  resolve(provider: ProviderId, workspace: string): Promise<ResolvedFactoryAgentProvider | null>;
}
