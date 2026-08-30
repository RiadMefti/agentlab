import { describe, expect, it } from "vitest";

import { ConversationService } from "../../packages/runtime/src/application/conversation-service.js";
import {
  buildCaptainSessionName,
  buildWorkerSessionName
} from "../../packages/runtime/src/domain/agent-session-name.js";
import { storedConversationSchema } from "../../packages/runtime/src/domain/conversation-record.js";
import {
  ConflictError,
  NotFoundError,
  ProviderUnavailableError
} from "../../packages/runtime/src/domain/errors.js";
import type {
  CreateCaptainSessionInput,
  OwnedSessionKillResult,
  SessionOwnership
} from "../../packages/runtime/src/domain/session-runtime.js";
import { SessionCreationError } from "../../packages/runtime/src/domain/session-runtime.js";
import { TmuxCaptainPolicyRenderer } from "../../packages/runtime/src/infrastructure/tmux/captain-policy.js";
import {
  MemoryConversationRepository,
  MemorySessionRuntime,
  StaticProviderCatalog,
  StaticWorkspacePathResolver,
  TEST_CONVERSATION_ID
} from "../helpers/fakes.js";

const TEST_NONCE = "22222222-2222-4222-8222-222222222222";
const OTHER_NONCE = "33333333-3333-4333-8333-333333333333";
const NONCE_OWNERSHIP = { mode: "nonce", nonce: TEST_NONCE } as const;
const PROJECT_INPUT = {
  title: "Test project",
  workspacePath: "/work/project"
} as const;

function createFixture(sessions: MemorySessionRuntime = new MemorySessionRuntime()) {
  const repository = new MemoryConversationRepository();
  const providers = new StaticProviderCatalog();
  const workspacePaths = new StaticWorkspacePathResolver();
  const service = new ConversationService({
    repository,
    sessions,
    providers,
    workspacePaths,
    captainPolicy: new TmuxCaptainPolicyRenderer(),
    now: () => new Date("2026-08-21T12:00:00.000Z"),
    createId: () => TEST_CONVERSATION_ID,
    createOwnershipNonce: () => TEST_NONCE
  });
  return { repository, sessions, providers, workspacePaths, service };
}

async function createProject(
  service: ConversationService,
  overrides: Partial<Parameters<ConversationService["createConversation"]>[0]> = {}
) {
  return service.createConversation({
    ...PROJECT_INPUT,
    prompt: "Coordinate the work",
    provider: "codex",
    model: null,
    reasoning: null,
    ...overrides
  });
}

