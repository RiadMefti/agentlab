import { describe, expect, it, vi } from "vitest";

import type { OrchestratorCommandPort } from "../../packages/runtime/src/application/orchestrator-commands.js";
import {
  RuntimeTaskOwner,
  ownOrchestratorCommands
} from "../../packages/runtime/src/application/runtime-task-owner.js";

describe("RuntimeTaskOwner", () => {
  it("stops admission and drains a worker creation before shutdown can finish", async () => {
    let releaseProvider: () => void = () => undefined;
    const providerResolved = new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });
    let workerCreated = false;
    const commands = commandPort({
      async createWorker() {
        await providerResolved;
        workerCreated = true;
        return "worker-session";
      }
    });
    const tasks = new RuntimeTaskOwner();
    const owned = ownOrchestratorCommands(commands, tasks);

    const creation = owned.createWorker("conversation", {});
    await Promise.resolve();
    let shutdownFinished = false;
    const shutdown = tasks.stopAndDrain().then(() => {
      shutdownFinished = true;
    });
    await Promise.resolve();

    expect(shutdownFinished).toBe(false);
    expect(workerCreated).toBe(false);
    await expect(owned.listConversations()).rejects.toThrow("runtime is closing");

    releaseProvider();
    await expect(creation).resolves.toBe("worker-session");
    await shutdown;

    expect(workerCreated).toBe(true);
    expect(shutdownFinished).toBe(true);
  });

  it("finishes draining when an admitted command fails", async () => {
    const commands = commandPort({
      createConversation: vi.fn(() => Promise.reject(new Error("provider failed")))
    });
    const tasks = new RuntimeTaskOwner();
    const owned = ownOrchestratorCommands(commands, tasks);

    const operation = owned.createConversation({});
    const shutdown = tasks.stopAndDrain();

    await expect(operation).rejects.toThrow("provider failed");
    await expect(shutdown).resolves.toBeUndefined();
  });
});

function commandPort(overrides: Partial<OrchestratorCommandPort> = {}): OrchestratorCommandPort {
  return {
    listConversations: () => Promise.resolve([]),
    inspectWorkspace: () => Promise.reject(new Error("not implemented")),
    listProviders: () => Promise.resolve([]),
    createConversation: () => Promise.reject(new Error("not implemented")),
    deleteConversation: () => Promise.resolve(),
    listSessions: () => Promise.resolve([]),
    createWorker: () => Promise.reject(new Error("not implemented")),
    deleteWorker: () => Promise.resolve(),
    requireAttachableSession: (conversationId, sessionName) =>
      Promise.resolve({
        conversationId: String(conversationId),
        sessionName: String(sessionName),
        workspacePath: "/work/project"
      }),
    ...overrides
  };
}
