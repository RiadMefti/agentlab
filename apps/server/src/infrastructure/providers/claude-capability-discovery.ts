import { query, type ModelInfo, type Query } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

import { discoveredProviderCapabilitySchema } from "../../domain/provider-capability-discovery.js";
import type {
  DiscoveredProviderCapability,
  ProviderCapabilityDiscovery,
  ProviderDiscoveryContext
} from "../../domain/provider-capability-discovery.js";
import { reasoningLabel } from "./capability-labels.js";

const DISCOVERY_TIMEOUT_MS = 5_000;
const MAX_MODELS = 200;

const modelInfoSchema = z
  .object({
    value: z.string(),
    resolvedModel: z.string().optional(),
    displayName: z.string(),
    description: z.string(),
    supportsEffort: z.boolean().optional(),
    supportedEffortLevels: z.array(z.string()).max(32).optional()
  })
  .loose();

const modelInfosSchema = z.array(modelInfoSchema).max(MAX_MODELS);

export interface ClaudeCatalogClient {
  listModels(context: ProviderDiscoveryContext): Promise<unknown>;
}

export class ClaudeCapabilityDiscovery implements ProviderCapabilityDiscovery {
  public readonly id = "claude" as const;

  public constructor(
    private readonly client: ClaudeCatalogClient = new ClaudeAgentSdkCatalogClient()
  ) {}

  public async discover(context: ProviderDiscoveryContext): Promise<DiscoveredProviderCapability> {
    return parseClaudeModels(await this.client.listModels(context));
  }
}

export function parseClaudeModels(input: unknown): DiscoveredProviderCapability {
  const models = modelInfosSchema.parse(input);
  const parsed = discoveredProviderCapabilitySchema.parse({
    defaultModel: models.some(({ value }) => value === "default") ? "default" : null,
    models: models.map((model) => ({
      id: model.value,
      label: model.displayName,
      description: model.description.trim() === "" ? null : model.description,
      defaultReasoning: null,
      reasoningOptions:
        model.supportsEffort === true
          ? (model.supportedEffortLevels ?? []).map((level) => ({
              id: level,
              label: reasoningLabel(level)
            }))
          : []
    }))
  });
  return parsed;
}

export class ClaudeAgentSdkCatalogClient implements ClaudeCatalogClient {
  public async listModels(context: ProviderDiscoveryContext): Promise<readonly ModelInfo[]> {
    const abortController = new AbortController();
    const sdkQuery = query({
      prompt: emptyPrompt(),
      options: {
        abortController,
        cwd: context.workspace,
        pathToClaudeCodeExecutable: context.executable,
        settingSources: []
      }
    });
    try {
      return await supportedModelsWithTimeout(sdkQuery, abortController, DISCOVERY_TIMEOUT_MS);
    } finally {
      sdkQuery.close();
    }
  }
}

async function* emptyPrompt(): AsyncGenerator<never> {
  // Streaming mode initializes the SDK control channel without submitting a user prompt.
}

export async function supportedModelsWithTimeout(
  sdkQuery: Pick<Query, "supportedModels">,
  abortController: AbortController,
  timeoutMs: number
): Promise<readonly ModelInfo[]> {
  let timeout: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      abortController.abort();
      reject(new Error("Claude model catalog timed out."));
    }, timeoutMs);
  });
  try {
    return await Promise.race([sdkQuery.supportedModels(), timeoutPromise]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}
