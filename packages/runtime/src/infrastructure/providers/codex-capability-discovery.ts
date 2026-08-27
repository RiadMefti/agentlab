import { spawn } from "node:child_process";

import { z } from "zod";

import { discoveredProviderCapabilitySchema } from "../../domain/provider-capability-discovery.js";
import type {
  DiscoveredProviderCapability,
  ProviderCapabilityDiscovery,
  ProviderDiscoveryContext
} from "../../domain/provider-capability-discovery.js";
import { IncompatibleProviderCapabilityError } from "../../domain/provider-capability-discovery.js";
import { terminateProcessTree } from "../process/process-tree.js";
import { reasoningLabel } from "./capability-labels.js";

const MAX_PROTOCOL_BYTES = 2 * 1024 * 1024;
const MAX_STDERR_BYTES = 32 * 1024;
const MAX_PAGES = 20;
const MAX_MODELS = 1_000;
const REQUEST_TIMEOUT_MS = 5_000;
const SHUTDOWN_GRACE_MS = 500;
const SHUTDOWN_FORCE_MS = 2_000;

const rawReasoningSchema = z
  .object({
    reasoningEffort: z.string(),
    description: z.string()
  })
  .loose();

const rawModelSchema = z
  .object({
    model: z.string(),
    displayName: z.string(),
    description: z.string(),
    hidden: z.boolean(),
    supportedReasoningEfforts: z.array(rawReasoningSchema).max(32),
    defaultReasoningEffort: z.string(),
    isDefault: z.boolean()
  })
  .loose();

const rawModelsSchema = z.array(rawModelSchema).max(MAX_MODELS);

export interface CodexCatalogClient {
  listModels(context: ProviderDiscoveryContext): Promise<unknown>;
}

/** Discovers the active Codex catalog from its local app-server protocol. */
export class CodexCapabilityDiscovery implements ProviderCapabilityDiscovery {
  public readonly id = "codex" as const;

  public constructor(
    private readonly client: CodexCatalogClient = new CodexAppServerCatalogClient()
  ) {}

  public async discover(context: ProviderDiscoveryContext): Promise<DiscoveredProviderCapability> {
    return parseCodexModels(await this.client.listModels(context));
  }
}

export function parseCodexModels(input: unknown): DiscoveredProviderCapability {
  const advertisedModels = rawModelsSchema.parse(input).map((model) => ({
    ...model,
    defaultReasoningEffort: model.defaultReasoningEffort.trim(),
    supportedReasoningEfforts: model.supportedReasoningEfforts.map((option) => ({
      ...option,
      reasoningEffort: option.reasoningEffort.trim()
    }))
  }));
  if (advertisedModels.filter(({ isDefault }) => isDefault).length > 1) {
    throw new Error("Codex model catalog advertised more than one default model.");
  }
  const ultraDefault = advertisedModels.find(
    ({ defaultReasoningEffort }) => defaultReasoningEffort === "ultra"
  );
  if (ultraDefault !== undefined) {
    throw new IncompatibleProviderCapabilityError(
      `Codex model ${ultraDefault.model} defaults to ultra, which would enable automatic delegation.`
    );
  }
  const rawModels = advertisedModels.filter(({ hidden }) => !hidden);
  const parsed = discoveredProviderCapabilitySchema.parse({
    defaultModel: rawModels.find(({ isDefault }) => isDefault)?.model ?? null,
    models: rawModels.map((model) => {
      // Ultra is Codex's automatic multi-agent mode, not a single-captain reasoning level.
      const reasoning = model.supportedReasoningEfforts.filter(
        ({ reasoningEffort }) => reasoningEffort !== "ultra"
      );
      return {
        id: model.model,
        label: model.displayName,
        description: model.description.trim() === "" ? null : model.description,
        defaultReasoning: model.defaultReasoningEffort,
        reasoningOptions: reasoning.map((option) => ({
          id: option.reasoningEffort,
          label: reasoningLabel(option.reasoningEffort)
        }))
      };
    })
  });
  return parsed;
}

export class CodexAppServerCatalogClient implements CodexCatalogClient {
  public constructor(
    private readonly timeoutMs = REQUEST_TIMEOUT_MS,
    private readonly shutdownGraceMs = SHUTDOWN_GRACE_MS,
    private readonly shutdownForceMs = SHUTDOWN_FORCE_MS
  ) {}

  public listModels(context: ProviderDiscoveryContext): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const child = spawn(context.executable, ["app-server", "--stdio"], {
        cwd: context.workspace,
        detached: process.platform !== "win32",
        stdio: ["pipe", "pipe", "pipe"]
      });
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");

      let stdoutBuffer = "";
      let stderr = "";
      let receivedBytes = 0;
      let finishing = false;
      let closed = false;
      let nextRequestId = 2;
      let pendingRequestId: number | null = 1;
      let pages = 0;
      const cursors = new Set<string>();
      const models: unknown[] = [];
      let timeout: NodeJS.Timeout | null = null;

