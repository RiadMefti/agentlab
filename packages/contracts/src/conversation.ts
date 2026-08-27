import { z } from "zod";

import { modelIdSchema, providerIdSchema, reasoningIdSchema } from "./provider.js";
import { agentPromptSchema } from "./session.js";

export const projectNameSchema = z.string().trim().min(1).max(80);

export const workspacePathInputSchema = z
  .string()
  .trim()
  .min(1)
  .max(4_096)
  .refine((path) => !path.includes("\0"), { message: "Folder path cannot contain null bytes." });

export const folderCompletionInputSchema = z
  .object({
    path: z
      .string()
      .max(4_096)
      .refine((path) => !path.includes("\0"), {
        message: "Folder path cannot contain null bytes."
      }),
    limit: z.number().int().min(1).max(6).default(6)
  })
  .strict();

export type FolderCompletionInput = z.infer<typeof folderCompletionInputSchema>;

export const folderSuggestionSchema = z
  .object({
    value: z.string().min(1).max(4_096),
    label: z.string().min(1).max(4_100),
    symlink: z.boolean()
  })
  .strict();

export type FolderSuggestion = z.infer<typeof folderSuggestionSchema>;

export const conversationSchema = z
  .object({
    id: z.uuid(),
    title: z.string().min(1).max(80),
    workspacePath: workspacePathInputSchema.nullable(),
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
    title: projectNameSchema,
    workspacePath: workspacePathInputSchema,
    prompt: agentPromptSchema.nullable().optional(),
    provider: providerIdSchema,
    model: modelIdSchema.nullable().optional(),
    reasoning: reasoningIdSchema.nullable().optional()
  })
  .strict()
  .transform((input) => ({
    ...input,
    prompt: input.prompt ?? null,
    model: input.model ?? null,
    reasoning: input.reasoning ?? null
  }));

export type CreateConversationInput = z.infer<typeof createConversationInputSchema>;
