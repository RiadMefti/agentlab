import { describe, expect, it, vi } from "vitest";

import type { AgentLabCommandPort } from "../../packages/runtime/src/application/agentlab-commands.js";
import { LocalRuntimeCoordinator } from "../../packages/runtime/src/application/local-runtime-coordinator.js";
import { RuntimeResourceOwner } from "../../packages/runtime/src/application/runtime-resource-owner.js";
import { RuntimeTaskOwner } from "../../packages/runtime/src/application/runtime-task-owner.js";
import type {
  ManagedPseudoTerminal,
  ManagedPseudoTerminalFactory,
  ManagedTerminalHistoryReader
} from "../../packages/runtime/src/domain/terminal.js";
import type { SessionAttachmentTarget } from "../../packages/runtime/src/domain/session-runtime.js";
import type { WriterLease } from "../../packages/runtime/src/domain/writer-lease.js";
import { MemoryConversationRepository, TEST_CONVERSATION_ID } from "../helpers/fakes.js";

const SESSION_NAME = `agentlab__${TEST_CONVERSATION_ID}__captain__codex`;
const OWNERSHIP = { mode: "nonce", nonce: "22222222-2222-4222-8222-222222222222" } as const;

describe("LocalRuntimeCoordinator", () => {
  it("revalidates session ownership after history and immediately before PTY attachment", async () => {
    const order: string[] = [];
    const fixture = coordinatorFixture({
      commandHandler: {
        requireAttachableSession: () => {
          order.push("command-boundary");
          return Promise.resolve({
            conversationId: TEST_CONVERSATION_ID,
            sessionName: SESSION_NAME,
            workspacePath: "/work/project"
          });
        }
      },
      conversations: {
        assertSessionAttachable: () => {
          order.push("ownership-boundary");
          return Promise.resolve(attachmentTarget());
        }
      },
      terminalHistory: {
        read: (target) => {
          expect(target).toEqual(attachmentTarget());
          order.push("history");
          return Promise.resolve("old output");
        }
      },
      terminalFactory: {
        attach: (target, _cwd, _dimensions, owner) => {
          expect(target).toEqual(attachmentTarget());
          expect(owner).toBeInstanceOf(RuntimeResourceOwner);
          order.push("attach");
          return fakePseudoTerminal();
        }
      }
    });

    const attached = await fixture.coordinator.openTerminal({
      conversationId: TEST_CONVERSATION_ID,
      sessionName: SESSION_NAME,
      columns: 120,
      rows: 40,
      callbacks: { onData: vi.fn(), onExit: vi.fn() }
    });

    expect(attached.history).toBe("old output");
    expect(order).toEqual([
      "command-boundary",
      "ownership-boundary",
      "history",
      "ownership-boundary",
      "attach"
    ]);
    attached.terminal.close();
    await fixture.coordinator.close();
  });

  it("rejects attachment when ownership changes while history is loading", async () => {
    const attach = vi.fn(fakePseudoTerminal);
    let proof = 0;
    const fixture = coordinatorFixture({
      conversations: {
        assertSessionAttachable: () => {
          proof += 1;
          return Promise.resolve(
            proof === 1 ? attachmentTarget() : attachmentTarget("$43", "101", "201")
          );
        }
      },
      terminalHistory: { read: () => Promise.resolve("old output") },
      terminalFactory: { attach }
    });

    await expect(
      fixture.coordinator.openTerminal({
        conversationId: TEST_CONVERSATION_ID,
        sessionName: SESSION_NAME,
        columns: 120,
        rows: 40,
        callbacks: { onData: vi.fn(), onExit: vi.fn() }
      })
    ).rejects.toThrow("changed while its terminal history was loading");
    expect(attach).not.toHaveBeenCalled();
    await fixture.coordinator.close();
  });

  it("retains the writer lease after resource failure and retries unfinished phases", async () => {
    const resourceOwner = new RuntimeResourceOwner();
    let closeAttempts = 0;
    resourceOwner.track({
      closeAndWait() {
        closeAttempts += 1;
        return closeAttempts === 1
          ? Promise.reject(new Error("terminal close failed"))
          : Promise.resolve();
      }
    });
    const fixture = coordinatorFixture({ resourceOwner });

    const first = fixture.coordinator.close();
    expect(fixture.coordinator.close()).toBe(first);
    await expect(first).rejects.toThrow("could not close cleanly");
    expect(fixture.repository.closed).toBe(true);
    expect(fixture.lease.closeCalls).toBe(0);

    await expect(fixture.coordinator.close()).resolves.toBeUndefined();
    expect(closeAttempts).toBe(2);
    expect(fixture.lease.closeCalls).toBe(1);
  });

  it("retains the writer lease after repository failure and retries without re-closing terminals", async () => {
    const repository = new (class extends MemoryConversationRepository {
      public closeAttempts = 0;

      public override close(): void {
        this.closeAttempts += 1;
        if (this.closeAttempts === 1) throw new Error("repository close failed");
        super.close();
      }
    })();
    const fixture = coordinatorFixture({ repository });

    await expect(fixture.coordinator.close()).rejects.toThrow("could not close cleanly");
    expect(fixture.lease.closeCalls).toBe(0);
    await expect(fixture.coordinator.close()).resolves.toBeUndefined();
    expect(repository.closeAttempts).toBe(2);
    expect(fixture.lease.closeCalls).toBe(1);
  });

  it("retries writer-lease finalization after all prerequisites are closed", async () => {
    const lease = new TestWriterLease(1);
    const fixture = coordinatorFixture({ lease });

    await expect(fixture.coordinator.close()).rejects.toThrow("could not close cleanly");
    expect(fixture.repository.closed).toBe(true);
    expect(lease.closeCalls).toBe(1);

    await expect(fixture.coordinator.close()).resolves.toBeUndefined();
    expect(lease.closeCalls).toBe(2);
  });

  it("retains a raw PTY when listener setup and its first cleanup both fail", async () => {
    let cleanupAttempts = 0;
    const closeAndWait = vi.fn(() => {
      cleanupAttempts += 1;
      return cleanupAttempts === 1
        ? Promise.reject(new Error("cleanup ambiguous"))
        : Promise.resolve();
    });
    const process: ManagedPseudoTerminal = {
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
      killAndWait: closeAndWait,
      closeAndWait,
      onData: () => {
        throw new Error("data subscription failed");
      },
      onExit: () => ({ dispose: vi.fn() })
    };
    const fixture = coordinatorFixture({ terminalFactory: { attach: () => process } });

    await expect(
      fixture.coordinator.openTerminal({
        conversationId: TEST_CONVERSATION_ID,
        sessionName: SESSION_NAME,
        columns: 80,
        rows: 24,
        callbacks: { onData: vi.fn(), onExit: vi.fn() }
      })
    ).rejects.toThrow("setup and cleanup both failed");
    expect(fixture.lease.closeCalls).toBe(0);

    await expect(fixture.coordinator.close()).resolves.toBeUndefined();
    expect(closeAndWait).toHaveBeenCalledTimes(2);
    expect(fixture.lease.closeCalls).toBe(1);
  });

  it("disposes partial listeners and confirms cleanup when exit subscription setup throws", async () => {
    const disposeData = vi.fn();
    const closeAndWait = vi.fn(() => Promise.resolve());
    const process: ManagedPseudoTerminal = {
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
      killAndWait: closeAndWait,
      closeAndWait,
      onData: () => ({ dispose: disposeData }),
      onExit: () => {
        throw new Error("exit subscription failed");
      }
    };
    const fixture = coordinatorFixture({ terminalFactory: { attach: () => process } });

    await expect(
      fixture.coordinator.openTerminal({
        conversationId: TEST_CONVERSATION_ID,
        sessionName: SESSION_NAME,
        columns: 80,
        rows: 24,
        callbacks: { onData: vi.fn(), onExit: vi.fn() }
      })
    ).rejects.toThrow("exit subscription failed");
    expect(disposeData).toHaveBeenCalledOnce();
    expect(closeAndWait).toHaveBeenCalledOnce();

    await fixture.coordinator.close();
    expect(closeAndWait).toHaveBeenCalledOnce();
  });
});

