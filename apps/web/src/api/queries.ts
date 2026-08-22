import { queryOptions, skipToken, useMutation, useQueryClient } from "@tanstack/react-query";

import type { CreateConversationInput } from "@orchestrator/contracts";

import { createConversation, getConversations, getProviders, getSessions } from "./client.js";

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
