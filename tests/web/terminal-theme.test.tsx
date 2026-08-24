// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AgentSession } from "@orchestrator/contracts";

import { TerminalPane } from "../../apps/web/src/components/TerminalPane.js";
import { ThemeProvider } from "../../apps/web/src/theme/react-theme.js";
import { terminalThemes } from "../../apps/web/src/theme/theme-palette.js";
import { ThemeStore } from "../../apps/web/src/theme/theme-store.js";
import { TEST_CONVERSATION_ID } from "../helpers/fakes.js";

const mocks = vi.hoisted(() => ({
  observers: [] as { disconnect: ReturnType<typeof vi.fn>; emit: () => void }[],
  proposedDimensions: undefined as { cols: number; rows: number } | undefined,
  sockets: [] as {
    close: ReturnType<typeof vi.fn>;
    emitOpen: () => void;
    emitMessage: (data: string) => void;
    send: ReturnType<typeof vi.fn>;
    url: string;
  }[],
  terminals: [] as {
    dispose: ReturnType<typeof vi.fn>;
    inputDispose: ReturnType<typeof vi.fn>;
    options: Record<string, unknown>;
    resize: ReturnType<typeof vi.fn>;
    write: ReturnType<typeof vi.fn>;
  }[]
}));

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    proposeDimensions = vi.fn(() => mocks.proposedDimensions);
  }
}));

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    dispose = vi.fn();
    focus = vi.fn();
    inputDispose = vi.fn();
    loadAddon = vi.fn();
    onData = vi.fn(() => ({ dispose: this.inputDispose }));
    open = vi.fn();
    options: Record<string, unknown>;
    resize = vi.fn((cols: number, rows: number) => {
      this.cols = cols;
      this.rows = rows;
    });
    write = vi.fn();
    writeln = vi.fn();

    constructor(options: Record<string, unknown>) {
      this.options = options;
      mocks.terminals.push(this);
    }
  }
}));

class MockWebSocket {
  static readonly OPEN = 1;
  private messageListener: ((event: { readonly data: unknown }) => void) | null = null;
  private openListener: (() => void) | null = null;
  readonly addEventListener = vi.fn(
    (type: string, listener: (event: { readonly data: unknown }) => void) => {
      if (type === "message") this.messageListener = listener;
      if (type === "open")
        this.openListener = () => {
          listener({ data: undefined });
        };
    }
  );
  readonly close = vi.fn();
  readonly readyState = MockWebSocket.OPEN;
  readonly send = vi.fn();
  readonly url: string;

  constructor(url: string) {
    this.url = url;
    mocks.sockets.push(this);
  }

  emitMessage(data: string): void {
    this.messageListener?.({ data });
  }

  emitOpen(): void {
    this.openListener?.();
  }
}

class MockResizeObserver {
  disconnect = vi.fn();
  observe = vi.fn();
  unobserve = vi.fn();

  constructor(private readonly callback: ResizeObserverCallback) {
    mocks.observers.push(this);
  }

  emit(): void {
    this.callback([], this);
  }
}

const session: AgentSession = {
  name: `ao__${TEST_CONVERSATION_ID}__captain__codex`,
  conversationId: TEST_CONVERSATION_ID,
  role: "captain",
  provider: "codex",
  label: "Captain",
  status: "running",
  attached: false,
  startedAt: "2026-08-21T12:00:00.000Z"
};

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  mocks.observers.length = 0;
  mocks.proposedDimensions = undefined;
  mocks.sockets.length = 0;
  mocks.terminals.length = 0;
});

