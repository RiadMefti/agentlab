import {
  createConversationInputSchema,
  createWorkerInputSchema,
  folderCompletionInputSchema,
  folderSuggestionSchema,
  workspacePathInputSchema,
  type AgentSession,
  type Conversation,
  type FolderSuggestion,
  type ProviderCapability
} from "@agentlab/contracts";
import { z } from "zod";

import { parseSessionName } from "../domain/agent-session-name.js";
import type { ConversationService } from "./conversation-service.js";
import type { WorkspaceInspection, WorkspacePreparation } from "./conversation-service.js";
import type { FolderCompleter } from "../domain/folder-completer.js";

/** Provider- and transport-neutral command surface exposed to presentation layers. */
export interface AgentLabCommandPort {
  listConversations(): Promise<readonly Conversation[]>;
  inspectWorkspace(workspacePath: unknown): Promise<WorkspaceInspection>;
  prepareWorkspace(workspacePath: unknown): Promise<WorkspacePreparation>;
  discoverWorkspaceProviders(workspacePath: unknown): Promise<readonly ProviderCapability[]>;
  completeFolders(input: unknown): Promise<readonly FolderSuggestion[]>;
  listProviders(conversationId: unknown): Promise<readonly ProviderCapability[]>;
  createConversation(input: unknown): Promise<Conversation>;
  deleteConversation(conversationId: unknown): Promise<void>;
  listSessions(conversationId: unknown): Promise<readonly AgentSession[]>;
  createWorker(conversationId: unknown, input: unknown): Promise<string>;
  deleteWorker(conversationId: unknown, sessionName: unknown): Promise<void>;
  requireAttachableSession(
    conversationId: unknown,
    sessionName: unknown
  ): Promise<{
    readonly conversationId: string;
    readonly sessionName: string;
    readonly workspacePath: string;
  }>;
}

/** Structural application surface used by the validated command boundary and its test doubles. */
export type ConversationOperations = Pick<ConversationService, keyof ConversationService>;

const conversationIdSchema = z.uuid();
const sessionNameSchema = z
  .string()
  .min(1)
  .max(180)
  .refine((name) => parseSessionName(name) !== null, "Invalid managed session name.");

/** Validated, transport-independent commands exposed directly to local UIs. */
export class AgentLabCommands implements AgentLabCommandPort {
  public constructor(
    private readonly conversations: ConversationOperations,
    private readonly folders: FolderCompleter
  ) {}

  public listConversations(): Promise<readonly Conversation[]> {
    return this.conversations.listConversations();
  }

  public inspectWorkspace(workspacePath: unknown): Promise<WorkspaceInspection> {
    return this.conversations.inspectWorkspace(workspacePathInputSchema.parse(workspacePath));
  }

  public prepareWorkspace(workspacePath: unknown): Promise<WorkspacePreparation> {
    return this.conversations.prepareWorkspace(workspacePathInputSchema.parse(workspacePath));
  }

  public discoverWorkspaceProviders(
    workspacePath: unknown
  ): Promise<readonly ProviderCapability[]> {
    return this.conversations.discoverWorkspaceProviders(
      workspacePathInputSchema.parse(workspacePath)
    );
  }

  public async completeFolders(input: unknown): Promise<readonly FolderSuggestion[]> {
    const suggestions = await this.folders.complete(folderCompletionInputSchema.parse(input));
    return folderSuggestionSchema.array().max(6).parse(suggestions);
  }

  public listProviders(conversationId: unknown): Promise<readonly ProviderCapability[]> {
    return this.conversations.listProviders(conversationIdSchema.parse(conversationId));
  }

  public async createConversation(input: unknown): Promise<Conversation> {
    return this.conversations.createConversation(createConversationInputSchema.parse(input));
  }

  public async deleteConversation(conversationId: unknown): Promise<void> {
    return this.conversations.deleteConversation(conversationIdSchema.parse(conversationId));
  }

  public async listSessions(conversationId: unknown): Promise<readonly AgentSession[]> {
    return this.conversations.listSessions(conversationIdSchema.parse(conversationId));
  }

  public async createWorker(conversationId: unknown, input: unknown): Promise<string> {
    return this.conversations.createWorker(
      conversationIdSchema.parse(conversationId),
      createWorkerInputSchema.parse(input)
    );
  }

  public async deleteWorker(conversationId: unknown, sessionName: unknown): Promise<void> {
    return this.conversations.deleteWorker(
      conversationIdSchema.parse(conversationId),
      sessionNameSchema.parse(sessionName)
    );
  }

  public async requireAttachableSession(
    conversationId: unknown,
    sessionName: unknown
  ): Promise<{
    readonly conversationId: string;
    readonly sessionName: string;
    readonly workspacePath: string;
  }> {
    const target = {
      conversationId: conversationIdSchema.parse(conversationId),
      sessionName: sessionNameSchema.parse(sessionName)
    };
    const workspacePath = await this.conversations.requireAttachableSession(
      target.conversationId,
      target.sessionName
    );
    return { ...target, workspacePath };
  }
}
