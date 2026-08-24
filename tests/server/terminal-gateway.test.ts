import { describe, expect, it, vi } from "vitest";

import type { TerminalServerMessage } from "@orchestrator/contracts";

import type { BrowserTerminalSocket } from "../../apps/server/src/application/browser-terminal.js";
import { TerminalGateway } from "../../apps/server/src/infrastructure/terminal/terminal-gateway.js";
import type {
  Disposable,
  PseudoTerminal,
  PseudoTerminalFactory
} from "../../apps/server/src/infrastructure/terminal/pseudo-terminal.js";
import type { TerminalHistoryReader } from "../../apps/server/src/infrastructure/terminal/terminal-history.js";
import { buildCaptainSessionName } from "../../apps/server/src/domain/agent-session-name.js";
import { TEST_CONVERSATION_ID } from "../helpers/fakes.js";

class FakePseudoTerminal implements PseudoTerminal {
  public readonly write = vi.fn<(data: string) => void>();
  public readonly resize = vi.fn<(columns: number, rows: number) => void>();
  public readonly kill = vi.fn<() => void>();
  private dataListener: ((data: string) => void) | null = null;
  private exitListener: ((event: { exitCode: number }) => void) | null = null;

  public onData(listener: (data: string) => void): Disposable {
    this.dataListener = listener;
    return { dispose: vi.fn() };
  }

  public onExit(listener: (event: { exitCode: number }) => void): Disposable {
    this.exitListener = listener;
    return { dispose: vi.fn() };
  }

  public emitData(data: string): void {
    this.dataListener?.(data);
  }

  public emitExit(exitCode: number): void {
    this.exitListener?.({ exitCode });
  }
}

class FakeSocket implements BrowserTerminalSocket {
  public readyState = 1;
  public readonly sent: string[] = [];
  public readonly close = vi.fn<(code?: number, reason?: string) => void>();
  private messageListener: ((data: unknown) => void) | null = null;
  private readonly endListeners: (() => void)[] = [];

  public send(data: string): void {
    this.sent.push(data);
  }

  public on(event: "message", listener: (data: unknown) => void): void;
  public on(event: "close" | "error", listener: () => void): void;
  public on(
    event: "message" | "close" | "error",
    listener: ((data: unknown) => void) | (() => void)
  ): void {
    if (event === "message") {
      this.messageListener = (data) => {
        listener(data);
      };
      return;
    }
    this.endListeners.push(() => {
      listener(undefined);
    });
  }

  public emitMessage(message: unknown): void {
    this.messageListener?.(JSON.stringify(message));
  }

  public emitClose(): void {
    for (const listener of this.endListeners) listener();
  }
}