describe("TerminalPane theme integration", () => {
  it("updates the live xterm palette without recreating xterm or its WebSocket", () => {
    vi.stubGlobal("WebSocket", MockWebSocket);
    vi.stubGlobal("ResizeObserver", MockResizeObserver);
    const storage = {
      value: "light",
      read() {
        return this.value;
      },
      write(appearance: "system" | "light" | "dark") {
        this.value = appearance;
      }
    };
    const store = new ThemeStore(storage, {
      getTheme: () => "light",
      subscribe: () => () => undefined
    });

    render(
      <ThemeProvider store={store}>
        <TerminalPane conversationId={TEST_CONVERSATION_ID} session={session} />
      </ThemeProvider>
    );

    expect(mocks.terminals).toHaveLength(1);
    expect(mocks.sockets).toHaveLength(1);
    expect(mocks.terminals[0]?.options.theme).toEqual(terminalThemes.light);
    expect(mocks.terminals[0]?.options.minimumContrastRatio).toBe(4.5);

    act(() => {
      store.setAppearance("dark");
    });

    expect(mocks.terminals).toHaveLength(1);
    expect(mocks.sockets).toHaveLength(1);
    expect(mocks.terminals[0]?.options.theme).toEqual(terminalThemes.dark);
  });

  it("fully disposes one attachment before opening a replacement session", () => {
    vi.stubGlobal("WebSocket", MockWebSocket);
    vi.stubGlobal("ResizeObserver", MockResizeObserver);
    const store = new ThemeStore(
      { read: () => "light", write: () => undefined },
      { getTheme: () => "light", subscribe: () => () => undefined }
    );
    const nextConversationId = "7a23b1ce-672d-4f7a-a566-e94f4cd142a5";
    const nextSession: AgentSession = {
      ...session,
      conversationId: nextConversationId,
      name: `ao__${nextConversationId}__captain__claude`,
      provider: "claude"
    };
    const view = render(
      <ThemeProvider store={store}>
        <TerminalPane conversationId={TEST_CONVERSATION_ID} session={session} />
      </ThemeProvider>
    );
    const firstTerminal = mocks.terminals[0];
    const firstSocket = mocks.sockets[0];
    const firstObserver = mocks.observers[0];

    view.rerender(
      <ThemeProvider store={store}>
        <TerminalPane conversationId={nextConversationId} session={nextSession} />
      </ThemeProvider>
    );

    expect(firstTerminal?.inputDispose).toHaveBeenCalledOnce();
    expect(firstTerminal?.dispose).toHaveBeenCalledOnce();
    expect(firstSocket?.close).toHaveBeenCalledOnce();
    expect(firstObserver?.disconnect).toHaveBeenCalledOnce();
    expect(mocks.terminals).toHaveLength(2);
    expect(mocks.sockets).toHaveLength(2);
    expect(mocks.sockets[1]?.url).toContain(
      `/api/conversations/${nextConversationId}/sessions/${encodeURIComponent(nextSession.name)}/terminal`
    );
    firstSocket?.emitMessage(JSON.stringify({ type: "data", data: "stale output" }));
    expect(firstTerminal?.write).not.toHaveBeenCalled();
  });

  it("waits for measured dimensions and deduplicates resize messages", () => {
    vi.stubGlobal("WebSocket", MockWebSocket);
    vi.stubGlobal("ResizeObserver", MockResizeObserver);
    const store = new ThemeStore(
      { read: () => "light", write: () => undefined },
      { getTheme: () => "light", subscribe: () => () => undefined }
    );
    render(
      <ThemeProvider store={store}>
        <TerminalPane conversationId={TEST_CONVERSATION_ID} session={session} />
      </ThemeProvider>
    );

    act(() => {
      mocks.sockets[0]?.emitOpen();
    });
    expect(mocks.sockets[0]?.send).not.toHaveBeenCalled();

    mocks.proposedDimensions = { cols: 117, rows: 36 };
    act(() => {
      mocks.observers[0]?.emit();
      mocks.observers[0]?.emit();
    });
    expect(mocks.terminals[0]?.resize).toHaveBeenCalledOnce();
    expect(mocks.terminals[0]?.resize).toHaveBeenCalledWith(117, 36);
    expect(mocks.sockets[0]?.send).toHaveBeenCalledOnce();
    expect(mocks.sockets[0]?.send).toHaveBeenCalledWith(
      JSON.stringify({ type: "resize", cols: 117, rows: 36 })
    );
  });

  it("falls back to valid terminal dimensions when measurement stays unavailable", () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", MockWebSocket);
    vi.stubGlobal("ResizeObserver", MockResizeObserver);
    const store = new ThemeStore(
      { read: () => "light", write: () => undefined },
      { getTheme: () => "light", subscribe: () => () => undefined }
    );
    render(
      <ThemeProvider store={store}>
        <TerminalPane conversationId={TEST_CONVERSATION_ID} session={session} />
      </ThemeProvider>
    );

    act(() => {
      mocks.sockets[0]?.emitOpen();
      vi.advanceTimersByTime(500);
    });

    expect(mocks.sockets[0]?.send).toHaveBeenCalledWith(
      JSON.stringify({ type: "resize", cols: 80, rows: 24 })
    );
  });
});
