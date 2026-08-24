import { queryOptions, skipToken, useMutation, useQueryClient } from "@tanstack/react-query";

import type {
  AgentSession,
  ConversationsResponse,
  CreateConversationInput,
  CreateWorkerInput,
  SessionsResponse
} from "@orchestrator/contracts";

import {
  createConversation,
  createWorker,
  deleteConversation,
  deleteWorker,
  getConversations,
  getProviders,
  getSessions
} from "./client.js";

export const providerQuery = queryOptions({
  queryKey: ["providers"],
  queryFn: getProviders,
  staleTime: 5_000
});

export const conversationQuery = queryOptions({
  queryKey: ["conversations"],
  queryFn: getConversations
});

export function sessionQuery(conversationId: string | null) {
  return queryOptions({
    queryKey: ["conversations", conversationId, "sessions"],
    queryFn: conversationId === null ? skipToken : () => getSessions(conversationId),
    refetchInterval: 2_000
  });
}

export function useCreateConversation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateConversationInput) => createConversation(input),
    onSuccess: async (conversation) => {
      queryClient.setQueryData<ConversationsResponse>(["conversations"], (current) => ({
        conversations: [
          conversation,
          ...(current?.conversations ?? []).filter(({ id }) => id !== conversation.id)
        ]
      }));
      await queryClient.invalidateQueries({ queryKey: ["conversations"] });
    }
  });
}

export function useCreateWorker() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      conversationId,
      input
    }: {
      readonly conversationId: string;
      readonly input: CreateWorkerInput;
    }) => createWorker(conversationId, input),
    onSuccess: async ({ sessionName }, { conversationId, input }) => {
      const createdSession: AgentSession = {
        name: sessionName,
        conversationId,
        role: "worker",
        provider: input.provider,
        label: input.label,
        status: "running",
        attached: false,
        startedAt: null
      };
      queryClient.setQueryData<SessionsResponse>(
        ["conversations", conversationId, "sessions"],
        (current) => ({
          sessions: [
            ...(current?.sessions ?? []).filter(({ name }) => name !== sessionName),
            createdSession
          ]
        })
      );
      await queryClient.invalidateQueries({
        queryKey: ["conversations", conversationId, "sessions"]
      });
    }
  });
}

export function useDeleteConversation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (conversationId: string) => deleteConversation(conversationId),
    onSuccess: async (_response, conversationId) => {
      queryClient.removeQueries({
        queryKey: ["conversations", conversationId, "sessions"],
        exact: true
      });
      queryClient.setQueryData<ConversationsResponse>(["conversations"], (current) =>
        current === undefined
          ? undefined
          : {
              conversations: current.conversations.filter(({ id }) => id !== conversationId)
            }
      );
      await queryClient.invalidateQueries({ queryKey: ["conversations"], exact: true });
    }
  });
}

export function useDeleteWorker() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      conversationId,
      sessionName
    }: {
      readonly conversationId: string;
      readonly sessionName: string;
    }) => deleteWorker(conversationId, sessionName),
    onSuccess: async (_response, { conversationId, sessionName }) => {
      queryClient.setQueryData<SessionsResponse>(
        ["conversations", conversationId, "sessions"],
        (current) =>
          current === undefined
            ? undefined
            : { sessions: current.sessions.filter(({ name }) => name !== sessionName) }
      );
      await queryClient.invalidateQueries({
        queryKey: ["conversations", conversationId, "sessions"]
      });
    }
  });
}
