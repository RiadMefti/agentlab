import { afterEach, describe, expect, it } from "vitest";

import type { FastifyInstance } from "fastify";

import { ConversationService } from "../../apps/server/src/application/conversation-service.js";
import { buildApp } from "../../apps/server/src/app.js";
import { TerminalGateway } from "../../apps/server/src/infrastructure/terminal/terminal-gateway.js";
import {
  MemoryConversationRepository,
  MemorySessionRuntime,
  StaticProviderCatalog,
  TEST_CONVERSATION_ID
} from "../helpers/fakes.js";

describe("local HTTP API", () => {
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    if (app !== null) await app.close();
    app = null;
  });

  async function createApp(): Promise<FastifyInstance> {
    const service = new ConversationService({
      repository: new MemoryConversationRepository(),
      sessions: new MemorySessionRuntime(),
      providers: new StaticProviderCatalog(),
      workspace: "/work/project",
      createId: () => TEST_CONVERSATION_ID,
      now: () => new Date("2026-08-21T12:00:00.000Z")
    });
    app = await buildApp({
      conversations: service,
      terminal: new TerminalGateway({
        attach() {
          throw new Error("Terminal attachment is outside this HTTP test.");
        }
      }),
      workspace: "/work/project",
      webRoot: null
    });
    return app;
  }

  it("creates and lists a conversation through validated JSON", async () => {
    const server = await createApp();
    const createResponse = await server.inject({
      method: "POST",
      url: "/api/conversations",
      payload: {
        prompt: "Coordinate the auth fix",
        provider: "codex",
        model: "gpt-test",
        reasoning: "high"
      }
    });

    expect(createResponse.statusCode).toBe(201);
    expect(createResponse.json()).toMatchObject({
      id: TEST_CONVERSATION_ID,
      title: "Coordinate the auth fix",
      provider: "codex"
    });

    const listResponse = await server.inject({
      method: "GET",
      url: "/api/conversations"
    });
    expect(listResponse.statusCode).toBe(200);
    expect(listResponse.json()).toMatchObject({
      conversations: [{ id: TEST_CONVERSATION_ID }]
    });
  });

  it("returns a stable validation error", async () => {
    const server = await createApp();
    const response = await server.inject({
      method: "POST",
      url: "/api/conversations",
      payload: { prompt: "", provider: "unknown", reasoning: "infinite" }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: { code: "INVALID_REQUEST", message: "The request is invalid." }
    });
  });

  it("rejects unknown request fields", async () => {
    const server = await createApp();
    const response = await server.inject({
      method: "POST",
      url: "/api/conversations",
      payload: {
        prompt: "Coordinate the work",
        provider: "codex",
        reasoning: "high",
        unrecognized: true
      }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: "INVALID_REQUEST" } });
  });

  it("rejects a model value that could be parsed as a CLI option", async () => {
    const server = await createApp();
    const response = await server.inject({
      method: "POST",
      url: "/api/conversations",
      payload: {
        prompt: "Coordinate the work",
        provider: "codex",
        reasoning: "high",
        model: "--dangerously-bypass-approvals-and-sandbox"
      }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: "INVALID_REQUEST" } });
  });

  it("rejects non-loopback Host headers", async () => {
    const server = await createApp();
    const response = await server.inject({
      method: "GET",
      url: "/api/health",
      headers: { host: "attacker.example" }
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: { code: "INVALID_HOST" } });
  });

  it("rejects cross-origin browser requests to localhost", async () => {
    const server = await createApp();
    const response = await server.inject({
      method: "POST",
      url: "/api/conversations",
      headers: { host: "127.0.0.1:4321", origin: "https://attacker.example" },
      payload: { prompt: "Run this", provider: "codex", reasoning: "high" }
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: { code: "INVALID_ORIGIN" } });
  });
});
