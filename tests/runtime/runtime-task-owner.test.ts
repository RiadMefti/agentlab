import { describe, expect, it, vi } from "vitest";

import type { AgentLabCommandPort } from "../../packages/runtime/src/application/agentlab-commands.js";
import { ownAgentLabCommands } from "../../packages/runtime/src/application/owned-agentlab-commands.js";
import { RuntimeTaskOwner } from "../../packages/runtime/src/application/runtime-task-owner.js";
import { withTimeout } from "../../packages/runtime/src/infrastructure/process/promise-timeout.js";

describe("RuntimeTaskOwner", () => {
  it("lets a caller stop waiting without abandoning admitted work", async () => {
    let release: () => void = () => undefined;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tasks = new RuntimeTaskOwner();
    const operation = tasks.run(() => pending);
    const drain = tasks.stopAndDrain();

    await expect(withTimeout(drain, { timeoutMs: 5, message: "caller deadline" })).rejects.toThrow(
      "caller deadline"
    );
    release();
    await expect(operation).resolves.toBeUndefined();
    await expect(drain).resolves.toBeUndefined();
    await expect(tasks.stopAndDrain()).resolves.toBeUndefined();
  });

  it("holds command admission behind owned startup reconciliation", async () => {
    let release: () => void = () => undefined;
    const ready = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tasks = new RuntimeTaskOwner();
    const initialization = tasks.initialize(() => ready);
    let ran = false;
    const command = tasks.run(() => {
      ran = true;
      return Promise.resolve();
    });

    await Promise.resolve();
    expect(ran).toBe(false);
    release();
    await initialization;
    await command;
    expect(ran).toBe(true);
  });

  it("fails every public command closed when startup reconciliation fails", async () => {
    const tasks = new RuntimeTaskOwner();
    const initialization = tasks.initialize(() =>
      Promise.reject(new Error("pending ownership conflict"))
    );
    const command = tasks.run(() => Promise.resolve("must not run"));

    await expect(initialization).rejects.toThrow("pending ownership conflict");
    await expect(command).rejects.toThrow("pending ownership conflict");
    await expect(tasks.stopAndDrain()).resolves.toBeUndefined();
  });

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
    const owned = ownAgentLabCommands(commands, tasks);

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
    const owned = ownAgentLabCommands(commands, tasks);

    const operation = owned.createConversation({});
    const shutdown = tasks.stopAndDrain();

    await expect(operation).rejects.toThrow("provider failed");
    await expect(shutdown).resolves.toBeUndefined();
  });

  it("drains an owned adapter operation after its caller deadline expires", async () => {
    let release: () => void = () => undefined;
    const adapterOperation = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tasks = new RuntimeTaskOwner();

    await expect(
      tasks.run(() =>
        withTimeout(tasks.own(adapterOperation), {
          timeoutMs: 5,
          message: "response deadline"
        })
      )
    ).rejects.toThrow("response deadline");

    const drain = tasks.stopAndDrain();
    await expect(withTimeout(drain, { timeoutMs: 5, message: "still owned" })).rejects.toThrow(
      "still owned"
    );
    release();
    await expect(drain).resolves.toBeUndefined();
  });
});

function commandPort(overrides: Partial<AgentLabCommandPort> = {}): AgentLabCommandPort {
  return {
    listConversations: () => Promise.resolve([]),
    inspectWorkspace: () => Promise.reject(new Error("not implemented")),
    prepareWorkspace: () => Promise.reject(new Error("not implemented")),
    discoverWorkspaceProviders: () => Promise.reject(new Error("not implemented")),
    completeFolders: () => Promise.resolve([]),
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
