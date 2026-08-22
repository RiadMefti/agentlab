import type { ProviderCapability, ProviderId, ReasoningLevel } from "@orchestrator/contracts";

import type { CommandSpec } from "./command.js";

export interface CaptainCommandInput {
  readonly executable: string;
  readonly conversationId: string;
  readonly workspace: string;
  readonly model: string | null;
  readonly reasoning: ReasoningLevel;
  readonly supervisorInstructions: string;
  readonly userPrompt: string;
}

/** Builds the one command used to start a conversation's captain. */
export interface CaptainLauncher {
  readonly capability: Omit<ProviderCapability, "available" | "version" | "reason">;
  buildCaptainCommand(input: CaptainCommandInput): CommandSpec;
}

export interface ResolvedCaptainProvider {
  readonly launcher: CaptainLauncher;
  readonly executable: string;
  readonly version: string;
}

export interface ProviderCatalog {
  list(): Promise<readonly ProviderCapability[]>;
  resolveCaptain(id: ProviderId): Promise<ResolvedCaptainProvider | null>;
}
