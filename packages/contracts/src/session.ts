import { z } from "zod";

import { providerIdSchema } from "./provider.js";

export const sessionHistoryLimit = 20_000;

/** OpenTUI's embedded-terminal scrollback budget is measured in bytes, not lines. */
export const terminalScrollbackBytes = 16 * 1024 * 1024;

export const agentRoleSchema = z.enum(["captain", "worker"]);
export type AgentRole = z.infer<typeof agentRoleSchema>;

export const sessionStatusSchema = z.enum(["running", "stopped"]);
export type SessionStatus = z.infer<typeof sessionStatusSchema>;

export const agentSessionSchema = z.object({
  name: z.string().min(1),
  conversationId: z.uuid(),
  role: agentRoleSchema,
  provider: providerIdSchema,
  label: z.string().min(1),
  status: sessionStatusSchema,
  attached: z.boolean(),
  startedAt: z.iso.datetime().nullable()
});

export type AgentSession = z.infer<typeof agentSessionSchema>;

export const agentPromptSchema = z
  .string()
  .trim()
  .min(1)
  .max(20_000)
  .refine((prompt) => !prompt.includes("\0"), { message: "Prompt cannot contain null bytes." });

export const workerLabelSchema = z
  .string()
  .trim()
  .min(1)
  .max(32)
  .regex(/^[A-Za-z0-9]+(?:[ -][A-Za-z0-9]+)*$/u, {
    message: "Name can contain letters, numbers, spaces, and hyphens."
  });

export const createWorkerInputSchema = z
  .object({
    label: workerLabelSchema,
    prompt: agentPromptSchema,
    provider: providerIdSchema
  })
  .strict();

export type CreateWorkerInput = z.infer<typeof createWorkerInputSchema>;