      const finish = (error: Error | null, result?: unknown): void => {
        if (finishing) return;
        finishing = true;
        if (timeout !== null) clearTimeout(timeout);
        try {
          child.stdin.end();
        } catch {
          // Cleanup below owns the final outcome even if stdin already closed synchronously.
        }
        void terminateProcessTree(child, () => closed, {
          gracefulTimeoutMs: this.shutdownGraceMs,
          forcedTimeoutMs: this.shutdownForceMs
        }).then(
          () => {
            if (error === null) resolve(result);
            else reject(error);
          },
          (cleanupError: unknown) => {
            const detail =
              cleanupError instanceof Error ? cleanupError.message : "Unknown cleanup failure.";
            const cleanupFailure = new Error(`Codex model discovery cleanup failed: ${detail}`, {
              cause: cleanupError
            });
            reject(
              error === null
                ? cleanupFailure
                : new AggregateError([error, cleanupFailure], error.message, {
                    cause: cleanupError
                  })
            );
          }
        );
      };

      const write = (message: unknown): void => {
        if (finishing) return;
        child.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
          if (error !== null && error !== undefined) finish(error);
        });
      };

      const requestPage = (cursor: string | null): void => {
        pages += 1;
        if (pages > MAX_PAGES) {
          finish(new Error("Codex model catalog exceeded the page limit."));
          return;
        }
        const requestId = nextRequestId;
        pendingRequestId = requestId;
        write({
          method: "model/list",
          id: requestId,
          params: { cursor, limit: 100, includeHidden: false }
        });
        nextRequestId += 1;
      };

      const handleMessage = (value: unknown): void => {
        if (finishing) return;
        if (typeof value !== "object" || value === null) {
          finish(new Error("Codex app-server returned a non-object message."));
          return;
        }
        const message = value as Record<string, unknown>;
        if (message.id !== pendingRequestId) return;
        if (message.id === 1) {
          pendingRequestId = null;
          if (message.error !== undefined) {
            finish(new Error(protocolError(message.error)));
            return;
          }
          write({ method: "initialized" });
          requestPage(null);
          return;
        }
        pendingRequestId = null;
        if (message.error !== undefined) {
          finish(new Error(protocolError(message.error)));
          return;
        }
        const page = parsePageEnvelope(message.result);
        if (page === null) {
          finish(new Error("Codex app-server returned an invalid model page."));
          return;
        }
        models.push(...page.data);
        if (models.length > MAX_MODELS) {
          finish(new Error("Codex model catalog exceeded the model limit."));
          return;
        }
        if (page.nextCursor === null) {
          finish(null, models);
          return;
        }
        if (cursors.has(page.nextCursor)) {
          finish(new Error("Codex model catalog repeated a pagination cursor."));
          return;
        }
        cursors.add(page.nextCursor);
        requestPage(page.nextCursor);
      };

      child.stdout.on("data", (chunk: string) => {
        if (finishing) return;
        receivedBytes += Buffer.byteLength(chunk);
        if (receivedBytes > MAX_PROTOCOL_BYTES) {
          finish(new Error("Codex app-server output exceeded the size limit."));
          return;
        }
        stdoutBuffer += chunk;
        let newline = stdoutBuffer.indexOf("\n");
        while (newline >= 0) {
          const line = stdoutBuffer.slice(0, newline).trim();
          stdoutBuffer = stdoutBuffer.slice(newline + 1);
          if (line !== "") {
            try {
              handleMessage(JSON.parse(line) as unknown);
            } catch {
              finish(new Error("Codex app-server returned invalid JSON."));
            }
          }
          newline = stdoutBuffer.indexOf("\n");
        }
      });
      child.stderr.on("data", (chunk: string) => {
        const remaining = MAX_STDERR_BYTES - Buffer.byteLength(stderr);
        if (remaining <= 0) return;
        stderr += Buffer.from(chunk).subarray(0, remaining).toString("utf8");
      });
      child.stdin.on("error", (error) => {
        if (!finishing) finish(error);
      });
      child.on("error", (error) => {
        finish(error);
      });
      child.on("close", (code) => {
        closed = true;
        if (!finishing) {
          const detail = firstLine(stderr);
          finish(
            new Error(
              detail ?? `Codex app-server exited before returning models (code ${String(code)}).`
            )
          );
        }
      });

      timeout = setTimeout(() => {
        finish(new Error("Codex model catalog timed out."));
      }, this.timeoutMs);
      write({
        method: "initialize",
        id: 1,
        params: {
          clientInfo: { name: "agentlab", title: "AgentLab", version: "0.1.0" },
          capabilities: null
        }
      });
    });
  }
}

function parsePageEnvelope(
  value: unknown
): { readonly data: readonly unknown[]; readonly nextCursor: string | null } | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.data)) return null;
  if (record.nextCursor !== null && typeof record.nextCursor !== "string") return null;
  return { data: record.data, nextCursor: record.nextCursor ?? null };
}

function protocolError(value: unknown): string {
  if (typeof value === "object" && value !== null) {
    const message = (value as Record<string, unknown>).message;
    if (typeof message === "string" && message.trim() !== "") return firstLine(message) ?? message;
  }
  return "Codex app-server rejected model discovery.";
}

function firstLine(value: string): string | null {
  return (
    value
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .find(Boolean) ?? null
  );
}
