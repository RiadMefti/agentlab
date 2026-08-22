import { z } from "zod";

import { providerIdSchema } from "./provider.js";

export const sessionHistoryLimit = 20_000;

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

export const sessionsResponseSchema = z.object({
  sessions: z.array(agentSessionSchema)
});

export type SessionsResponse = z.infer<typeof sessionsResponseSchema>;

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

export const workerCreatedResponseSchema = z
  .object({
    sessionName: z.string().min(1)
  })
  .strict();

export type WorkerCreatedResponse = z.infer<typeof workerCreatedResponseSchema>;

export const terminalClientMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("input"), data: z.string().max(64_000) }).strict(),
  z
    .object({
      type: z.literal("resize"),
      cols: z.number().int().min(2).max(1_000),
      rows: z.number().int().min(1).max(1_000)
    })
    .strict()
]);

export type TerminalClientMessage = z.infer<typeof terminalClientMessageSchema>;

export const terminalServerMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("data"), data: z.string() }),
  z.object({ type: z.literal("exit"), exitCode: z.number().int().nullable() }),
  z.object({ type: z.literal("error"), message: z.string() })
]);

export type TerminalServerMessage = z.infer<typeof terminalServerMessageSchema>;
