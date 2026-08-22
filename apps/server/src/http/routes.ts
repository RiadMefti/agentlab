import { createConversationInputSchema } from "@orchestrator/contracts";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type { BrowserTerminalPort } from "../application/browser-terminal.js";
import type { ConversationService } from "../application/conversation-service.js";

const conversationParamsSchema = z.object({ conversationId: z.uuid() });
const terminalParamsSchema = conversationParamsSchema.extend({
  sessionName: z.string().min(1).max(180)
});

export interface RouteDependencies {
  readonly conversations: ConversationService;
  readonly terminal: BrowserTerminalPort;
  readonly workspace: string;
}

export function registerRoutes(app: FastifyInstance, dependencies: RouteDependencies): void {
  app.get("/api/health", () => ({ status: "ok" as const }));

  app.get("/api/providers", async () => ({
    providers: await dependencies.conversations.listProviders()
  }));

  app.get("/api/conversations", async () => ({
    conversations: await dependencies.conversations.listConversations()
  }));

  app.post("/api/conversations", async (request, reply) => {
    const input = createConversationInputSchema.parse(request.body);
    const conversation = await dependencies.conversations.createConversation(input);
    return reply.status(201).send(conversation);
  });

  app.get("/api/conversations/:conversationId/sessions", async (request) => {
    const { conversationId } = conversationParamsSchema.parse(request.params);
    return {
      sessions: await dependencies.conversations.listSessions(conversationId)
    };
  });

  app.get(
    "/api/conversations/:conversationId/sessions/:sessionName/terminal",
    {
      websocket: true,
      preValidation: async (request) => {
        const { conversationId, sessionName } = terminalParamsSchema.parse(request.params);
        await dependencies.conversations.requireAttachableSession(conversationId, sessionName);
      }
    },
    (socket, request) => {
      const { sessionName } = terminalParamsSchema.parse(request.params);
      dependencies.terminal.attach(socket, sessionName, dependencies.workspace);
    }
  );
}
