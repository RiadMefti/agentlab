/** @jsxImportSource @opentui/react */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";

import type { AgentSession, Conversation, ProviderCapability } from "@agentlab/contracts";
import type { LocalAgentLabRuntime, AgentLabCommandPort } from "@agentlab/runtime";

import { RuntimeContext } from "../../apps/tui/src/runtime-context.js";
import { useWorkspace, type WorkspaceState } from "../../apps/tui/src/use-workspace.js";
import { allowOpenTuiAsyncUpdates } from "./test-renderer.js";

const renderers: { destroy(): void }[] = [];

afterEach(() => {
  for (const renderer of renderers.splice(0)) renderer.destroy();
});

describe("workspace refresh coordination", () => {
  test("loads saved projects without choosing one on startup", async () => {
    const listSessions = mock(() => Promise.resolve([captainSession(firstConversation)]));
    const runtime = fakeRuntime({
      listConversations: mock(() => Promise.resolve([firstConversation])),
      listSessions
    });
    let latest: WorkspaceState | null = null;
    const setup = await renderWorkspace(runtime, (workspace) => {
      latest = workspace;
    });

    await setup.waitFor(() => current(latest).projects.length === 1);

    expect(current(latest).selectedProject).toBeNull();
    expect(current(latest).sessions).toEqual([]);
    expect(listSessions).not.toHaveBeenCalled();
  });

  test("keeps a successfully inserted project selected across a stale background refresh", async () => {
    const runtime = fakeRuntime({
      listConversations: mock(() => Promise.resolve([]))
    });
    let latest: WorkspaceState | null = null;
    const setup = await renderWorkspace(runtime, (workspace) => {
      latest = workspace;
    });
    await setup.waitFor(() => !current(latest).loading);

    await applyStateUpdate(setup, () => {
      current(latest).insertProject(firstConversation);
    });
    expect(current(latest).selectedProject?.id).toBe(firstConversation.id);
    await current(latest).refreshProjects();

    expect(current(latest).projects).toContainEqual(firstConversation);
    expect(current(latest).selectedProject?.id).toBe(firstConversation.id);
  });

  test("keeps provider failures visible after unrelated refreshes succeed", async () => {
    const providers = deferred<readonly ProviderCapability[]>();
    const runtime = fakeRuntime({
      listConversations: mock(() => Promise.resolve([firstConversation])),
      listProviders: mock(() => providers.promise),
      listSessions: mock(() => Promise.resolve([captainSession(firstConversation)]))
    });
    let latest: WorkspaceState | null = null;
    const setup = await renderWorkspace(runtime, (workspace) => {
      latest = workspace;
    });

    await setup.waitFor(() => current(latest).projects.length === 1);
    await applyStateUpdate(setup, () => {
      current(latest).selectProject(firstConversation.id);
    });
    await setup.waitFor(() => current(latest).selectedProject?.id === firstConversation.id);
    await applyStateUpdate(setup, () => {
      providers.reject(new Error("provider discovery failed"));
    });
    await setup.waitForFrame((frame) => frame.includes("provider discovery failed"));

    await current(latest).refreshProjects();

    expect(current(latest).error).toBe("provider discovery failed");
    expect(current(latest).sessions).toHaveLength(1);
  });

  test("ignores a late session failure from the previously selected conversation", async () => {
    const sessionRequests: Deferred<readonly AgentSession[]>[] = [];
    const runtime = fakeRuntime({
      listConversations: mock(() => Promise.resolve([firstConversation, secondConversation])),
      listSessions: mock(() => {
        const request = deferred<readonly AgentSession[]>();
        sessionRequests.push(request);
        return request.promise;
      })
    });
    let latest: WorkspaceState | null = null;
    const setup = await renderWorkspace(runtime, (workspace) => {
      latest = workspace;
    });
    await setup.waitFor(() => current(latest).projects.length === 2);
    await applyStateUpdate(setup, () => {
      current(latest).selectProject(firstConversation.id);
    });
    await setup.waitFor(() => sessionRequests.length === 1);

    await applyStateUpdate(setup, () => {
      current(latest).selectProject(secondConversation.id);
    });
    await setup.waitFor(() => sessionRequests.length === 2);
    await applyStateUpdate(setup, () => {
      sessionRequests[1]?.resolve([captainSession(secondConversation)]);
    });
    await setup.waitFor(
      () => current(latest).sessions[0]?.conversationId === secondConversation.id
    );
    await applyStateUpdate(setup, () => {
      sessionRequests[0]?.reject(new Error("old conversation failed"));
    });

    expect(current(latest).selectedProject?.id).toBe(secondConversation.id);
    expect(current(latest).error).toBeNull();
  });

  test("keeps the latest same-conversation result when requests resolve out of order", async () => {
    const sessionRequests: Deferred<readonly AgentSession[]>[] = [];
    const runtime = fakeRuntime({
      listConversations: mock(() => Promise.resolve([firstConversation])),
      listSessions: mock(() => {
        const request = deferred<readonly AgentSession[]>();
        sessionRequests.push(request);
        return request.promise;
      })
    });
    let latest: WorkspaceState | null = null;
    const setup = await renderWorkspace(runtime, (workspace) => {
      latest = workspace;
    });
    await setup.waitFor(() => current(latest).projects.length === 1);
    await applyStateUpdate(setup, () => {
      current(latest).selectProject(firstConversation.id);
    });
    await setup.waitFor(() => sessionRequests.length === 1);

    const manualRefresh = current(latest).refreshSessions();
    await setup.waitFor(() => sessionRequests.length === 2);
    await applyStateUpdate(setup, () => {
      sessionRequests[1]?.resolve([captainSession(firstConversation, "running")]);
    });
    await manualRefresh;
    await setup.waitFor(() => current(latest).sessions[0]?.status === "running");
    await applyStateUpdate(setup, () => {
      sessionRequests[0]?.resolve([captainSession(firstConversation, "stopped")]);
    });

    expect(current(latest).sessions[0]?.status).toBe("running");
  });

  test("restores cached sessions immediately when returning to a conversation", async () => {
    const sessionRequests: Deferred<readonly AgentSession[]>[] = [];
    const runtime = fakeRuntime({
      listConversations: mock(() => Promise.resolve([firstConversation, secondConversation])),
      listSessions: mock(() => {
        const request = deferred<readonly AgentSession[]>();
        sessionRequests.push(request);
        return request.promise;
      })
    });
    let latest: WorkspaceState | null = null;
    const setup = await renderWorkspace(runtime, (workspace) => {
      latest = workspace;
    });
    await setup.waitFor(() => current(latest).projects.length === 2);
    await applyStateUpdate(setup, () => {
      current(latest).selectProject(firstConversation.id);
    });
    await setup.waitFor(() => sessionRequests.length === 1);

    await applyStateUpdate(setup, () => {
      sessionRequests[0]?.resolve([captainSession(firstConversation)]);
    });
    await setup.waitFor(() => current(latest).sessions[0]?.conversationId === firstConversation.id);
    await applyStateUpdate(setup, () => {
      current(latest).selectProject(secondConversation.id);
    });
    await setup.waitFor(() => sessionRequests.length === 2);
    await applyStateUpdate(setup, () => {
      sessionRequests[1]?.resolve([captainSession(secondConversation)]);
    });
    await setup.waitFor(
      () => current(latest).sessions[0]?.conversationId === secondConversation.id
    );

    await applyStateUpdate(setup, () => {
      current(latest).selectProject(firstConversation.id);
    });

    expect(current(latest).sessions[0]?.conversationId).toBe(firstConversation.id);
    expect(current(latest).selectedSession?.name).toBe(firstConversation.captainSessionName);
  });
});

