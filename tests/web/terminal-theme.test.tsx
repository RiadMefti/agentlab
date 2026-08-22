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
  sockets: [] as { close: ReturnType<typeof vi.fn> }[],
  terminals: [] as {
    dispose: ReturnType<typeof vi.fn>;
    options: Record<string, unknown>;
  }[]
}));

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit = vi.fn();
  }
}));

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    dispose = vi.fn();
    focus = vi.fn();
    loadAddon = vi.fn();
    onData = vi.fn().mockReturnValue({ dispose: vi.fn() });
    open = vi.fn();
    options: Record<string, unknown>;
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
  readonly addEventListener = vi.fn();
  readonly close = vi.fn();
  readonly readyState = MockWebSocket.OPEN;
  readonly send = vi.fn();

  constructor(url: string) {
    void url;
    mocks.sockets.push(this);
  }
}

class MockResizeObserver {
  disconnect = vi.fn();
  observe = vi.fn();
  unobserve = vi.fn();
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
  vi.unstubAllGlobals();
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
});
