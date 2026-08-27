import { describe, expect, it } from "vitest";

import type { AgentSession } from "@agentlab/contracts";

import { ConversationService } from "../../packages/runtime/src/application/conversation-service.js";
import type { CreateWorkerSessionInput } from "../../packages/runtime/src/domain/session-runtime.js";
import {
  ConflictError,
  NotFoundError,
  ProviderUnavailableError
} from "../../packages/runtime/src/domain/errors.js";
import {
  buildCaptainSessionName,
  buildWorkerSessionName
} from "../../packages/runtime/src/domain/agent-session-name.js";
import {
  MemoryConversationRepository,
  MemorySessionRuntime,
  StaticWorkspacePathResolver,
  StaticProviderCatalog,
  TEST_CONVERSATION_ID
} from "../helpers/fakes.js";

function createFixture(sessions: MemorySessionRuntime = new MemorySessionRuntime()) {
  const repository = new MemoryConversationRepository();
  const providers = new StaticProviderCatalog();
  const service = new ConversationService({
    repository,
    sessions,
    providers,
    workspacePaths: new StaticWorkspacePathResolver(),
    now: () => new Date("2026-08-21T12:00:00.000Z"),
    createId: () => TEST_CONVERSATION_ID
  });
  return { repository, sessions, providers, service };
}

const PROJECT_INPUT = {
  title: "Test project",
  workspacePath: "/work/project"
} as const;

interface Signal {
  readonly promise: Promise<void>;
  resolve(): void;
}