function coordinatorFixture(
  overrides: {
    readonly commandHandler?: {
      requireAttachableSession(): Promise<{
        readonly conversationId: string;
        readonly sessionName: string;
        readonly workspacePath: string;
      }>;
    };
    readonly conversations?: {
      assertSessionAttachable(): Promise<SessionAttachmentTarget>;
    };
    readonly repository?: MemoryConversationRepository;
    readonly lease?: TestWriterLease;
    readonly terminalFactory?: Pick<ManagedPseudoTerminalFactory, "attach">;
    readonly terminalHistory?: Pick<ManagedTerminalHistoryReader, "read">;
    readonly resourceOwner?: RuntimeResourceOwner;
  } = {}
) {
  const repository = overrides.repository ?? new MemoryConversationRepository();
  const lease = overrides.lease ?? new TestWriterLease();
  const tasks = new RuntimeTaskOwner();
  const coordinator = new LocalRuntimeCoordinator({
    commands: commandPort(),
    commandHandler: overrides.commandHandler ?? {
      requireAttachableSession: () =>
        Promise.resolve({
          conversationId: TEST_CONVERSATION_ID,
          sessionName: SESSION_NAME,
          workspacePath: "/work/project"
        })
    },
    conversations: overrides.conversations ?? {
      assertSessionAttachable: () => Promise.resolve(attachmentTarget())
    },
    tasks,
    terminalFactory: overrides.terminalFactory ?? { attach: fakePseudoTerminal },
    terminalHistory: overrides.terminalHistory ?? { read: () => Promise.resolve("") },
    repository,
    writerLease: lease,
    ...(overrides.resourceOwner === undefined ? {} : { resourceOwner: overrides.resourceOwner })
  });
  return { coordinator, lease, repository, tasks };
}

