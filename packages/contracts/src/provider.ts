import { z } from "zod";

export const providerIdSchema = z.enum(["codex", "claude", "opencode"]);

export type ProviderId = z.infer<typeof providerIdSchema>;

export const reasoningLevelSchema = z.enum(["minimal", "low", "medium", "high", "xhigh", "max"]);

export type ReasoningLevel = z.infer<typeof reasoningLevelSchema>;

export const providerCapabilitySchema = z.object({
  id: providerIdSchema,
  label: z.string().min(1),
  available: z.boolean(),
  version: z.string().min(1).nullable(),
  reason: z.string().min(1).nullable(),
  defaultReasoning: reasoningLevelSchema,
  reasoningLevels: z.array(reasoningLevelSchema).min(1),
  modelSuggestions: z.array(z.string().min(1)),
  acceptsCustomModel: z.boolean()
});

export type ProviderCapability = z.infer<typeof providerCapabilitySchema>;

export const providersResponseSchema = z.object({
  providers: z.array(providerCapabilitySchema)
});

export type ProvidersResponse = z.infer<typeof providersResponseSchema>;
