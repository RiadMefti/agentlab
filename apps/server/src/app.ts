import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import Fastify, { type FastifyInstance } from "fastify";

import type { BrowserTerminalPort } from "./application/browser-terminal.js";
import type { ConversationService } from "./application/conversation-service.js";
import { registerErrorHandler } from "./http/error-handler.js";
import { registerRoutes } from "./http/routes.js";
import { registerLoopbackGuards } from "./http/security.js";

export interface BuildAppDependencies {
  readonly conversations: ConversationService;
  readonly terminal: BrowserTerminalPort;
  readonly workspace: string;
  readonly logger?: boolean;
  readonly webRoot?: string | null;
}

export async function buildApp(dependencies: BuildAppDependencies): Promise<FastifyInstance> {
  const app = Fastify({ logger: dependencies.logger ?? false });
  registerLoopbackGuards(app);
  registerErrorHandler(app);
  await app.register(fastifyWebsocket);
  registerRoutes(app, dependencies);

  const webRoot =
    dependencies.webRoot === undefined
      ? fileURLToPath(new URL("../../web/dist", import.meta.url))
      : dependencies.webRoot;
  if (webRoot !== null && existsSync(`${webRoot}/index.html`)) {
    await app.register(fastifyStatic, { root: webRoot });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith("/api/")) {
        return reply.status(404).send({
          error: { code: "NOT_FOUND", message: "API route not found." }
        });
      }
      return reply.sendFile("index.html");
    });
  }

  return app;
}