function attachmentTarget(
  runtimeId = "$42",
  serverPid = "100",
  serverStartedAt = "200"
): SessionAttachmentTarget {
  return {
    sessionName: SESSION_NAME,
    runtimeId,
    serverPid,
    serverStartedAt,
    ownership: OWNERSHIP
  };
}

class TestWriterLease implements WriterLease {
  public readonly databasePath = ":memory:";
  public closeCalls = 0;

  public constructor(private failuresRemaining = 0) {}

  public close(): void {
    this.closeCalls += 1;
    if (this.failuresRemaining > 0) {
      this.failuresRemaining -= 1;
      throw new Error("lease close failed");
    }
  }
}

function fakePseudoTerminal(): ManagedPseudoTerminal {
  const closeAndWait = vi.fn(() => Promise.resolve());
  return {
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    killAndWait: closeAndWait,
    closeAndWait,
    onData: () => ({ dispose: vi.fn() }),
    onExit: () => ({ dispose: vi.fn() })
  };
}

function commandPort(): AgentLabCommandPort {
  return {
    listConversations: () => Promise.resolve([]),
    inspectWorkspace: () => Promise.reject(new Error("not implemented")),
    prepareWorkspace: () => Promise.reject(new Error("not implemented")),
    discoverWorkspaceProviders: () => Promise.resolve([]),
    completeFolders: () => Promise.resolve([]),
    listProviders: () => Promise.resolve([]),
    createConversation: () => Promise.reject(new Error("not implemented")),
    deleteConversation: () => Promise.resolve(),
    listSessions: () => Promise.resolve([]),
    createWorker: () => Promise.reject(new Error("not implemented")),
    deleteWorker: () => Promise.resolve(),
    requireAttachableSession: () =>
      Promise.resolve({
        conversationId: TEST_CONVERSATION_ID,
        sessionName: SESSION_NAME,
        workspacePath: "/work/project"
      })
  };
}
