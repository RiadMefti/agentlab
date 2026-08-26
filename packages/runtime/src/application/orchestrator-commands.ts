import {
  createConversationInputSchema,
  createWorkerInputSchema,
  workspacePathInputSchema,
  type AgentSession,
  type Conversation,
  type ProviderCapability
} from "@orchestrator/contracts";
import { z } from "zod";

import { parseSessionName } from "../domain/agent-session-name.js";
import type { ConversationService } from "./conversation-service.js";
import type { WorkspaceInspection } from "./conversation-service.js";

/** Provider- and transport-neutral command surface exposed to presentation layers. */
export interface OrchestratorCommandPort {
  listConversations(): Promise<readonly Conversation[]>;
  inspectWorkspace(workspacePath: unknown): Promise<WorkspaceInspection>;
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
export class OrchestratorCommands implements OrchestratorCommandPort {
  public constructor(private readonly conversations: ConversationOperations) {}

  public listConversations(): Promise<readonly Conversation[]> {
    return this.conversations.listConversations();
  }

  public inspectWorkspace(workspacePath: unknown): Promise<WorkspaceInspection> {
    return this.conversations.inspectWorkspace(workspacePathInputSchema.parse(workspacePath));
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
