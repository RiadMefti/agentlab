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

/** Builds the one command used to start a conversation's captain. */
export interface CaptainLauncher {
  readonly id: ProviderId;
  readonly label: string;
  readonly customModelPolicy: CustomModelPolicy;
  buildCaptainCommand(input: CaptainCommandInput): CommandSpec;
}

export interface ResolvedCaptainProvider {
  readonly launcher: CaptainLauncher;
  readonly executable: string;
  readonly version: string;
  readonly capability: ProviderCapability;
}

export interface ProviderCatalog {
  list(): Promise<readonly ProviderCapability[]>;
  resolveCaptain(id: ProviderId): Promise<ResolvedCaptainProvider | null>;
}
