import { describe, expect, it } from "vitest";

import type { AgentSession } from "@orchestrator/contracts";

import { ConversationService } from "../../apps/server/src/application/conversation-service.js";
import {
  ConflictError,
  NotFoundError,
  ProviderUnavailableError
} from "../../apps/server/src/domain/errors.js";
import {
  buildCaptainSessionName,
  buildWorkerSessionName
} from "../../apps/server/src/domain/agent-session-name.js";
import {
  MemoryConversationRepository,
  MemorySessionRuntime,
  StaticProviderCatalog,
  TEST_CONVERSATION_ID
} from "../helpers/fakes.js";

function createFixture() {
  const repository = new MemoryConversationRepository();
  const sessions = new MemorySessionRuntime();
  const providers = new StaticProviderCatalog();
  const service = new ConversationService({
    repository,
    sessions,
    providers,
    workspace: "/work/project",
    now: () => new Date("2026-08-21T12:00:00.000Z"),
    createId: () => TEST_CONVERSATION_ID
  });
  return { repository, sessions, providers, service };
}

describe("ConversationService", () => {
  it("creates one captain session and persists its identity", async () => {
    const { repository, sessions, service } = createFixture();

    const conversation = await service.createConversation({
      prompt: "Investigate the refresh race",
      provider: "codex",
      model: "gpt-test",
      reasoning: "high"
    });

    expect(conversation).toEqual({
      id: TEST_CONVERSATION_ID,
      title: "Investigate the refresh race",
      provider: "codex",
      model: "gpt-test",
      reasoning: "high",
      captainSessionName: buildCaptainSessionName(TEST_CONVERSATION_ID, "codex"),
      createdAt: "2026-08-21T12:00:00.000Z",
      updatedAt: "2026-08-21T12:00:00.000Z"
    });
    expect(repository.conversations).toEqual([conversation]);
    expect(sessions.created).toHaveLength(1);
    expect(sessions.created[0]?.name).toBe(conversation.captainSessionName);
    expect(sessions.created[0]?.command.args).toContainEqual(
      expect.stringContaining("Your only job is orchestration")
    );
    expect(sessions.created[0]?.command.args.at(-1)).toBe("Investigate the refresh race");
  });

  it("preserves provider-default model and reasoning as null through launch", async () => {
    const { sessions, service } = createFixture();

    const conversation = await service.createConversation({
      prompt: "Use provider defaults",
      provider: "codex",
      model: null,
      reasoning: null
    });

    expect(conversation).toMatchObject({ model: null, reasoning: null });
    expect(sessions.created[0]?.command.args).not.toContain("-m");
    expect(
      sessions.created[0]?.command.args.some((argument) =>
        argument.startsWith("model_reasoning_effort=")
      )
    ).toBe(false);
  });

  it("allows a custom model only with provider-default reasoning", async () => {
    const { service } = createFixture();

    await expect(
      service.createConversation({
        prompt: "Use a custom model",
        provider: "codex",
        model: "custom-model",
        reasoning: null
      })
    ).resolves.toMatchObject({ model: "custom-model", reasoning: null });
  });

  it("compensates the tmux session when persistence fails", async () => {
    const { repository, sessions, service } = createFixture();
    repository.createError = new Error("disk full");

    await expect(
      service.createConversation({
        prompt: "Task",
        provider: "codex",
        model: null,
        reasoning: "high"
      })
    ).rejects.toThrow("disk full");
    expect(sessions.killed).toEqual([buildCaptainSessionName(TEST_CONVERSATION_ID, "codex")]);
  });

  it("does not persist when the requested provider is unavailable", async () => {
    const repository = new MemoryConversationRepository();
    const sessions = new MemorySessionRuntime();
    const service = new ConversationService({
      repository,
      sessions,
      providers: new StaticProviderCatalog(new Map()),
      workspace: "/work/project",
      createId: () => TEST_CONVERSATION_ID
    });

    await expect(
      service.createConversation({
        prompt: "Task",
        provider: "claude",
        model: null,
        reasoning: "high"
      })
    ).rejects.toBeInstanceOf(ProviderUnavailableError);
    expect(repository.conversations).toHaveLength(0);
    expect(sessions.created).toHaveLength(0);
  });

  it("rejects thinking levels the selected CLI does not support", async () => {
    const { repository, sessions, service } = createFixture();

    await expect(
      service.createConversation({
        prompt: "Task",
        provider: "codex",
        model: null,
        reasoning: "max"
      })
    ).rejects.toBeInstanceOf(ConflictError);
    expect(repository.conversations).toHaveLength(0);
    expect(sessions.created).toHaveLength(0);
  });

  it("returns the captain first and synthesizes it when tmux is gone", async () => {
    const { sessions, service } = createFixture();
    const conversation = await service.createConversation({
      prompt: "Task",
      provider: "codex",
      model: null,
      reasoning: "high"
    });
    const worker: AgentSession = {
      name: buildWorkerSessionName(TEST_CONVERSATION_ID, "claude", "boundary-review"),
      conversationId: TEST_CONVERSATION_ID,
      role: "worker",
      provider: "claude",
      label: "Boundary Review",
      status: "running",
      attached: false,
      startedAt: "2026-08-21T12:01:00.000Z"
    };
    sessions.liveSessions = [worker];

    const result = await service.listSessions(conversation.id);
    expect(result.map(({ role }) => role)).toEqual(["captain", "worker"]);
    expect(result[0]).toMatchObject({
      name: conversation.captainSessionName,
      status: "stopped"
    });
  });

  it("creates a named worker with the selected provider's defaults", async () => {
    const { sessions, service } = createFixture();
    await service.createConversation({
      prompt: "Coordinate the work",
      provider: "codex",
      model: null,
      reasoning: null
    });

    const sessionName = await service.createWorker(TEST_CONVERSATION_ID, {
      label: "Auth Tests",
      prompt: "Add focused authentication tests",
      provider: "codex"
    });

    expect(sessionName).toBe(buildWorkerSessionName(TEST_CONVERSATION_ID, "codex", "auth-tests"));
    expect(sessions.createdWorkers).toEqual([
      {
        name: sessionName,
        cwd: "/work/project",
        command: {
          executable: "/opt/bin/codex",
          args: expect.arrayContaining(["-C", "/work/project", "features.multi_agent=false"])
        }
      }
    ]);
    expect(sessions.createdWorkers[0]?.command.args.slice(-2)).toEqual([
      "--",
      "Add focused authentication tests"
    ]);
  });

  it("deletes only an existing worker owned by the conversation", async () => {
    const { sessions, service } = createFixture();
    const conversation = await service.createConversation({
      prompt: "Coordinate the work",
      provider: "codex",
      model: null,
      reasoning: null
    });
    const worker: AgentSession = {
      name: buildWorkerSessionName(TEST_CONVERSATION_ID, "claude", "review"),
      conversationId: TEST_CONVERSATION_ID,
      role: "worker",
      provider: "claude",
      label: "Review",
      status: "running",
      attached: false,
      startedAt: "2026-08-21T12:01:00.000Z"
    };
    sessions.liveSessions = [worker];

    await expect(service.deleteWorker(conversation.id, worker.name)).resolves.toBeUndefined();
    expect(sessions.killed).toEqual([worker.name]);
  });

  it("never deletes the Captain", async () => {
    const { sessions, service } = createFixture();
    const conversation = await service.createConversation({
      prompt: "Coordinate the work",
      provider: "codex",
      model: null,
      reasoning: null
    });

    await expect(
      service.deleteWorker(conversation.id, conversation.captainSessionName)
    ).rejects.toBeInstanceOf(ConflictError);
    expect(sessions.killed).toHaveLength(0);
  });

  it("does not target a missing or cross-conversation worker", async () => {
    const { sessions, service } = createFixture();
    await service.createConversation({
      prompt: "Coordinate the work",
      provider: "codex",
      model: null,
      reasoning: null
    });
    const foreignWorker = buildWorkerSessionName(
      "22222222-2222-4222-8222-222222222222",
      "codex",
      "review"
    );

    await expect(service.deleteWorker(TEST_CONVERSATION_ID, foreignWorker)).rejects.toBeInstanceOf(
      NotFoundError
    );
    expect(sessions.killed).toHaveLength(0);
  });
});