const firstConversation: Conversation = {
  id: "11111111-1111-4111-8111-111111111111",
  title: "First conversation",
  workspacePath: "/work/first",
  provider: "codex",
  model: null,
  reasoning: null,
  captainSessionName: "agentlab__11111111-1111-4111-8111-111111111111__captain__codex",
  createdAt: "2026-08-25T12:00:00.000Z",
  updatedAt: "2026-08-25T12:00:00.000Z"
};

const secondConversation: Conversation = {
  id: "22222222-2222-4222-8222-222222222222",
  title: "Second conversation",
  workspacePath: "/work/second",
  provider: "claude",
  model: null,
  reasoning: null,
  captainSessionName: "agentlab__22222222-2222-4222-8222-222222222222__captain__claude",
  createdAt: "2026-08-25T12:01:00.000Z",
  updatedAt: "2026-08-25T12:01:00.000Z"
};

function captainSession(
  conversation: Conversation,
  status: AgentSession["status"] = "running"
): AgentSession {
  return {
    name: conversation.captainSessionName,
    conversationId: conversation.id,
    role: "captain",
    provider: conversation.provider,
    label: "Captain",
    status,
    attached: false,
    startedAt: "2026-08-25T12:00:00.000Z"
  };
}

async function renderWorkspace(
  runtime: LocalAgentLabRuntime,
  onRender: (workspace: WorkspaceState) => void
) {
  const setup = await testRender(
    <RuntimeContext value={runtime}>
      <WorkspaceProbe onRender={onRender} />
    </RuntimeContext>,
    { height: 4, width: 100 }
  );
  allowOpenTuiAsyncUpdates();
  renderers.push(setup.renderer);
  return setup;
}