describe("TerminalGateway", () => {
  it("replays history, then bridges input, resize, output, and disconnect", async () => {
    const terminal = new FakePseudoTerminal();
    const attach = vi.fn(() => terminal);
    const factory: PseudoTerminalFactory = { attach };
    const history: TerminalHistoryReader = {
      read: vi.fn(() => Promise.resolve("previous\noutput"))
    };
    const gateway = new TerminalGateway(factory, history);
    const socket = new FakeSocket();
    const name = buildCaptainSessionName(TEST_CONVERSATION_ID, "codex");

    gateway.attach(socket, name, "/work/project");
    socket.emitMessage({ type: "input", data: "hello\r" });
    socket.emitMessage({ type: "resize", cols: 90, rows: 30 });
    await vi.waitFor(() => {
      expect(attach).toHaveBeenCalled();
    });
    terminal.emitData("world");

    expect(terminal.write).toHaveBeenCalledWith("hello\r");
    expect(attach).toHaveBeenCalledWith(name, "/work/project", {
      columns: 90,
      rows: 30
    });
    expect(terminal.resize).not.toHaveBeenCalled();
    expect(decoded(socket.sent)).toContainEqual({
      type: "data",
      data: "previous\r\noutput\r\n"
    });
    expect(decoded(socket.sent)).toContainEqual({ type: "data", data: "world" });

    socket.emitClose();
    socket.emitClose();
    expect(terminal.kill).toHaveBeenCalledTimes(1);
  });

  it("reports process exit and rejects unmanaged session names", async () => {
    const terminal = new FakePseudoTerminal();
    const attach = vi.fn(() => terminal);
    const factory: PseudoTerminalFactory = { attach };
    const gateway = new TerminalGateway(factory, {
      read: () => Promise.resolve("")
    });
    const socket = new FakeSocket();
    gateway.attach(
      socket,
      buildCaptainSessionName(TEST_CONVERSATION_ID, "claude"),
      "/work/project"
    );
    socket.emitMessage({ type: "resize", cols: 80, rows: 24 });
    await vi.waitFor(() => {
      expect(attach).toHaveBeenCalled();
    });

    terminal.emitExit(7);
    expect(decoded(socket.sent)).toContainEqual({ type: "exit", exitCode: 7 });
    expect(socket.close).toHaveBeenCalledWith(1000, "Terminal exited");

    const invalidSocket = new FakeSocket();
    gateway.attach(invalidSocket, "unmanaged", "/work/project");
    expect(decoded(invalidSocket.sent)).toContainEqual({
      type: "error",
      message: "Invalid session name."
    });
    expect(invalidSocket.close).toHaveBeenCalledWith(1008, "Invalid session");
  });

  it("bounds messages buffered while history is loading", () => {
    const history = new Promise<string>(() => undefined);
    const gateway = new TerminalGateway(
      { attach: () => new FakePseudoTerminal() },
      { read: () => history }
    );
    const socket = new FakeSocket();

    gateway.attach(socket, buildCaptainSessionName(TEST_CONVERSATION_ID, "codex"), "/work/project");
    for (let index = 0; index <= 1_024; index += 1) {
      socket.emitMessage({ type: "input", data: "" });
    }

    expect(decoded(socket.sent)).toContainEqual({
      type: "error",
      message: "Too much input before attachment."
    });
    expect(socket.close).toHaveBeenCalledWith(1009, "Input buffer exceeded");
  });

  it("waits for browser dimensions instead of attaching and resizing tmux twice", async () => {
    const terminal = new FakePseudoTerminal();
    const attach = vi.fn(() => terminal);
    const gateway = new TerminalGateway({ attach }, { read: () => Promise.resolve("ready") });
    const socket = new FakeSocket();
    const name = buildCaptainSessionName(TEST_CONVERSATION_ID, "codex");

    gateway.attach(socket, name, "/work/project");
    await Promise.resolve();
    await Promise.resolve();
    expect(attach).not.toHaveBeenCalled();

    socket.emitMessage({ type: "resize", cols: 132, rows: 47 });
    await vi.waitFor(() => {
      expect(attach).toHaveBeenCalledWith(name, "/work/project", {
        columns: 132,
        rows: 47
      });
    });
    expect(terminal.resize).not.toHaveBeenCalled();
  });

  it("uses the latest browser dimensions received while history is loading", async () => {
    const terminal = new FakePseudoTerminal();
    const attach = vi.fn(() => terminal);
    let finishHistory: (history: string) => void = () => undefined;
    const history = new Promise<string>((resolve) => {
      finishHistory = resolve;
    });
    const gateway = new TerminalGateway({ attach }, { read: () => history });
    const socket = new FakeSocket();
    const name = buildCaptainSessionName(TEST_CONVERSATION_ID, "codex");

    gateway.attach(socket, name, "/work/project");
    socket.emitMessage({ type: "resize", cols: 80, rows: 24 });
    socket.emitMessage({ type: "resize", cols: 132, rows: 47 });
    expect(attach).not.toHaveBeenCalled();

    finishHistory("");
    await vi.waitFor(() => {
      expect(attach).toHaveBeenCalledWith(name, "/work/project", {
        columns: 132,
        rows: 47
      });
    });
    expect(terminal.resize).not.toHaveBeenCalled();
  });
});

function decoded(messages: readonly string[]): TerminalServerMessage[] {
  return messages.map((message) => JSON.parse(message) as TerminalServerMessage);
}
