// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { act, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AgentSession, Conversation } from "@orchestrator/contracts";

import { App } from "../../apps/web/src/App.js";
import { ThemeProvider } from "../../apps/web/src/theme/react-theme.js";
import { ThemeStore } from "../../apps/web/src/theme/theme-store.js";
import { TEST_CONVERSATION_ID } from "../helpers/fakes.js";

vi.mock("../../apps/web/src/components/TerminalPane.js", () => ({
  default: ({
    conversationId,
    session
  }: {
    readonly conversationId: string;
    readonly session: AgentSession;
  }) => <div data-testid="terminal">{`${conversationId}:${session.name}`}</div>
}));

const secondConversationId = "7a23b1ce-672d-4f7a-a566-e94f4cd142a5";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("conversation switching", () => {
  it("shows an honest loading state, switches to the right tmux session, and remembers agents", async () => {
    const first = conversation(TEST_CONVERSATION_ID, "First", "codex");
    const second = conversation(secondConversationId, "Second", "claude");
    const firstCaptain = session(first, "captain", "Captain");
    const firstWorker = session(first, "worker", "Tests", `ao__${first.id}__worker__codex__tests`);
    const secondCaptain = session(second, "captain", "Captain");
    const secondSessions = deferred<Response>();

    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request) => {
        const path =
          typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        if (path === "/api/providers") return Promise.resolve(jsonResponse({ providers: [] }));
        if (path === "/api/conversations") {
          return Promise.resolve(jsonResponse({ conversations: [first, second] }));
        }
        if (path.includes(encodeURIComponent(first.id))) {
          return Promise.resolve(jsonResponse({ sessions: [firstCaptain, firstWorker] }));
        }
        if (path.includes(encodeURIComponent(second.id))) return secondSessions.promise;
        throw new Error(`Unexpected request: ${path}`);
      })
    );

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } }
    });
    const theme = new ThemeStore(
      { read: () => "light", write: () => undefined },
      { getTheme: () => "light", subscribe: () => () => undefined }
    );
    render(
      <QueryClientProvider client={queryClient}>
        <ThemeProvider store={theme}>
          <App />
        </ThemeProvider>
      </QueryClientProvider>
    );

    expect(await screen.findByTestId("terminal")).toHaveTextContent(firstCaptain.name);
    fireEvent.click(screen.getByRole("button", { name: "Tests" }));
    expect(await screen.findByTestId("terminal")).toHaveTextContent(firstWorker.name);

    fireEvent.click(screen.getByRole("button", { name: "Second" }));
    expect(screen.getByText("Loading conversation…")).toBeInTheDocument();
    expect(screen.queryByTestId("terminal")).not.toBeInTheDocument();

    await act(async () => {
      secondSessions.resolve(jsonResponse({ sessions: [secondCaptain] }));
      await secondSessions.promise;
    });
    expect(await screen.findByTestId("terminal")).toHaveTextContent(secondCaptain.name);

    fireEvent.click(screen.getByRole("button", { name: "First" }));
    expect(await screen.findByTestId("terminal")).toHaveTextContent(firstWorker.name);

    queryClient.clear();
    theme.dispose();
  });

  it("keeps the same live terminal through failed background refetches", async () => {
    const owner = conversation(TEST_CONVERSATION_ID, "Stable", "codex");
    const captain = session(owner, "captain", "Captain");
    let failConversations = false;
    let failSessions = false;

    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request) => {
        const path =
          typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        if (path === "/api/providers") return Promise.resolve(jsonResponse({ providers: [] }));
        if (path === "/api/conversations") {
          return failConversations
            ? Promise.reject(new Error("temporary conversation failure"))
            : Promise.resolve(jsonResponse({ conversations: [owner] }));
        }
        if (path.includes(encodeURIComponent(owner.id))) {
          return failSessions
            ? Promise.reject(new Error("temporary session failure"))
            : Promise.resolve(jsonResponse({ sessions: [captain] }));
        }
        throw new Error(`Unexpected request: ${path}`);
      })
    );

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } }
    });
    const theme = new ThemeStore(
      { read: () => "light", write: () => undefined },
      { getTheme: () => "light", subscribe: () => () => undefined }
    );
    render(
      <QueryClientProvider client={queryClient}>
        <ThemeProvider store={theme}>
          <App />
        </ThemeProvider>
      </QueryClientProvider>
    );
    const terminal = await screen.findByTestId("terminal");

    failSessions = true;
    await act(async () => {
      await queryClient.refetchQueries({
        queryKey: ["conversations", owner.id, "sessions"],
        exact: true
      });
    });
    expect(screen.getByTestId("terminal")).toBe(terminal);

    failSessions = false;
    failConversations = true;
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: ["conversations"], exact: true });
    });
    expect(screen.getByTestId("terminal")).toBe(terminal);

    queryClient.clear();
    theme.dispose();
  });
});

function conversation(id: string, title: string, provider: "codex" | "claude"): Conversation {
  return {
    id,
    title,
    provider,
    model: null,
    reasoning: null,
    captainSessionName: `ao__${id}__captain__${provider}`,
    createdAt: "2026-08-21T12:00:00.000Z",
    updatedAt: "2026-08-21T12:00:00.000Z"
  };
}

function session(
  owner: Conversation,
  role: "captain" | "worker",
  label: string,
  name = owner.captainSessionName
): AgentSession {
  return {
    name,
    conversationId: owner.id,
    role,
    provider: owner.provider,
    label,
    status: "running",
    attached: false,
    startedAt: "2026-08-21T12:00:00.000Z"
  };
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let settle: ((value: T) => void) | null = null;
  const promise = new Promise<T>((resolvePromise) => {
    settle = resolvePromise;
  });
  return {
    promise,
    resolve(value) {
      if (settle === null) throw new Error("Deferred promise is not initialized.");
      settle(value);
    }
  };
}

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    json: () => Promise.resolve(body)
  } as Response;
}
