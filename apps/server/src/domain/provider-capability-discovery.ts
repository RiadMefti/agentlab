import { z } from "zod";

import {
  modelCapabilitySchema,
  modelIdSchema,
  type ModelCapability,
  type ProviderId
} from "@orchestrator/contracts";

export const discoveredProviderCapabilitySchema = z
  .object({
    defaultModel: modelIdSchema.nullable(),
    models: z.array(modelCapabilitySchema).max(1_000)
  })
  .strict()
  .superRefine((capability, context) => {
    const ids = new Set<string>();
    for (const [index, model] of capability.models.entries()) {
      if (ids.has(model.id)) {
        context.addIssue({
          code: "custom",
          message: "Model identifiers must be unique.",
          path: ["models", index, "id"]
        });
      }
      ids.add(model.id);
    }
    if (capability.defaultModel !== null && !ids.has(capability.defaultModel)) {
      context.addIssue({
        code: "custom",
        message: "Default model must be present in the discovered catalog.",
        path: ["defaultModel"]
      });
    }
  });

export interface DiscoveredProviderCapability {
  readonly defaultModel: string | null;
  readonly models: readonly ModelCapability[];
}

export interface ProviderDiscoveryContext {
  readonly executable: string;
  readonly version: string;
  readonly workspace: string;
}

export interface ProviderCapabilityDiscovery {
  readonly id: ProviderId;
  discover(context: ProviderDiscoveryContext): Promise<DiscoveredProviderCapability>;
}

/** A catalog that is well-formed but cannot safely preserve product invariants. */
export class IncompatibleProviderCapabilityError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "IncompatibleProviderCapabilityError";
  }
}
