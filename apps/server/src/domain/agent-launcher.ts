import type {
  CustomModelPolicy,
  ProviderCapability,
  ProviderId,
  ReasoningId
} from "@orchestrator/contracts";

import type { CommandSpec } from "./command.js";

export interface CaptainCommandInput {
  readonly executable: string;
  readonly conversationId: string;
  readonly workspace: string;
  readonly model: string | null;
  readonly reasoning: ReasoningId | null;
  readonly supervisorInstructions: string;
  readonly userPrompt: string;
}

export interface WorkerCommandInput {
  readonly executable: string;
  readonly conversationId: string;
  readonly workspace: string;
  readonly workerSlug: string;
  readonly userPrompt: string;
}

/** Builds provider-native commands for captains and explicitly user-created workers. */
export interface AgentLauncher {
  readonly id: ProviderId;
  readonly label: string;
  readonly customModelPolicy: CustomModelPolicy;
  buildCaptainCommand(input: CaptainCommandInput): CommandSpec;
  buildWorkerCommand(input: WorkerCommandInput): CommandSpec;
}

export interface ResolvedProvider {
  readonly launcher: AgentLauncher;
  readonly executable: string;
  readonly version: string;
  readonly capability: ProviderCapability;
}

export interface ProviderCatalog {
  list(): Promise<readonly ProviderCapability[]>;
  resolve(id: ProviderId): Promise<ResolvedProvider | null>;
}
