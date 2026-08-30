import { describe, expect, it, vi } from "vitest";

import { SessionTerminalOwner } from "../../packages/runtime/src/application/session-terminal.js";
import type { SessionAttachmentTarget } from "../../packages/runtime/src/domain/session-runtime.js";
import {
  appendPendingOutput,
  BunTerminalFactory,
  closePtyResources,
  ConfirmedBunProcess,
  stringEnvironment,
  type PendingTerminalOutput
} from "../../packages/runtime/src/infrastructure/terminal/bun-terminal.js";

const emptyOutput: PendingTerminalOutput = {
  chunks: [],
  bytes: 0,
  overrun: false,
  overrunBytes: 0
};
const target: SessionAttachmentTarget = {
  sessionName: "agentlab__22222222-2222-4222-8222-222222222222__captain__codex",
  runtimeId: "$42",
  serverPid: "100",
  serverStartedAt: "200",
  ownership: { mode: "nonce", nonce: "33333333-3333-4333-8333-333333333333" }
};

describe("Bun terminal resource helpers", () => {
  it("discards the complete pending stream when its byte budget is exceeded", () => {
    const first = appendPendingOutput(emptyOutput, "abc", 5);
    const second = appendPendingOutput(first, "de", 5);
    const evicted = appendPendingOutput(second, "fg", 5);
    const oversized = appendPendingOutput(evicted, "0123456789", 5);
    const utf8 = appendPendingOutput(emptyOutput, "ééé", 5);

    expect(evicted).toEqual({ chunks: [], bytes: 0, overrun: true, overrunBytes: 7 });
    expect(oversized).toEqual(evicted);
    expect(utf8).toEqual({ chunks: [], bytes: 0, overrun: true, overrunBytes: 6 });
  });

  it("closes the terminal even when killing its subprocess throws", () => {
    const terminal = { closed: false, close: vi.fn() };
    const process = {
      kill: vi.fn(() => {
        throw new Error("already exited");
      })
    };

    expect(() => {
      closePtyResources(process, terminal);
    }).toThrow("already exited");
    expect(terminal.close).toHaveBeenCalledTimes(1);
  });

  it("never passes bootstrap diagnostics capabilities into spawned tmux clients", () => {
    expect(
      stringEnvironment({
        AGENTLAB_DIAGNOSTIC_LOG: "/private/tui.log",
        AGENTLAB_TUI_DIAGNOSTIC_CAPABILITY: "opaque-capability",
        AGENTLAB_TUI_RUNTIME: "single-use-token",
        PATH: "/usr/bin"
      })
    ).toEqual({ PATH: "/usr/bin" });
  });

  it("retains a spawned child when Bun fails to provide the requested PTY", async () => {
    let confirmExit!: (exitCode: number) => void;
    const exited = new Promise<number>((resolve) => {
      confirmExit = resolve;
    });
    const processHandle = { terminal: undefined, exited, kill: vi.fn() };
    const spawn = (() => processHandle) as unknown as typeof Bun.spawn;
    const owner = new SessionTerminalOwner();

    expect(() =>
      new BunTerminalFactory(undefined, spawn).attach(
        target,
        "/work/project",
        { columns: 80, rows: 24 },
        owner
      )
    ).toThrow("did not create a terminal");

    let closed = false;
    const closing = owner.closeAll().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    confirmExit(0);
    await closing;
    expect(processHandle.kill).toHaveBeenCalled();
  });

  it("does not translate a rejected Bun exit promise into confirmed process exit", async () => {
    const rejectedExit = new Error("Bun lost process-exit observation");
    const onExit = vi.fn();
    const processHandle = {
      exited: Promise.reject(rejectedExit),
      kill: vi.fn()
    };
    const lifecycle = new ConfirmedBunProcess(processHandle);
    lifecycle.onExit(onExit);

    await expect(lifecycle.killAndWait()).rejects.toBe(rejectedExit);
    await expect(lifecycle.closeAndWait()).rejects.toBe(rejectedExit);
    expect(onExit).not.toHaveBeenCalled();
    expect(processHandle.kill).toHaveBeenCalledTimes(2);
  });

  it("finalizes and releases a PTY when a data listener throws during decoder flush", async () => {
    const fixture = bunTerminalFixture();
    const owner = new SessionTerminalOwner();
    const terminal = new BunTerminalFactory(undefined, fixture.spawn).attach(
      target,
      "/work/project",
      { columns: 80, rows: 24 },
      owner
    );
    const exit = vi.fn();
    terminal.onData(() => {
      throw new Error("presentation failed");
    });
    terminal.onExit(exit);
    fixture.emitBytes(new Uint8Array([0xe2, 0x82]));

    fixture.confirmExit(0);
    await fixture.exited;
    await Promise.resolve();

    expect(fixture.closeTerminal).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith({ exitCode: 0 });
    await expect(owner.closeAll()).resolves.toBeUndefined();
  });

  it("retains natural-exit ownership until a failed terminal close can be retried", async () => {
    let closeAttempts = 0;
    const fixture = bunTerminalFixture((rawTerminal) => {
      closeAttempts += 1;
      if (closeAttempts === 1) throw new Error("terminal close ambiguous");
      rawTerminal.closed = true;
    });
    const owner = new SessionTerminalOwner();
    const terminal = new BunTerminalFactory(undefined, fixture.spawn).attach(
      target,
      "/work/project",
      { columns: 80, rows: 24 },
      owner
    );
    const exit = vi.fn();
    terminal.onExit(exit);

    fixture.confirmExit(0);
    await fixture.exited;
    await Promise.resolve();
    expect(exit).not.toHaveBeenCalled();

    await expect(owner.closeAll()).resolves.toBeUndefined();
    expect(closeAttempts).toBe(2);
    expect(exit).toHaveBeenCalledWith({ exitCode: 0 });
  });
});

function bunTerminalFixture(close?: (terminal: { closed: boolean }) => void): {
  readonly terminal: { closed: boolean };
  readonly spawn: typeof Bun.spawn;
  readonly exited: Promise<number>;
  readonly confirmExit: (exitCode: number) => void;
  readonly emitBytes: (data: Uint8Array) => void;
  readonly closeTerminal: ReturnType<typeof vi.fn>;
} {
  let confirmExit!: (exitCode: number) => void;
  const exited = new Promise<number>((resolve) => {
    confirmExit = resolve;
  });
  const terminal = {
    closed: false,
    close: vi.fn(),
    write: vi.fn(),
    resize: vi.fn()
  };
  const closeTerminal = vi.fn(() => {
    if (close === undefined) terminal.closed = true;
    else close(terminal);
  });
  terminal.close = closeTerminal;
  let emitBytes: ((data: Uint8Array) => void) | null = null;
  const processHandle = { terminal, exited, kill: vi.fn() };
  const spawn = ((_command: unknown, options: unknown) => {
    const terminalOptions = (
      options as {
        readonly terminal: {
          readonly data: (terminal: unknown, data: Uint8Array) => void;
        };
      }
    ).terminal;
    emitBytes = (data) => {
      terminalOptions.data(terminal, data);
    };
    return processHandle;
  }) as unknown as typeof Bun.spawn;
  return {
    terminal,
    spawn,
    exited,
    confirmExit,
    emitBytes(data) {
      if (emitBytes === null) throw new Error("Terminal data callback was not installed.");
      emitBytes(data);
    },
    closeTerminal
  };
}
