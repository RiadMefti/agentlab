import { z } from "zod";

import { modelIdSchema, providerIdSchema, reasoningIdSchema } from "./provider.js";
import { agentPromptSchema } from "./session.js";

export const conversationSchema = z
  .object({
    id: z.uuid(),
    title: z.string().min(1).max(80),
    provider: providerIdSchema,
    model: modelIdSchema.nullable(),
    reasoning: reasoningIdSchema.nullable(),
    captainSessionName: z.string().min(1),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime()
  })
  .strict();

export type Conversation = z.infer<typeof conversationSchema>;

export const createConversationInputSchema = z
  .object({
    prompt: agentPromptSchema,
    title: z.string().trim().min(1).max(80).optional(),
    provider: providerIdSchema,
    model: modelIdSchema.nullable().optional(),
    reasoning: reasoningIdSchema.nullable().optional()
  })
  .strict()
  .transform((input) => ({
    ...input,
    model: input.model ?? null,
    reasoning: input.reasoning ?? null
  }));

export type CreateConversationInput = z.infer<typeof createConversationInputSchema>;

export const conversationsResponseSchema = z
  .object({
    conversations: z.array(conversationSchema)
  })
  .strict();

export type ConversationsResponse = z.infer<typeof conversationsResponseSchema>;
