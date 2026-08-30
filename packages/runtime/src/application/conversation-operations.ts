import type {
  AgentSession,
  Conversation,
  CreateConversationInput,
  CreateWorkerInput,
  ProviderCapability
} from "@agentlab/contracts";

export interface WorkspaceInspection {
  readonly workspacePath: string;
  readonly suggestedName: string;
  readonly providers: readonly ProviderCapability[];
}

export interface WorkspacePreparation {
  readonly workspacePath: string;
  readonly suggestedName: string;
}

/**
 * Typed use cases implemented by the conversation aggregate coordinator.
 *
 * Presentation adapters must use AgentLabCommandPort instead; that boundary accepts unknown input
 * and validates it before delegating here.
 */
export interface ConversationOperations {
  listConversations(): Promise<readonly Conversation[]>;
  inspectWorkspace(workspacePath: string): Promise<WorkspaceInspection>;
  prepareWorkspace(workspacePath: string): Promise<WorkspacePreparation>;
  discoverWorkspaceProviders(
    canonicalWorkspacePath: string
  ): Promise<readonly ProviderCapability[]>;
  listProviders(conversationId: string): Promise<readonly ProviderCapability[]>;
  createConversation(input: CreateConversationInput): Promise<Conversation>;
  deleteConversation(conversationId: string): Promise<void>;
  listSessions(conversationId: string): Promise<readonly AgentSession[]>;
  createWorker(conversationId: string, input: CreateWorkerInput): Promise<string>;
  deleteWorker(conversationId: string, sessionName: string): Promise<void>;
  requireAttachableSession(conversationId: string, sessionName: string): Promise<string>;
}
