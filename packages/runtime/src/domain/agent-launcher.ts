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
  readonly userPrompt: string | null;
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

/** An installed provider together with its live or cached capabilities. */
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

/** Supplies provider capabilities in the exact folder where discovery and launch will run. */
export interface ProviderCatalogFactory {
  forWorkspace(workspace: string): ProviderCatalog;
}
