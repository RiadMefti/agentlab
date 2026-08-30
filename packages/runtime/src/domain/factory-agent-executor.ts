import type {
  FactoryAgentRunRequest,
  FactoryAgentRunStatus,
  FactoryBudgetUsage,
  ProviderId
} from "@agentlab/contracts";

import type { FactoryWorkspace } from "./factory-workspace.js";

export interface FactoryAgentExecutionInput {
  readonly request: FactoryAgentRunRequest;
  readonly executable: string;
  readonly providerVersion: string;
  readonly workspace: FactoryWorkspace;
  readonly prompt: string;
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
}

export interface FactoryAgentExecutorCapability {
  readonly provider: ProviderId;
  readonly roles: readonly ("implementer" | "repairer" | "reviewer")[];
  readonly maximumToolFilesystemAccess: "read-only" | "workspace-write";
  readonly toolNetwork: "off";
  readonly acceptsCommandAllowlist: boolean;
  readonly acceptsSecrets: false;
}

export interface FactoryAgentExecutor {
  capabilities(): readonly FactoryAgentExecutorCapability[];
  execute(input: FactoryAgentExecutionInput): Promise<FactoryAgentExecutionOutput>;
}

export interface ResolvedFactoryAgentProvider {
  readonly executable: string;
  readonly version: string;
}

export interface FactoryAgentProviderResolver {
  resolve(provider: ProviderId, workspace: string): Promise<ResolvedFactoryAgentProvider | null>;
}
