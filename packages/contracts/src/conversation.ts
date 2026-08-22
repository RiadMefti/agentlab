import { z } from "zod";

import { providerIdSchema, reasoningLevelSchema } from "./provider.js";

const modelSchema = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .refine((model) => !model.startsWith("-") && !model.includes("\0"), {
    message: "Model must be an identifier, not a command option."
  });

const promptSchema = z
  .string()
  .trim()
  .min(1)
  .max(20_000)
  .refine((prompt) => !prompt.includes("\0"), { message: "Prompt cannot contain null bytes." });

export const conversationSchema = z.object({
  id: z.uuid(),
  title: z.string().min(1).max(80),
  provider: providerIdSchema,
  model: z.string().min(1).max(120).nullable(),
  reasoning: reasoningLevelSchema,
  captainSessionName: z.string().min(1),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime()
});

export type Conversation = z.infer<typeof conversationSchema>;

export const createConversationInputSchema = z
  .object({
    prompt: promptSchema,
    title: z.string().trim().min(1).max(80).optional(),
    provider: providerIdSchema,
    model: modelSchema.optional(),
    reasoning: reasoningLevelSchema
  })
  .strict();

export type CreateConversationInput = z.infer<typeof createConversationInputSchema>;

export const conversationsResponseSchema = z.object({
  conversations: z.array(conversationSchema)
});

export type ConversationsResponse = z.infer<typeof conversationsResponseSchema>;
