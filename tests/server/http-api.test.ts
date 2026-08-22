import { afterEach, describe, expect, it } from "vitest";

import type { FastifyInstance } from "fastify";
import type { ProviderCapability } from "@orchestrator/contracts";

import { ConversationService } from "../../apps/server/src/application/conversation-service.js";
import { buildApp } from "../../apps/server/src/app.js";
import { TerminalGateway } from "../../apps/server/src/infrastructure/terminal/terminal-gateway.js";
import { opencodeAgentLauncher } from "../../apps/server/src/infrastructure/providers/agent-launchers.js";
import type { ProviderCatalog } from "../../apps/server/src/domain/agent-launcher.js";
import {
  buildCaptainSessionName,
  buildWorkerSessionName
} from "../../apps/server/src/domain/agent-session-name.js";
import {
  MemoryConversationRepository,
  MemorySessionRuntime,
  StaticProviderCatalog,
  TEST_CONVERSATION_ID,
  testProviderCapability
} from "../helpers/fakes.js";
import { LONG_BEDROCK_MODEL_ID } from "../helpers/model-ids.js";

describe("local HTTP API", () => {
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    if (app !== null) await app.close();
    app = null;
  });

  async function createApp(
    providers: ProviderCatalog = new StaticProviderCatalog(),
    sessions: MemorySessionRuntime = new MemorySessionRuntime()
  ): Promise<FastifyInstance> {
    const service = new ConversationService({
      repository: new MemoryConversationRepository(),
      sessions,
      providers,
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

  it("exposes model-scoped capabilities and accepts explicit provider defaults", async () => {
    const server = await createApp();
    const providers = await server.inject({ method: "GET", url: "/api/providers" });
    expect(providers.statusCode).toBe(200);
    expect(providers.json()).toMatchObject({
      providers: [
        {
          id: "codex",
          source: "live",
          defaultModel: "gpt-test",
          models: [
            {
              id: "gpt-test",
              reasoningOptions: [{ id: "low" }, { id: "high" }, { id: "xhigh" }]
            }
          ]
        }
      ]
    });

    const created = await server.inject({
      method: "POST",
      url: "/api/conversations",
      payload: {
        prompt: "Use local defaults",
        provider: "codex",
        model: null,
        reasoning: null
      }
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ model: null, reasoning: null });
  });

  it("accepts a long custom Bedrock deployment identifier through the HTTP boundary", async () => {
    const server = await createApp();
    const created = await server.inject({
      method: "POST",
      url: "/api/conversations",
      payload: {
        prompt: "Use the Bedrock inference profile",
        provider: "codex",
        model: LONG_BEDROCK_MODEL_ID,
        reasoning: null
      }
    });

    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ model: LONG_BEDROCK_MODEL_ID, reasoning: null });
  });

  it("rejects a model that is outside a catalog-only provider", async () => {
    const capability: ProviderCapability = {
      ...testProviderCapability(opencodeAgentLauncher),
      defaultModel: null,
      models: [],
      customModelPolicy: "catalog-only"
    };
    const catalog = new StaticProviderCatalog(
      new Map([["opencode", opencodeAgentLauncher]]),
      "/opt/opencode",
      { opencode: capability }
    );
    const server = await createApp(catalog);
    const response = await server.inject({
      method: "POST",
      url: "/api/conversations",
      payload: {
        prompt: "Use an unknown model",
        provider: "opencode",
        model: "provider/unknown",
        reasoning: null
      }
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: { code: "CONFLICT" } });
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

  it("creates and deletes a worker through validated session endpoints", async () => {
    const sessions = new MemorySessionRuntime();
    const server = await createApp(new StaticProviderCatalog(), sessions);
    await server.inject({
      method: "POST",
      url: "/api/conversations",
      payload: { prompt: "Coordinate", provider: "codex", model: null, reasoning: null }
    });

    const created = await server.inject({
      method: "POST",
      url: `/api/conversations/${TEST_CONVERSATION_ID}/sessions`,
      payload: { label: "Auth Tests", prompt: "Test authentication", provider: "codex" }
    });
    const workerName = buildWorkerSessionName(TEST_CONVERSATION_ID, "codex", "auth-tests");
    expect(created.statusCode).toBe(201);
    expect(created.json()).toEqual({ sessionName: workerName });
    expect(sessions.createdWorkers).toHaveLength(1);

    sessions.liveSessions = [
      {
        name: workerName,
        conversationId: TEST_CONVERSATION_ID,
        role: "worker",
        provider: "codex",
        label: "Auth Tests",
        status: "running",
        attached: false,
        startedAt: "2026-08-21T12:01:00.000Z"
      }
    ];
    const deleted = await server.inject({
      method: "DELETE",
      url: `/api/conversations/${TEST_CONVERSATION_ID}/sessions/${encodeURIComponent(workerName)}`
    });
    expect(deleted.statusCode).toBe(204);
    expect(sessions.killed).toEqual([workerName]);
  });

  it("deletes a master and all of its agent sessions", async () => {
    const sessions = new MemorySessionRuntime();
    const server = await createApp(new StaticProviderCatalog(), sessions);
    await server.inject({
      method: "POST",
      url: "/api/conversations",
      payload: { prompt: "Coordinate", provider: "codex", model: null, reasoning: null }
    });
    const captainName = buildCaptainSessionName(TEST_CONVERSATION_ID, "codex");
    const workerName = buildWorkerSessionName(TEST_CONVERSATION_ID, "codex", "review");
    sessions.liveSessions = [
      {
        name: workerName,
        conversationId: TEST_CONVERSATION_ID,
        role: "worker",
        provider: "codex",
        label: "Review",
        status: "running",
        attached: false,
        startedAt: "2026-08-21T12:01:00.000Z"
      }
    ];

    const deleted = await server.inject({
      method: "DELETE",
      url: `/api/conversations/${TEST_CONVERSATION_ID}`
    });
    expect(deleted.statusCode).toBe(204);
    expect(sessions.killed).toEqual([captainName, workerName]);

    const listed = await server.inject({ method: "GET", url: "/api/conversations" });
    expect(listed.json()).toEqual({ conversations: [] });
  });

  it("rejects unsafe worker creation input", async () => {
    const sessions = new MemorySessionRuntime();
    const server = await createApp(new StaticProviderCatalog(), sessions);
    await server.inject({
      method: "POST",
      url: "/api/conversations",
      payload: { prompt: "Coordinate", provider: "codex", model: null, reasoning: null }
    });

    const response = await server.inject({
      method: "POST",
      url: `/api/conversations/${TEST_CONVERSATION_ID}/sessions`,
      payload: {
        label: "../../personal",
        prompt: "Run this",
        provider: "codex",
        unrecognized: true
      }
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: "INVALID_REQUEST" } });
    expect(sessions.createdWorkers).toHaveLength(0);
  });

  it("protects the Captain from the worker deletion endpoint", async () => {
    const sessions = new MemorySessionRuntime();
    const server = await createApp(new StaticProviderCatalog(), sessions);
    await server.inject({
      method: "POST",
      url: "/api/conversations",
      payload: { prompt: "Coordinate", provider: "codex", model: null, reasoning: null }
    });
    const captainName = buildCaptainSessionName(TEST_CONVERSATION_ID, "codex");

    const response = await server.inject({
      method: "DELETE",
      url: `/api/conversations/${TEST_CONVERSATION_ID}/sessions/${encodeURIComponent(captainName)}`
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      error: { code: "CONFLICT", message: "The Captain cannot be deleted." }
    });
    expect(sessions.killed).toHaveLength(0);
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
