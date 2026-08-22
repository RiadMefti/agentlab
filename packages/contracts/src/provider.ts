import { z } from "zod";

export const providerIdSchema = z.enum(["codex", "claude", "opencode"]);

export type ProviderId = z.infer<typeof providerIdSchema>;

// Provider-qualified deployment identifiers can contain a 2,048-character ARN plus a provider
// prefix. This remains bounded well below process argument and HTTP body limits.
export const MODEL_ID_MAX_LENGTH = 4_096;

export const modelIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(MODEL_ID_MAX_LENGTH)
  .refine((model) => !model.startsWith("-") && !model.includes("\0"), {
    message: "Model must be an identifier, not a command option."
  });

export const reasoningIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(40)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u, {
    message: "Reasoning must be a provider identifier, not a command option."
  });

export type ReasoningId = z.infer<typeof reasoningIdSchema>;

export const reasoningOptionSchema = z
  .object({
    id: reasoningIdSchema,
    label: z.string().trim().min(1).max(80)
  })
  .strict();

export type ReasoningOption = z.infer<typeof reasoningOptionSchema>;

export const modelCapabilitySchema = z
  .object({
    id: modelIdSchema,
    label: z.string().trim().min(1).max(120),
    description: z.string().trim().min(1).max(500).nullable(),
    defaultReasoning: reasoningIdSchema.nullable(),
    reasoningOptions: z.array(reasoningOptionSchema).max(32)
  })
  .strict()
  .superRefine((model, context) => {
    const reasoningIds = new Set<string>();
    for (const [index, option] of model.reasoningOptions.entries()) {
      if (reasoningIds.has(option.id)) {
        context.addIssue({
          code: "custom",
          message: "Reasoning identifiers must be unique for each model.",
          path: ["reasoningOptions", index, "id"]
        });
      }
      reasoningIds.add(option.id);
    }
    if (
      model.defaultReasoning !== null &&
      !model.reasoningOptions.some(({ id }) => id === model.defaultReasoning)
    ) {
      context.addIssue({
        code: "custom",
        message: "Default reasoning must be one of the model's reasoning options.",
        path: ["defaultReasoning"]
      });
    }
  });

export type ModelCapability = z.infer<typeof modelCapabilitySchema>;

export const customModelPolicySchema = z.enum(["allowed", "catalog-only"]);
export type CustomModelPolicy = z.infer<typeof customModelPolicySchema>;

export const capabilitySourceSchema = z.enum(["live", "cache", "stale", "fallback", "unavailable"]);
export type CapabilitySource = z.infer<typeof capabilitySourceSchema>;

export const providerCapabilitySchema = z
  .object({
    id: providerIdSchema,
    label: z.string().trim().min(1).max(80),
    available: z.boolean(),
    version: z.string().trim().min(1).max(180).nullable(),
    reason: z.string().trim().min(1).max(180).nullable(),
    source: capabilitySourceSchema,
    discoveredAt: z.iso.datetime().nullable(),
    defaultModel: modelIdSchema.nullable(),
    models: z.array(modelCapabilitySchema).max(1_000),
    customModelPolicy: customModelPolicySchema
  })
  .strict()
  .superRefine((provider, context) => {
    if (provider.available !== (provider.source !== "unavailable")) {
      context.addIssue({
        code: "custom",
        message: "Provider availability and capability source disagree.",
        path: ["source"]
      });
    }
    if (
      provider.defaultModel !== null &&
      !provider.models.some(({ id }) => id === provider.defaultModel)
    ) {
      context.addIssue({
        code: "custom",
        message: "Default model must be present in the model catalog.",
        path: ["defaultModel"]
      });
    }
  });

export type ProviderCapability = z.infer<typeof providerCapabilitySchema>;

export const providersResponseSchema = z
  .object({
    providers: z.array(providerCapabilitySchema)
  })
  .strict();

export type ProvidersResponse = z.infer<typeof providersResponseSchema>;
