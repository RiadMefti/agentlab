import { afterEach, describe, expect, it } from "vitest";

import type { FastifyInstance } from "fastify";
import type { ProviderCapability } from "@orchestrator/contracts";

import { ConversationService } from "../../apps/server/src/application/conversation-service.js";
import { buildApp } from "../../apps/server/src/app.js";
import { TerminalGateway } from "../../apps/server/src/infrastructure/terminal/terminal-gateway.js";
import { opencodeCaptainLauncher } from "../../apps/server/src/infrastructure/providers/captain-launchers.js";
import type { ProviderCatalog } from "../../apps/server/src/domain/captain-launcher.js";
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
    providers: ProviderCatalog = new StaticProviderCatalog()
  ): Promise<FastifyInstance> {
    const service = new ConversationService({
      repository: new MemoryConversationRepository(),
      sessions: new MemorySessionRuntime(),
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
      ...testProviderCapability(opencodeCaptainLauncher),
      defaultModel: null,
      models: [],
      customModelPolicy: "catalog-only"
    };
    const catalog = new StaticProviderCatalog(
      new Map([["opencode", opencodeCaptainLauncher]]),
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
