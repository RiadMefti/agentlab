import { spawn } from "node:child_process";

import {
  query,
  type ModelInfo,
  type Query,
  type SpawnedProcess,
  type SpawnOptions
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

import { preservePrimaryFailure } from "../../domain/compensation.js";
import { discoveredProviderCapabilitySchema } from "../../domain/provider-capability-discovery.js";
import type {
  ManagedRuntimeResource,
  ManagedRuntimeResourceOwner
} from "../../domain/runtime-resource.js";
import type {
  DiscoveredProviderCapability,
  ProviderCapabilityDiscovery,
  ProviderDiscoveryContext
} from "../../domain/provider-capability-discovery.js";
import { ManagedChildProcess } from "../process/managed-child-process.js";
import { withTimeout } from "../process/promise-timeout.js";
import { reasoningLabel } from "./capability-labels.js";

const DISCOVERY_TIMEOUT_MS = 5_000;
const CLEANUP_TIMEOUT_MS = 2_500;
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

export interface ClaudeCatalogQuery {
  supportedModels(): Promise<ModelInfo[]>;
  closeAndWait(): Promise<unknown>;
}

export type ClaudeCatalogQueryFactory = (
  context: ProviderDiscoveryContext,
  abortController: AbortController
) => ClaudeCatalogQuery;

/** Discovers the active Claude CLI catalog through Anthropic's local SDK. */
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
  public constructor(
    private readonly createQuery?: ClaudeCatalogQueryFactory,
    private readonly resourceOwner?: ManagedRuntimeResourceOwner,
    private readonly cleanupTimeoutMs = CLEANUP_TIMEOUT_MS
  ) {}

  public async listModels(context: ProviderDiscoveryContext): Promise<readonly ModelInfo[]> {
    const abortController = new AbortController();
    const sdkQuery =
      this.createQuery === undefined
        ? createClaudeCatalogQuery(context, abortController, this.resourceOwner)
        : this.createQuery(context, abortController);
    const resource = new ManagedClaudeCatalogQuery(
      sdkQuery,
      abortController,
      this.cleanupTimeoutMs
    );
    this.resourceOwner?.track(resource);
    let models: readonly ModelInfo[];
    try {
      models = await supportedModelsWithTimeout(sdkQuery, abortController, DISCOVERY_TIMEOUT_MS);
    } catch (error: unknown) {
      try {
        await resource.closeAndWait();
        this.resourceOwner?.release(resource);
      } catch (cleanupError: unknown) {
        throw preservePrimaryFailure(error, cleanupError);
      }
      throw error;
    }
    await resource.closeAndWait();
    this.resourceOwner?.release(resource);
    return models;
  }
}

/** Bounds callers while retaining the real SDK query until a close attempt is confirmed. */
export class ManagedClaudeCatalogQuery implements ManagedRuntimeResource {
  #closed = false;
  #closeInFlight: Promise<void> | null = null;
  #rawCloseInFlight: Promise<void> | null = null;

  public constructor(
    private readonly query: ClaudeCatalogQuery,
    private readonly abortController: AbortController,
    private readonly cleanupTimeoutMs: number
  ) {}

  public closeAndWait(): Promise<void> {
    if (this.#closed) return Promise.resolve();
    if (this.#closeInFlight !== null) return this.#closeInFlight;
    this.abortController.abort();
    const rawClose = this.rawCloseAttempt();
    const attempt = withTimeout(rawClose, {
      timeoutMs: this.cleanupTimeoutMs,
      message: "Claude model discovery cleanup timed out."
    });
    const shared = attempt.finally(() => {
      if (this.#closeInFlight === shared && !this.#closed) this.#closeInFlight = null;
    });
    this.#closeInFlight = shared;
    return shared;
  }

  private rawCloseAttempt(): Promise<void> {
    if (this.#rawCloseInFlight !== null) return this.#rawCloseInFlight;
    const attempt = Promise.resolve()
      .then(() => this.query.closeAndWait())
      .then(() => undefined);
    this.#rawCloseInFlight = attempt;
    void attempt.then(
      () => {
        this.#closed = true;
      },
      () => {
        if (this.#rawCloseInFlight === attempt) this.#rawCloseInFlight = null;
      }
    );
    return attempt;
  }
}

interface OwnedClaudeCatalogProcess {
  readonly process: SpawnedProcess;
  readonly resource: ManagedChildProcess;
  readonly owner: ManagedRuntimeResourceOwner | undefined;
}

export function createClaudeCatalogQuery(
  context: ProviderDiscoveryContext,
  abortController: AbortController,
  resourceOwner?: ManagedRuntimeResourceOwner,
  querySdk: typeof query = query
): ClaudeCatalogQuery {
  let ownedProcess: OwnedClaudeCatalogProcess | null = null;
  const sdkQuery = querySdk({
    prompt: emptyPrompt(),
    options: {
      abortController,
      cwd: context.workspace,
      pathToClaudeCodeExecutable: context.executable,
      settingSources: [],
      spawnClaudeCodeProcess(options) {
        if (ownedProcess !== null) {
          throw new Error("Claude model discovery attempted to spawn more than one process.");
        }
        ownedProcess = spawnOwnedClaudeCatalogProcess(options, resourceOwner);
        return ownedProcess.process;
      }
    }
  });
  return {
    supportedModels: () => sdkQuery.supportedModels(),
    async closeAndWait() {
      const failures: unknown[] = [];
      try {
        // The SDK return is protocol cleanup only; its internal exit wait is deliberately bounded.
        await sdkQuery.return(undefined);
      } catch (error: unknown) {
        failures.push(error);
      }
      if (ownedProcess !== null) {
        try {
          await ownedProcess.resource.closeAndWait();
          ownedProcess.owner?.release(ownedProcess.resource);
        } catch (error: unknown) {
          failures.push(error);
        }
      }
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) {
        throw new AggregateError(failures, "Claude protocol and process cleanup both failed.");
      }
    }
  };
}

function spawnOwnedClaudeCatalogProcess(
  options: SpawnOptions,
  owner?: ManagedRuntimeResourceOwner
): OwnedClaudeCatalogProcess {
  let closed = false;
  const child = spawn(options.command, options.args, {
    cwd: options.cwd,
    detached: process.platform !== "win32",
    env: options.env,
    signal: options.signal,
    stdio: ["pipe", "pipe", "ignore"],
    windowsHide: true
  });
  child.once("close", () => {
    closed = true;
  });
  const resource = new ManagedChildProcess(child, () => closed, {
    gracefulTimeoutMs: 500,
    forcedTimeoutMs: 2_000
  });
  owner?.track(resource);
  return { process: child, resource, owner };
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