describe("ConversationService", () => {
  it("re-resolves workspace input before every provider discovery boundary", async () => {
    const { providers, workspacePaths, service } = createFixture();

    const prepared = await service.prepareWorkspace("/work/project");
    await service.discoverWorkspaceProviders(prepared.workspacePath);

    expect(workspacePaths.inputs).toEqual(["/work/project", "/work/project"]);
    expect(providers.workspaces).toEqual(["/work/project"]);
  });

  it("reserves creating state before launch and exposes only the activated public DTO", async () => {
    const observations: string[] = [];
    const sessions = new (class extends MemorySessionRuntime {
      public repository: MemoryConversationRepository | null = null;

      public override createCaptain(input: CreateCaptainSessionInput): Promise<void> {
        observations.push(this.repository?.conversations[0]?.lifecycleState ?? "missing");
        return super.createCaptain(input);
      }
    })();
    const { repository, service } = createFixture(sessions);
    sessions.repository = repository;

    const conversation = await createProject(service, {
      prompt: "Investigate the refresh race",
      model: "gpt-test",
      reasoning: "high"
    });

    expect(observations).toEqual(["creating"]);
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
    expect(repository.conversations[0]).toMatchObject({
      ...conversation,
      lifecycleState: "active",
      ownershipMode: "nonce",
      ownershipNonce: TEST_NONCE
    });
    expect(sessions.created[0]).toMatchObject({
      name: conversation.captainSessionName,
      ownership: { mode: "nonce", nonce: TEST_NONCE }
    });
    expect(sessions.created[0]?.command.environment).toMatchObject({
      AGENTLAB_WORKSPACE: "/work/project",
      AGENTLAB_SESSION_OWNERSHIP: TEST_NONCE,
      AGENTLAB_CODEX_BIN: "/opt/bin/codex"
    });
  });

  it("does not reserve or launch when the selected provider is unavailable", async () => {
    const repository = new MemoryConversationRepository();
    const sessions = new MemorySessionRuntime();
    const service = new ConversationService({
      repository,
      sessions,
      providers: new StaticProviderCatalog(new Map()),
      workspacePaths: new StaticWorkspacePathResolver(),
      captainPolicy: new TmuxCaptainPolicyRenderer(),
      now: () => new Date("2026-08-21T12:00:00.000Z"),
      createId: () => TEST_CONVERSATION_ID,
      createOwnershipNonce: () => TEST_NONCE
    });

    await expect(
      createProject(service, { provider: "claude", reasoning: "high" })
    ).rejects.toBeInstanceOf(ProviderUnavailableError);
    expect(repository.conversations).toEqual([]);
    expect(sessions.created).toEqual([]);
  });

  it("cleans a nonce-owned captain and pre-activation workers when activation fails", async () => {
    const workerName = buildWorkerSessionName(TEST_CONVERSATION_ID, "codex", "early-worker");
    const sessions = new (class extends MemorySessionRuntime {
      public override async createCaptain(input: CreateCaptainSessionInput): Promise<void> {
        await super.createCaptain(input);
        this.addLiveSession(workerName, "Early Worker", input.ownership);
      }
    })();
    const { repository, service } = createFixture(sessions);
    const primary = new Error("activation write failed");
    repository.transitionError = primary;

    await expect(createProject(service)).rejects.toBe(primary);

    expect(new Set(sessions.killed)).toEqual(
      new Set([buildCaptainSessionName(TEST_CONVERSATION_ID, "codex"), workerName])
    );
    expect(repository.conversations).toEqual([]);
  });

  it("retains an ambiguous duplicate creation journal without killing the existing session", async () => {
    const sessions = new MemorySessionRuntime();
    const captain = buildCaptainSessionName(TEST_CONVERSATION_ID, "codex");
    sessions.addLiveSession(captain, "Existing Captain", NONCE_OWNERSHIP);
    sessions.createError = new Error("duplicate or ambiguous new-session");
    const { repository, service } = createFixture(sessions);

    await expect(createProject(service)).rejects.toThrow("duplicate or ambiguous new-session");

    expect(sessions.killed).toEqual([]);
    expect(sessions.liveSessions.map(({ name }) => name)).toEqual([captain]);
    expect(repository.conversations).toEqual([
      expect.objectContaining({ lifecycleState: "creating", ownershipNonce: TEST_NONCE })
    ]);
  });

  it("removes a creating reservation only after the adapter proves failed creation absent", async () => {
    const sessions = new MemorySessionRuntime();
    const primary = new Error("configuration failed after creation");
    sessions.createError = new SessionCreationError(primary, "confirmed-absent");
    const { repository, service } = createFixture(sessions);

    await expect(createProject(service)).rejects.toThrow(primary.message);

    expect(repository.conversations).toEqual([]);
    expect(sessions.killed).toEqual([]);
  });

  it("returns a committed activation when the repository response is ambiguous", async () => {
    const { repository, service } = createFixture();
    repository.transitionErrorAfterCommit = new Error("activation response lost");

    await expect(createProject(service)).resolves.toMatchObject({
      id: TEST_CONVERSATION_ID,
      captainSessionName: buildCaptainSessionName(TEST_CONVERSATION_ID, "codex")
    });
    expect(repository.conversations[0]?.lifecycleState).toBe("active");
  });

  it("retains creating state and never kills a pre-activation worker with conflicting proof", async () => {
    const workerName = buildWorkerSessionName(TEST_CONVERSATION_ID, "codex", "foreign-worker");
    const sessions = new (class extends MemorySessionRuntime {
      public override async createCaptain(input: CreateCaptainSessionInput): Promise<void> {
        await super.createCaptain(input);
        this.addLiveSession(workerName, "Foreign Worker", {
          mode: "nonce",
          nonce: OTHER_NONCE
        });
      }
    })();
    const { repository, service } = createFixture(sessions);
    repository.transitionError = new Error("activation write failed");

    await expect(createProject(service)).rejects.toThrow("activation write failed");

    expect(sessions.killed).toEqual([buildCaptainSessionName(TEST_CONVERSATION_ID, "codex")]);
    expect(sessions.liveSessions.map(({ name }) => name)).toContain(workerName);
    expect(repository.conversations[0]?.lifecycleState).toBe("creating");
  });

  it("reconciles an absent creating session by removing only its reservation", async () => {
    const { repository, service } = createFixture();
    repository.conversations.push(
      storedConversationSchema.parse({
        ...baseConversation(),
        lifecycleState: "creating",
        ownershipMode: "nonce",
        ownershipNonce: TEST_NONCE
      })
    );

    await expect(service.reconcilePending()).resolves.toBeUndefined();
    expect(repository.conversations).toEqual([]);
  });

  it("fails startup closed on a creating captain nonce conflict", async () => {
    const { repository, sessions, service } = createFixture();
    const record = storedConversationSchema.parse({
      ...baseConversation(),
      lifecycleState: "creating",
      ownershipMode: "nonce",
      ownershipNonce: TEST_NONCE
    });
    repository.conversations.push(record);
    sessions.addLiveSession(record.captainSessionName, "Foreign Captain", {
      mode: "nonce",
      nonce: OTHER_NONCE
    });

    await expect(service.reconcilePending()).rejects.toThrow(
      "startup reconciliation failed closed"
    );
    expect(repository.conversations).toEqual([record]);
    expect(sessions.killed).toEqual([]);
  });

  it("cleans matching creating workers while retaining every conflicting identity", async () => {
    const { repository, sessions, service } = createFixture();
    const record = storedConversationSchema.parse({
      ...baseConversation(),
      lifecycleState: "creating",
      ownershipMode: "nonce",
      ownershipNonce: TEST_NONCE
    });
    const ownedWorker = buildWorkerSessionName(record.id, "codex", "owned-early");
    const foreignWorker = buildWorkerSessionName(record.id, "codex", "foreign-early");
    repository.conversations.push(record);
    sessions.addLiveSession(record.captainSessionName, "Foreign Captain", {
      mode: "nonce",
      nonce: OTHER_NONCE
    });
    sessions.addLiveSession(ownedWorker, "Owned Worker", {
      mode: "nonce",
      nonce: TEST_NONCE
    });
    sessions.addLiveSession(foreignWorker, "Foreign Worker", {
      mode: "nonce",
      nonce: OTHER_NONCE
    });

    await expect(service.reconcilePending()).rejects.toThrow(
      "startup reconciliation failed closed"
    );

    expect(sessions.killed).toEqual([ownedWorker]);
    expect(sessions.liveSessions.map(({ name }) => name)).toEqual([
      record.captainSessionName,
      foreignWorker
    ]);
    expect(repository.conversations).toEqual([record]);
  });

  it("retains creating state when raw tmux inventory is ambiguous", async () => {
    const sessions = new (class extends MemorySessionRuntime {
      public override list(): Promise<never> {
        return Promise.reject(new Error("tmux inventory unavailable"));
      }
    })();
    const { repository, service } = createFixture(sessions);
    const record = storedConversationSchema.parse({
      ...baseConversation(),
      lifecycleState: "creating",
      ownershipMode: "nonce",
      ownershipNonce: TEST_NONCE
    });
    repository.conversations.push(record);

    await expect(service.reconcilePending()).rejects.toThrow(
      "startup reconciliation failed closed"
    );
    expect(repository.conversations).toEqual([record]);
  });

  it("retains creating state when the final inventory loses server-generation coherence", async () => {
    const sessions = new (class extends MemorySessionRuntime {
      private inventoryCalls = 0;

      public override listInventory(conversationId: string) {
        this.inventoryCalls += 1;
        if (this.inventoryCalls === 2) {
          return Promise.reject(new Error("tmux server generation changed"));
        }
        return super.listInventory(conversationId);
      }
    })();
    const { repository, service } = createFixture(sessions);
    repository.conversations.push(
      storedConversationSchema.parse({
        ...baseConversation(),
        lifecycleState: "creating",
        ownershipMode: "nonce",
        ownershipNonce: TEST_NONCE
      })
    );

    await expect(service.reconcilePending()).rejects.toThrow(
      "startup reconciliation failed closed"
    );
    expect(repository.conversations[0]?.lifecycleState).toBe("creating");
  });

  it("hides pending rows while retaining removable migrated legacy rows", async () => {
    const { repository, service } = createFixture();
    repository.conversations.push(
      storedConversationSchema.parse({
        ...baseConversation(),
        lifecycleState: "creating",
        ownershipMode: "nonce",
        ownershipNonce: TEST_NONCE
      }),
      storedConversationSchema.parse({
        ...baseConversation("44444444-4444-4444-8444-444444444444", null),
        lifecycleState: "legacy-unlinked",
        ownershipMode: "legacy-name",
        ownershipNonce: null
      })
    );

    await expect(service.listConversations()).resolves.toEqual([
      expect.objectContaining({
        id: "44444444-4444-4444-8444-444444444444",
        workspacePath: null
      })
    ]);
  });

  it("filters nonce conflicts and extra captains from listing and attachment", async () => {
    const { sessions, service } = createFixture();
    const conversation = await createProject(service);
    const ownedWorker = buildWorkerSessionName(TEST_CONVERSATION_ID, "codex", "owned");
    const foreignWorker = buildWorkerSessionName(TEST_CONVERSATION_ID, "codex", "foreign");
    const extraCaptain = buildCaptainSessionName(TEST_CONVERSATION_ID, "claude");
    sessions.addLiveSession(ownedWorker, "Owned", { mode: "nonce", nonce: TEST_NONCE });
    sessions.addLiveSession(foreignWorker, "Foreign", { mode: "nonce", nonce: OTHER_NONCE });
    sessions.addLiveSession(extraCaptain, "Extra Captain", {
      mode: "nonce",
      nonce: TEST_NONCE
    });

    const listed = await service.listSessions(conversation.id);
    expect(listed.map(({ name }) => name)).toEqual([conversation.captainSessionName, ownedWorker]);
    await expect(
      service.requireAttachableSession(conversation.id, foreignWorker)
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      service.requireAttachableSession(conversation.id, extraCaptain)
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      service.assertSessionAttachable(conversation.id, ownedWorker)
    ).resolves.toMatchObject({
      sessionName: ownedWorker,
      ownership: NONCE_OWNERSHIP
    });
    await expect(
      service.assertSessionAttachable(conversation.id, foreignWorker)
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("stamps explicit workers with the active ownership mode", async () => {
    const { sessions, service } = createFixture();
    await createProject(service);

    const name = await service.createWorker(TEST_CONVERSATION_ID, {
      label: "Auth Tests",
      prompt: "Add focused authentication tests",
      provider: "codex"
    });

    expect(sessions.createdWorkers[0]).toMatchObject({
      name,
      ownership: { mode: "nonce", nonce: TEST_NONCE }
    });
  });

  it("rejects a persisted workspace that now canonicalizes to another project", async () => {
    const { workspacePaths, service } = createFixture();
    const conversation = await createProject(service);
    workspacePaths.resolve = () =>
      Promise.resolve({ path: "/work/different-project", suggestedName: "different-project" });

    await expect(service.listProviders(conversation.id)).rejects.toThrow(
      "saved folder now resolves somewhere else"
    );
  });

  it("marks deleting before stopping the captain and catches a late worker in final inventory", async () => {
    const lateWorker = buildWorkerSessionName(TEST_CONVERSATION_ID, "codex", "late");
    const sessions = new (class extends MemorySessionRuntime {
      public repository: MemoryConversationRepository | null = null;

      public override async killOwned(
        name: string,
        ownership: SessionOwnership
      ): Promise<OwnedSessionKillResult> {
        if (name.includes("__captain__")) {
          expect(this.repository?.conversations[0]?.lifecycleState).toBe("deleting");
          const result = await super.killOwned(name, ownership);
          this.addLiveSession(lateWorker, "Late Worker", ownership);
          return result;
        }
        return super.killOwned(name, ownership);
      }
    })();
    const { repository, service } = createFixture(sessions);
    sessions.repository = repository;
    const conversation = await createProject(service);

    await service.deleteConversation(conversation.id);

    expect(sessions.killed).toEqual([conversation.captainSessionName, lateWorker]);
    expect(repository.conversations).toEqual([]);
  });

  it("retains deleting and rejects later work when worker cleanup fails", async () => {
    const { repository, sessions, service } = createFixture();
    const conversation = await createProject(service);
    const worker = buildWorkerSessionName(TEST_CONVERSATION_ID, "codex", "blocked");
    sessions.addLiveSession(worker, "Blocked", { mode: "nonce", nonce: TEST_NONCE });
    sessions.killErrors.set(worker, new Error("tmux unavailable"));

    await expect(service.deleteConversation(conversation.id)).rejects.toThrow("tmux unavailable");
    expect(repository.conversations[0]?.lifecycleState).toBe("deleting");
    await expect(
      service.createWorker(conversation.id, {
        label: "Too Late",
        prompt: "Must not start",
        provider: "codex"
      })
    ).rejects.toThrow("not active");
  });

  it("resumes a journaled deleting transition during startup", async () => {
    const { repository, sessions, service } = createFixture();
    const conversation = await createProject(service);
    const worker = buildWorkerSessionName(conversation.id, "codex", "restart-worker");
    sessions.addLiveSession(worker, "Restart Worker", {
      mode: "nonce",
      nonce: TEST_NONCE
    });
    repository.conversations[0] = storedConversationSchema.parse({
      ...repository.conversations[0],
      lifecycleState: "deleting"
    });

    await expect(service.reconcilePending()).resolves.toBeUndefined();

    expect(new Set(sessions.killed)).toEqual(new Set([conversation.captainSessionName, worker]));
    expect(repository.conversations).toEqual([]);
  });

  it("rejects a worker queued after durable deletion begins", async () => {
    let releaseCaptain!: () => void;
    let captainStopStarted!: () => void;
    const captainStarted = new Promise<void>((resolve) => {
      captainStopStarted = resolve;
    });
    const captainGate = new Promise<void>((resolve) => {
      releaseCaptain = resolve;
    });
    const sessions = new (class extends MemorySessionRuntime {
      public override async killOwned(
        name: string,
        ownership: SessionOwnership
      ): Promise<OwnedSessionKillResult> {
        if (name.includes("__captain__")) {
          captainStopStarted();
          await captainGate;
        }
        return super.killOwned(name, ownership);
      }
    })();
    const { service } = createFixture(sessions);
    const conversation = await createProject(service);

    const deletion = service.deleteConversation(conversation.id);
    await captainStarted;
    const worker = service.createWorker(conversation.id, {
      label: "Queued Worker",
      prompt: "Must never launch",
      provider: "codex"
    });
    releaseCaptain();

    await expect(deletion).resolves.toBeUndefined();
    await expect(worker).rejects.toBeInstanceOf(NotFoundError);
    expect(sessions.createdWorkers).toEqual([]);
  });

  it("retains deleting when authorized worker churn exhausts the cleanup budget", async () => {
    let workerNumber = 0;
    const sessions = new (class extends MemorySessionRuntime {
      public override async killOwned(
        name: string,
        ownership: SessionOwnership
      ): Promise<OwnedSessionKillResult> {
        const result = await super.killOwned(name, ownership);
        if (result === "killed" && name.includes("__worker__")) {
          workerNumber += 1;
          this.addLiveSession(
            buildWorkerSessionName(TEST_CONVERSATION_ID, "codex", `churn-${String(workerNumber)}`),
            "Churn Worker",
            ownership
          );
        }
        return result;
      }
    })();
    const { repository, service } = createFixture(sessions);
    const conversation = await createProject(service);
    sessions.addLiveSession(
      buildWorkerSessionName(conversation.id, "codex", "churn-initial"),
      "Initial Worker",
      { mode: "nonce", nonce: TEST_NONCE }
    );

    await expect(service.deleteConversation(conversation.id)).rejects.toThrow(
      "did not reach an empty final inventory"
    );
    expect(repository.conversations[0]?.lifecycleState).toBe("deleting");
    expect(sessions.liveSessions).toHaveLength(1);
  });

  it("does not touch workers after the persisted captain fails ownership proof", async () => {
    const { repository, sessions, service } = createFixture();
    const conversation = await createProject(service);
    const worker = buildWorkerSessionName(conversation.id, "codex", "still-owned");
    sessions.ownershipByName.set(conversation.captainSessionName, OTHER_NONCE);
    sessions.addLiveSession(worker, "Still Owned", {
      mode: "nonce",
      nonce: TEST_NONCE
    });

    await expect(service.deleteConversation(conversation.id)).rejects.toThrow(
      "Captain session ownership does not match"
    );
    expect(sessions.killed).toEqual([]);
    expect(sessions.liveSessions.map(({ name }) => name)).toContain(worker);
    expect(repository.conversations[0]?.lifecycleState).toBe("deleting");
  });

  it("retains deleting state when the final inventory loses server-generation coherence", async () => {
    const sessions = new (class extends MemorySessionRuntime {
      private inventoryCalls = 0;

      public override listInventory(conversationId: string) {
        this.inventoryCalls += 1;
        if (this.inventoryCalls === 2) {
          return Promise.reject(new Error("tmux server generation changed"));
        }
        return super.listInventory(conversationId);
      }
    })();
    const { repository, service } = createFixture(sessions);
    const conversation = await createProject(service);

    await expect(service.deleteConversation(conversation.id)).rejects.toThrow(
      "tmux server generation changed"
    );
    expect(repository.conversations[0]?.lifecycleState).toBe("deleting");
  });

  it("bounds concurrent destructive cleanup across a maximum-sized worker set", async () => {
    let active = 0;
    let maximumActive = 0;
    const sessions = new (class extends MemorySessionRuntime {
      public override async killOwned(
        name: string,
        ownership: SessionOwnership
      ): Promise<OwnedSessionKillResult> {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await new Promise((resolve) => setTimeout(resolve, 2));
        try {
          return await super.killOwned(name, ownership);
        } finally {
          active -= 1;
        }
      }
    })();
    const { service } = createFixture(sessions);
    const conversation = await createProject(service);
    for (let index = 0; index < 20; index += 1) {
      sessions.addLiveSession(
        buildWorkerSessionName(conversation.id, "codex", `bounded-${String(index)}`),
        `Bounded ${String(index)}`,
        NONCE_OWNERSHIP
      );
    }

    await service.deleteConversation(conversation.id);

    expect(maximumActive).toBeLessThanOrEqual(8);
    expect(maximumActive).toBeGreaterThan(1);
  });

  it("never admits normal deletion of creating state", async () => {
    const { repository, sessions, service } = createFixture();
    repository.conversations.push(
      storedConversationSchema.parse({
        ...baseConversation(),
        lifecycleState: "creating",
        ownershipMode: "nonce",
        ownershipNonce: TEST_NONCE
      })
    );

    await expect(service.deleteConversation(TEST_CONVERSATION_ID)).rejects.toThrow(
      "still being recovered"
    );
    expect(sessions.killed).toEqual([]);
  });

  it("does not destroy or expose an additional captain-shaped session", async () => {
    const { repository, sessions, service } = createFixture();
    const conversation = await createProject(service);
    const extraCaptain = buildCaptainSessionName(TEST_CONVERSATION_ID, "claude");
    sessions.addLiveSession(extraCaptain, "Extra", { mode: "nonce", nonce: TEST_NONCE });

    await service.deleteConversation(conversation.id);

    expect(sessions.killed).toEqual([conversation.captainSessionName]);
    expect(sessions.liveSessions.map(({ name }) => name)).toEqual([extraCaptain]);
    expect(repository.conversations).toEqual([]);
  });

  it("lists authorized sessions from one ownership-bearing inventory snapshot", async () => {
    const sessions = new (class extends MemorySessionRuntime {
      public override inspectOwnership(): Promise<never> {
        return Promise.reject(new Error("per-session ownership probe must not run"));
      }
    })();
    const { service } = createFixture(sessions);
    const conversation = await createProject(service);

    await expect(service.listSessions(conversation.id)).resolves.toEqual([
      expect.objectContaining({ name: conversation.captainSessionName })
    ]);
  });

  it("rejects single-worker deletion when nonce ownership conflicts", async () => {
    const { sessions, service } = createFixture();
    const conversation = await createProject(service);
    const worker = buildWorkerSessionName(TEST_CONVERSATION_ID, "codex", "foreign");
    sessions.addLiveSession(worker, "Foreign", { mode: "nonce", nonce: OTHER_NONCE });

    await expect(service.deleteWorker(conversation.id, worker)).rejects.toBeInstanceOf(
      ConflictError
    );
    expect(sessions.liveSessions.map(({ name }) => name)).toContain(worker);
  });

  it("preserves migrated legacy-name worker creation and exact-identity cleanup", async () => {
    const { repository, sessions, service } = createFixture();
    const record = storedConversationSchema.parse({
      ...baseConversation(),
      lifecycleState: "active",
      ownershipMode: "legacy-name",
      ownershipNonce: null
    });
    repository.conversations.push(record);
    sessions.addLiveSession(record.captainSessionName, "Legacy Captain", {
      mode: "legacy-name"
    });

    const worker = await service.createWorker(record.id, {
      label: "Legacy Worker",
      prompt: "Preserve compatibility",
      provider: "codex"
    });
    expect(sessions.createdWorkers[0]?.ownership).toEqual({ mode: "legacy-name" });

    await service.deleteConversation(record.id);
    expect(sessions.killed).toEqual([record.captainSessionName, worker]);
    expect(repository.conversations).toEqual([]);
  });

  it("removes a migrated legacy-unlinked row without requiring a workspace", async () => {
    const { repository, service } = createFixture();
    const record = storedConversationSchema.parse({
      ...baseConversation(TEST_CONVERSATION_ID, null),
      lifecycleState: "legacy-unlinked",
      ownershipMode: "legacy-name",
      ownershipNonce: null
    });
    repository.conversations.push(record);

    await expect(service.deleteConversation(record.id)).resolves.toBeUndefined();
    expect(repository.conversations).toEqual([]);
  });

  it("refuses a corrupted persisted captain identity before targeting tmux", async () => {
    const { repository, sessions, service } = createFixture();
    const conversation = await createProject(service);
    repository.conversations[0] = storedConversationSchema.parse({
      ...repository.conversations[0],
      captainSessionName: buildCaptainSessionName("44444444-4444-4444-8444-444444444444", "codex")
    });

    await expect(service.deleteConversation(conversation.id)).rejects.toThrow(
      "does not match its conversation owner"
    );
    expect(sessions.killed).toEqual([]);
  });

  it("rejects unsupported reasoning before reserving state", async () => {
    const { repository, service } = createFixture();

    await expect(createProject(service, { reasoning: "max" })).rejects.toBeInstanceOf(
      ConflictError
    );
    expect(repository.conversations).toEqual([]);
  });
});

function baseConversation(
  id: string = TEST_CONVERSATION_ID,
  workspacePath: string | null = "/work/project"
) {
  return {
    id,
    title: "Test project",
    workspacePath,
    provider: "codex" as const,
    model: null,
    reasoning: null,
    captainSessionName: buildCaptainSessionName(id, "codex"),
    createdAt: "2026-08-21T12:00:00.000Z",
    updatedAt: "2026-08-21T12:00:00.000Z"
  };
}