function WorkspaceProbe({ onRender }: { readonly onRender: (state: WorkspaceState) => void }) {
  const workspace = useWorkspace();
  onRender(workspace);
  return (
    <text>
      {workspace.selectedProject?.title ?? "none"} · {workspace.error ?? "ok"} ·{" "}
      {workspace.sessions[0]?.status ?? "no session"}
    </text>
  );
}

function fakeRuntime(overrides: Partial<AgentLabCommandPort>): LocalAgentLabRuntime {
  const providers: readonly ProviderCapability[] = [];
  const commands: AgentLabCommandPort = {
    listConversations: mock(() => Promise.resolve([])),
    inspectWorkspace: mock(() => Promise.reject(new Error("not used"))),
    prepareWorkspace: mock(() => Promise.reject(new Error("not used"))),
    discoverWorkspaceProviders: mock(() => Promise.resolve([])),
    completeFolders: mock(() => Promise.resolve([])),
    listProviders: mock(() => Promise.resolve(providers)),
    createConversation: mock(() => Promise.resolve(firstConversation)),
    deleteConversation: mock(() => Promise.resolve()),
    listSessions: mock(() => Promise.resolve([])),
    createWorker: mock(() => Promise.resolve("")),
    deleteWorker: mock(() => Promise.resolve()),
    requireAttachableSession: mock((conversationId, sessionName) =>
      Promise.resolve({
        conversationId: String(conversationId),
        sessionName: String(sessionName),
        workspacePath: "/work/project"
      })
    ),
    ...overrides
  };
  return {
    commands,
    openTerminal: mock(() => Promise.reject(new Error("Terminal is not used in this test."))),
    close: mock(() => Promise.resolve())
  };
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: Error): void;
}

function deferred<T>(): Deferred<T> {
  let resolve = (value: T): void => {
    void value;
  };
  let reject = (error: Error): void => {
    void error;
  };
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

function current(state: WorkspaceState | null): WorkspaceState {
  if (state === null) throw new Error("Workspace state has not rendered.");
  return state;
}

async function applyStateUpdate(
  setup: { flush(): Promise<void> },
  update: () => void
): Promise<void> {
  allowOpenTuiAsyncUpdates();
  update();
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
  await setup.flush();
}
