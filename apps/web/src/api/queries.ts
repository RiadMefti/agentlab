import { queryOptions, skipToken, useMutation, useQueryClient } from "@tanstack/react-query";

import type { CreateConversationInput, CreateWorkerInput } from "@orchestrator/contracts";

import {
  createConversation,
  createWorker,
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
    onSuccess: async () => {
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
    onSuccess: async (_response, { conversationId }) => {
      await queryClient.invalidateQueries({
        queryKey: ["conversations", conversationId, "sessions"]
      });
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
    onSuccess: async (_response, { conversationId }) => {
      await queryClient.invalidateQueries({
        queryKey: ["conversations", conversationId, "sessions"]
      });
    }
  });
}
