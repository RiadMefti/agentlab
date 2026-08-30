import { describe, expect, it, vi } from "vitest";

import type { SessionAttachmentTarget } from "../../packages/runtime/src/domain/session-runtime.js";
import type { PseudoTerminal } from "../../packages/runtime/src/domain/terminal.js";
import { SessionTerminalOwner } from "../../packages/runtime/src/application/session-terminal.js";
import {
  adaptLegacyTerminalFactory,
  adaptLegacyTerminalHistoryReader
} from "../../packages/runtime/src/infrastructure/terminal/legacy-terminal-adapter.js";

const TARGET: SessionAttachmentTarget = {
  sessionName: "agentlab__22222222-2222-4222-8222-222222222222__captain__codex",
  runtimeId: "$42",
  serverPid: "100",
  serverStartedAt: "200",
  ownership: { mode: "nonce", nonce: "33333333-3333-4333-8333-333333333333" }
};
const LEGACY_TARGET: SessionAttachmentTarget = {
  ...TARGET,
  ownership: { mode: "legacy-name" }
};

describe("legacy terminal adapters", () => {
  it("preserves the public name-based factory and waits for an exit event", async () => {
    const fixture = legacyTerminal();
    const attach = vi.fn(() => fixture.terminal);
    const managed = adaptLegacyTerminalFactory({ attach }).attach(
      LEGACY_TARGET,
      "/work/project",
      { columns: 100, rows: 30 },
      new SessionTerminalOwner()
    );

    let settled = false;
    const closing = managed.killAndWait().then(() => {
      settled = true;
    });
    await Promise.resolve();

    expect(attach).toHaveBeenCalledWith(LEGACY_TARGET.sessionName, "/work/project", {
      columns: 100,
      rows: 30
    });
    expect(fixture.kill).toHaveBeenCalledOnce();
    expect(settled).toBe(false);
    fixture.exit(0);
    await closing;
    expect(settled).toBe(true);
  });

  it("retains an ambiguous custom terminal for retry instead of treating kill as exit", async () => {
    const fixture = legacyTerminal();
    const managed = adaptLegacyTerminalFactory(
      { attach: () => fixture.terminal },
      { exitConfirmationTimeoutMs: 5 }
    ).attach(LEGACY_TARGET, "/work/project", { columns: 80, rows: 24 }, new SessionTerminalOwner());

    await expect(managed.killAndWait()).rejects.toThrow("did not confirm process exit");
    const retry = managed.killAndWait();
    await Promise.resolve();
    fixture.exit(0);

    await expect(retry).resolves.toBeUndefined();
    expect(fixture.kill).toHaveBeenCalledTimes(2);
  });

  it("maps the legacy history reader to the proven session name", async () => {
    const read = vi.fn(() => Promise.resolve("history"));

    await expect(adaptLegacyTerminalHistoryReader({ read }).read(LEGACY_TARGET)).resolves.toBe(
      "history"
    );
    expect(read).toHaveBeenCalledWith(LEGACY_TARGET.sessionName);
  });

  it("rejects name-only seams before they can target a nonce-owned replacement", async () => {
    const attach = vi.fn(() => legacyTerminal().terminal);
    const read = vi.fn(() => Promise.resolve("unsafe history"));

    expect(() =>
      adaptLegacyTerminalFactory({ attach }).attach(
        TARGET,
        "/work/project",
        { columns: 80, rows: 24 },
        new SessionTerminalOwner()
      )
    ).toThrow("name-only terminal factory");
    await expect(adaptLegacyTerminalHistoryReader({ read }).read(TARGET)).rejects.toThrow(
      "name-only history reader"
    );
    expect(attach).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  });

  it("buffers the raw exit event and replays its real code to later listeners", async () => {
    const fixture = legacyTerminal();
    const managed = adaptLegacyTerminalFactory({ attach: () => fixture.terminal }).attach(
      LEGACY_TARGET,
      "/work/project",
      { columns: 80, rows: 24 },
      new SessionTerminalOwner()
    );

    const closing = managed.killAndWait();
    fixture.exit(23);
    await closing;
    const observed: number[] = [];
    managed.onExit(({ exitCode }) => observed.push(exitCode));

    expect(observed).toEqual([23]);
  });

  it("registers the raw terminal before fallible exit observation and permits cleanup retry", async () => {
    let observationAttempts = 0;
    let exitListener: ((event: { exitCode: number }) => void) | null = null;
    const terminal: PseudoTerminal = {
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(() => exitListener?.({ exitCode: 0 })),
      onData: () => ({ dispose: vi.fn() }),
      onExit(listener) {
        observationAttempts += 1;
        if (observationAttempts === 1) throw new Error("exit observation failed");
        exitListener = listener;
        return { dispose: () => undefined };
      }
    };
    const owner = new SessionTerminalOwner();

    expect(() =>
      adaptLegacyTerminalFactory({ attach: () => terminal }).attach(
        LEGACY_TARGET,
        "/work/project",
        { columns: 80, rows: 24 },
        owner
      )
    ).toThrow("exit observation failed");

    await expect(owner.closeAll()).resolves.toBeUndefined();
    expect(observationAttempts).toBe(2);
    expect(terminal.kill).toHaveBeenCalledOnce();
  });
});

function legacyTerminal() {
  const exitListeners = new Set<(event: { exitCode: number }) => void>();
  const kill = vi.fn();
  const terminal: PseudoTerminal = {
    write: vi.fn(),
    resize: vi.fn(),
    kill,
    onData: () => ({ dispose: vi.fn() }),
    onExit(listener) {
      exitListeners.add(listener);
      return { dispose: () => exitListeners.delete(listener) };
    }
  };
  return {
    terminal,
    kill,
    exit(exitCode: number) {
      for (const listener of exitListeners) listener({ exitCode });
    }
  };
}
