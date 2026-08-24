// @vitest-environment jsdom

import type { PropsWithChildren } from "react";

import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AgentSession, Conversation } from "@orchestrator/contracts";

import {
  conversationQuery,
  sessionQuery,
  useCreateConversation,
  useCreateWorker,
  useDeleteConversation,
  useDeleteWorker
} from "../../apps/web/src/api/queries.js";
import { TEST_CONVERSATION_ID } from "../helpers/fakes.js";

const api = vi.hoisted(() => ({
  createConversation: vi.fn(),
  createWorker: vi.fn(),
  deleteConversation: vi.fn(),
  deleteWorker: vi.fn(),
  getConversations: vi.fn(),
  getProviders: vi.fn(),
  getSessions: vi.fn()
}));

vi.mock("../../apps/web/src/api/client.js", () => api);

const existingConversation = conversation(TEST_CONVERSATION_ID, "Existing");
const createdConversation = conversation("7a23b1ce-672d-4f7a-a566-e94f4cd142a5", "Created");

afterEach(() => {
  vi.clearAllMocks();
});

describe("mutation cache reconciliation", () => {
  it("keeps successful conversation creates and deletes when refresh fails", async () => {
    api.getConversations.mockResolvedValueOnce({ conversations: [existingConversation] });
    api.createConversation.mockResolvedValueOnce(createdConversation);
    api.deleteConversation.mockResolvedValueOnce(undefined);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } }
    });
    const view = renderHook(
      () => ({
        conversations: useQuery(conversationQuery),
        create: useCreateConversation(),
        remove: useDeleteConversation()
      }),
      { wrapper: wrapper(queryClient) }
    );
    await waitFor(() => {
      expect(view.result.current.conversations.data?.conversations).toEqual([existingConversation]);
    });
    api.getConversations.mockRejectedValue(new Error("temporary refresh failure"));

    await act(async () => {
      await view.result.current.create.mutateAsync({
        prompt: "new work",
        provider: "codex",
        model: null,
        reasoning: null
      });
    });
    await waitFor(() => {
      expect(view.result.current.conversations.data?.conversations).toEqual([
        createdConversation,
        existingConversation
      ]);
    });

    await act(async () => {
      await view.result.current.remove.mutateAsync(existingConversation.id);
    });
    await waitFor(() => {
      expect(view.result.current.conversations.data?.conversations).toEqual([createdConversation]);
    });

    queryClient.clear();
  });

  it("keeps successful worker creates and deletes when refresh fails", async () => {
    const captain = agentSession(existingConversation, "captain", "Captain");
    const workerName = `ao__${existingConversation.id}__worker__claude__tests`;
    api.getSessions.mockResolvedValueOnce({ sessions: [captain] });
    api.createWorker.mockResolvedValueOnce({ sessionName: workerName });
    api.deleteWorker.mockResolvedValueOnce(undefined);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } }
    });
    const view = renderHook(
      () => ({
        sessions: useQuery(sessionQuery(existingConversation.id)),
        create: useCreateWorker(),
        remove: useDeleteWorker()
      }),
      { wrapper: wrapper(queryClient) }
    );
    await waitFor(() => {
      expect(view.result.current.sessions.data?.sessions).toEqual([captain]);
    });
    api.getSessions.mockRejectedValue(new Error("temporary refresh failure"));

    await act(async () => {
      await view.result.current.create.mutateAsync({
        conversationId: existingConversation.id,
        input: { provider: "claude", label: "Tests", prompt: "review it" }
      });
    });
    await waitFor(() => {
      expect(view.result.current.sessions.data?.sessions).toEqual([
        captain,
        {
          name: workerName,
          conversationId: existingConversation.id,
          role: "worker",
          provider: "claude",
          label: "Tests",
          status: "running",
          attached: false,
          startedAt: null
        }
      ]);
    });

    await act(async () => {
      await view.result.current.remove.mutateAsync({
        conversationId: existingConversation.id,
        sessionName: workerName
      });
    });
    await waitFor(() => {
      expect(view.result.current.sessions.data?.sessions).toEqual([captain]);
    });

    queryClient.clear();
  });
});

function wrapper(queryClient: QueryClient) {
  return function QueryWrapper({ children }: PropsWithChildren) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

function conversation(id: string, title: string): Conversation {
  return {
    id,
    title,
    provider: "codex",
    model: null,
    reasoning: null,
    captainSessionName: `ao__${id}__captain__codex`,
    createdAt: "2026-08-21T12:00:00.000Z",
    updatedAt: "2026-08-21T12:00:00.000Z"
  };
}

function agentSession(
  owner: Conversation,
  role: "captain" | "worker",
  label: string
): AgentSession {
  return {
    name: owner.captainSessionName,
    conversationId: owner.id,
    role,
    provider: owner.provider,
    label,
    status: "running",
    attached: false,
    startedAt: "2026-08-21T12:00:00.000Z"
  };
}