function signal(): Signal {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

class GatedWorkerSessionRuntime extends MemorySessionRuntime {
  public readonly workerCreateStarted = signal();
  public readonly workerCreateRelease = signal();
  public workerCreateError: Error | null = null;

  public override async createWorker(input: CreateWorkerSessionInput): Promise<void> {
    this.workerCreateStarted.resolve();
    await this.workerCreateRelease.promise;
    if (this.workerCreateError !== null) throw this.workerCreateError;
    await super.createWorker(input);
    this.liveSessions.push({
      name: input.name,
      conversationId: TEST_CONVERSATION_ID,
      role: "worker",
      provider: "codex",
      label: "Gated Worker",
      status: "running",
      attached: false,
      startedAt: "2026-08-21T12:01:00.000Z"
    });
  }
}

describe("ConversationService", () => {
  it("inspects any selected folder in that folder's provider context", async () => {
    const { providers, service } = createFixture();

    await expect(service.inspectWorkspace("/work/another-project")).resolves.toMatchObject({
      workspacePath: "/work/another-project",
      suggestedName: "another-project"
    });
    expect(providers.workspaces).toContain("/work/another-project");
  });

  it("prepares the canonical folder before separately discovering providers", async () => {
    const { providers, service } = createFixture();

    await expect(service.prepareWorkspace("/work/fast-project")).resolves.toEqual({
      workspacePath: "/work/fast-project",
      suggestedName: "fast-project"
    });
    expect(providers.workspaces).toEqual([]);

    await expect(service.discoverWorkspaceProviders("/work/fast-project")).resolves.toHaveLength(1);
    expect(providers.workspaces).toEqual(["/work/fast-project"]);
  });

  it("authoritatively resolves and checks the folder again when creation starts", async () => {
    const repository = new MemoryConversationRepository();
    const workspacePaths = new StaticWorkspacePathResolver();
    const service = new ConversationService({
      repository,
      sessions: new MemorySessionRuntime(),
      providers: new StaticProviderCatalog(),
      workspacePaths,
      createId: () => TEST_CONVERSATION_ID
    });

    const prepared = await service.prepareWorkspace("/work/revalidated");
    await service.createConversation({
      title: prepared.suggestedName,
      workspacePath: prepared.workspacePath,
      prompt: null,
      provider: "codex",
      model: null,
      reasoning: null
    });

    expect(workspacePaths.inputs).toEqual(["/work/revalidated", "/work/revalidated"]);
  });

  it("creates one captain session and persists its identity", async () => {
    const { repository, sessions, service } = createFixture();

    const conversation = await service.createConversation({
      ...PROJECT_INPUT,
      prompt: "Investigate the refresh race",
      provider: "codex",
      model: "gpt-test",
      reasoning: "high"
    });

    expect(conversation).toEqual({
      id: TEST_CONVERSATION_ID,
      title: "Test project",
      workspacePath: "/work/project",
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

  it("starts a persistent interactive captain without requiring an initial task", async () => {
    const { sessions, service } = createFixture();

    const conversation = await service.createConversation({
      ...PROJECT_INPUT,
      prompt: null,
      provider: "codex",
      model: null,
      reasoning: null
    });

    expect(conversation).toMatchObject(PROJECT_INPUT);
    expect(sessions.created[0]?.command.args).not.toContain("--");
  });

  it("allows only one saved project for a canonical folder", async () => {
    const { sessions, service } = createFixture();
    await service.createConversation({
      ...PROJECT_INPUT,
      prompt: null,
      provider: "codex",
      model: null,
      reasoning: null
    });

    await expect(service.inspectWorkspace(PROJECT_INPUT.workspacePath)).rejects.toThrow(
      "already saved as Test project"
    );
    expect(sessions.created).toHaveLength(1);
  });

  it("preserves provider-default model and reasoning as null through launch", async () => {
    const { sessions, service } = createFixture();

    const conversation = await service.createConversation({
      ...PROJECT_INPUT,
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
        ...PROJECT_INPUT,
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
        ...PROJECT_INPUT,
        prompt: "Task",
        provider: "codex",
        model: null,
        reasoning: "high"
      })
    ).rejects.toThrow("disk full");
    expect(sessions.killed).toEqual([buildCaptainSessionName(TEST_CONVERSATION_ID, "codex")]);
  });

  it("keeps persistence failure primary and retains failed tmux compensation diagnostics", async () => {
    const { repository, sessions, service } = createFixture();
    const primary = new Error("disk full");
    const compensation = new Error("tmux kill timed out");
    const name = buildCaptainSessionName(TEST_CONVERSATION_ID, "codex");
    repository.createError = primary;
    sessions.killErrors.set(name, compensation);

    const failure = await service
      .createConversation({
        ...PROJECT_INPUT,
        prompt: "Task",
        provider: "codex",
        model: null,
        reasoning: "high"
      })
      .catch((error: unknown) => error);

    expect(failure).toBe(primary);
    expect(primary.cause).toBeInstanceOf(AggregateError);
    expect((primary.cause as AggregateError).errors).toContain(compensation);
  });

  it("does not persist when the requested provider is unavailable", async () => {
    const repository = new MemoryConversationRepository();
    const sessions = new MemorySessionRuntime();
    const service = new ConversationService({
      repository,
      sessions,
      providers: new StaticProviderCatalog(new Map()),
      workspacePaths: new StaticWorkspacePathResolver(),
      createId: () => TEST_CONVERSATION_ID
    });

    await expect(
      service.createConversation({
        ...PROJECT_INPUT,
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
        ...PROJECT_INPUT,
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
      ...PROJECT_INPUT,
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
      ...PROJECT_INPUT,
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

  it("serializes worker creation with conversation deletion so no worker is orphaned", async () => {
    const sessions = new GatedWorkerSessionRuntime();
    const { repository, service } = createFixture(sessions);
    const conversation = await service.createConversation({
      ...PROJECT_INPUT,
      prompt: "Coordinate the work",
      provider: "codex",
      model: null,
      reasoning: null
    });

    const workerCreation = service.createWorker(conversation.id, {
      label: "Race Reproduction",
      prompt: "Wait at the reproduced worker creation boundary",
      provider: "codex"
    });
    await sessions.workerCreateStarted.promise;

    let deletionSettled = false;
    const deletion = service.deleteConversation(conversation.id).finally(() => {
      deletionSettled = true;
    });
    await Promise.resolve();

    expect(deletionSettled).toBe(false);
    expect(sessions.killed).toEqual([]);

    sessions.workerCreateRelease.resolve();
    const workerName = await workerCreation;
    await deletion;

    expect(sessions.killed).toEqual([conversation.captainSessionName, workerName]);
    expect(sessions.liveSessions).toEqual([]);
    expect(repository.conversations).toEqual([]);
  });

  it("continues a queued deletion after worker creation fails", async () => {
    const sessions = new GatedWorkerSessionRuntime();
    const { repository, service } = createFixture(sessions);
    const conversation = await service.createConversation({
      ...PROJECT_INPUT,
      prompt: "Coordinate the work",
      provider: "codex",
      model: null,
      reasoning: null
    });

    const workerCreation = service.createWorker(conversation.id, {
      label: "Failing Worker",
      prompt: "Fail at the session boundary",
      provider: "codex"
    });
    await sessions.workerCreateStarted.promise;
    const deletion = service.deleteConversation(conversation.id);
    sessions.workerCreateError = new Error("worker launch failed");
    sessions.workerCreateRelease.resolve();

    await expect(workerCreation).rejects.toThrow("worker launch failed");
    await expect(deletion).resolves.toBeUndefined();
    expect(sessions.createdWorkers).toEqual([]);
    expect(sessions.killed).toEqual([conversation.captainSessionName]);
    expect(repository.conversations).toEqual([]);
  });

  it("continues a queued worker creation after conversation deletion fails", async () => {
    const { repository, sessions, service } = createFixture();
    const conversation = await service.createConversation({
      ...PROJECT_INPUT,
      prompt: "Coordinate the work",
      provider: "codex",
      model: null,
      reasoning: null
    });
    repository.deleteError = new Error("database busy");

    const deletion = service.deleteConversation(conversation.id);
    const workerCreation = service.createWorker(conversation.id, {
      label: "After Failed Delete",
      prompt: "Start only after the failed deletion releases its lifecycle turn",
      provider: "codex"
    });

    await expect(deletion).rejects.toThrow("database busy");
    await expect(workerCreation).resolves.toBe(
      buildWorkerSessionName(TEST_CONVERSATION_ID, "codex", "after-failed-delete")
    );
    expect(repository.conversations).toEqual([conversation]);
    expect(sessions.createdWorkers).toHaveLength(1);
  });

  it("deletes only an existing worker owned by the conversation", async () => {
    const { sessions, service } = createFixture();
    const conversation = await service.createConversation({
      ...PROJECT_INPUT,
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

  it("deletes a conversation after stopping its captain and workers", async () => {
    const { repository, sessions, service } = createFixture();
    const conversation = await service.createConversation({
      ...PROJECT_INPUT,
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

    await expect(service.deleteConversation(conversation.id)).resolves.toBeUndefined();

    expect(sessions.killed).toEqual([conversation.captainSessionName, worker.name]);
    expect(repository.conversations).toHaveLength(0);
  });

  it("bounds multi-worker deletion by stopping workers concurrently", async () => {
    const { sessions, service } = createFixture();
    const conversation = await service.createConversation({
      ...PROJECT_INPUT,
      prompt: "Coordinate the work",
      provider: "codex",
      model: null,
      reasoning: null
    });
    const workerNames = ["review", "tests"].map((label) =>
      buildWorkerSessionName(TEST_CONVERSATION_ID, "claude", label)
    );
    sessions.liveSessions = workerNames.map((name, index) => ({
      name,
      conversationId: TEST_CONVERSATION_ID,
      role: "worker" as const,
      provider: "claude" as const,
      label: `Worker ${String(index)}`,
      status: "running" as const,
      attached: false,
      startedAt: "2026-08-21T12:01:00.000Z"
    }));
    const originalKill = sessions.kill.bind(sessions);
    const started: string[] = [];
    let releaseWorkers: () => void = () => undefined;
    const workerGate = new Promise<void>((resolve) => {
      releaseWorkers = resolve;
    });
    sessions.kill = async (name) => {
      if (name === conversation.captainSessionName) return originalKill(name);
      started.push(name);
      await workerGate;
      return originalKill(name);
    };

    const deletion = service.deleteConversation(conversation.id);
    await expect.poll(() => started.length).toBe(2);
    releaseWorkers();
    await expect(deletion).resolves.toBeUndefined();

    expect(new Set(started)).toEqual(new Set(workerNames));
  });

  it("retains every concurrent worker cleanup failure", async () => {
    const { repository, sessions, service } = createFixture();
    const conversation = await service.createConversation({
      ...PROJECT_INPUT,
      prompt: "Coordinate the work",
      provider: "codex",
      model: null,
      reasoning: null
    });
    const workerNames = ["review", "tests"].map((label) =>
      buildWorkerSessionName(TEST_CONVERSATION_ID, "claude", label)
    );
    sessions.liveSessions = workerNames.map((name, index) => ({
      name,
      conversationId: TEST_CONVERSATION_ID,
      role: "worker" as const,
      provider: "claude" as const,
      label: `Worker ${String(index)}`,
      status: "running" as const,
      attached: false,
      startedAt: "2026-08-21T12:01:00.000Z"
    }));
    const failures = workerNames.map((name) => {
      const error = new Error(`failed to stop ${name}`);
      sessions.killErrors.set(name, error);
      return error;
    });

    const error = await service
      .deleteConversation(conversation.id)
      .catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual(failures);
    expect(repository.conversations).toEqual([conversation]);
  });

  it("keeps conversation metadata when session cleanup fails", async () => {
    const { repository, sessions, service } = createFixture();
    const conversation = await service.createConversation({
      ...PROJECT_INPUT,
      prompt: "Coordinate the work",
      provider: "codex",
      model: null,
      reasoning: null
    });
    sessions.killErrors.set(conversation.captainSessionName, new Error("tmux unavailable"));

    await expect(service.deleteConversation(conversation.id)).rejects.toThrow("tmux unavailable");
    expect(repository.conversations).toEqual([conversation]);
  });

  it("rejects deleting a missing conversation", async () => {
    const { sessions, service } = createFixture();

    await expect(service.deleteConversation(TEST_CONVERSATION_ID)).rejects.toBeInstanceOf(
      NotFoundError
    );
    expect(sessions.killed).toHaveLength(0);
  });

  it("never targets a captain identity corrupted by another repository adapter", async () => {
    const { repository, sessions, service } = createFixture();
    const conversation = await service.createConversation({
      ...PROJECT_INPUT,
      prompt: "Coordinate the work",
      provider: "codex",
      model: null,
      reasoning: null
    });
    repository.conversations[0] = {
      ...conversation,
      captainSessionName: buildCaptainSessionName("22222222-2222-4222-8222-222222222222", "claude")
    };

    await expect(service.deleteConversation(conversation.id)).rejects.toThrow(
      "Persisted captain session does not match its conversation owner."
    );
    expect(sessions.killed).toEqual([]);
  });

  it("never deletes the Captain", async () => {
    const { sessions, service } = createFixture();
    const conversation = await service.createConversation({
      ...PROJECT_INPUT,
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
      ...PROJECT_INPUT,
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
