import { once } from "node:events";
import { spawn } from "node:child_process";

import { query as claudeQuery, type SpawnedProcess } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it, vi } from "vitest";

import { RuntimeResourceOwner } from "../../packages/runtime/src/application/runtime-resource-owner.js";
import {
  ClaudeAgentSdkCatalogClient,
  createClaudeCatalogQuery
} from "../../packages/runtime/src/infrastructure/providers/claude-capability-discovery.js";

const context = {
  executable: "/opt/claude",
  version: "claude 1.0.0",
  workspace: "/work/project"
};

describe("ClaudeAgentSdkCatalogClient ownership", () => {
  it("owns the default SDK hook's real child after the SDK cleanup facade resolves", async () => {
    const resources = new RuntimeResourceOwner();
    const owner = {
      track: vi.fn(resources.track.bind(resources)),
      release: vi.fn(resources.release.bind(resources))
    };
    let spawnedProcess: SpawnedProcess | null = null;
    const sdkReturn = vi.fn(() => {
      expect(spawnedProcess?.exitCode).toBeNull();
      return Promise.resolve({ done: true as const, value: undefined });
    });
    const querySdk = ((params: Parameters<typeof claudeQuery>[0]) => {
      const spawnClaudeCodeProcess = params.options?.spawnClaudeCodeProcess;
      if (spawnClaudeCodeProcess === undefined) throw new Error("Spawn hook was not installed.");
      spawnedProcess = spawnClaudeCodeProcess({
        command: process.execPath,
        args: ["-e", "setInterval(() => undefined, 1000)"],
        cwd: process.cwd(),
        env: process.env,
        signal: new AbortController().signal
      });
      return {
        supportedModels: () => Promise.resolve([]),
        return: sdkReturn
      } as unknown as ReturnType<typeof claudeQuery>;
    }) as typeof claudeQuery;
    const catalogQuery = createClaudeCatalogQuery(context, new AbortController(), owner, querySdk);

    expect(owner.track).toHaveBeenCalledOnce();
    await expect(catalogQuery.supportedModels()).resolves.toEqual([]);
    await expect(catalogQuery.closeAndWait()).resolves.toBeUndefined();

    expect(sdkReturn).toHaveBeenCalledOnce();
    const capturedProcess = spawnedProcess as SpawnedProcess | null;
    if (capturedProcess === null) throw new Error("SDK spawn hook did not capture a process.");
    expect(capturedProcess.exitCode !== null || capturedProcess.signalCode !== null).toBe(true);
    expect(owner.release).toHaveBeenCalledOnce();
    await expect(resources.closeAll()).resolves.toBeUndefined();
  });

  it("does not return until the SDK query's real child process has exited", async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => undefined, 1000)"], {
      stdio: "ignore"
    });
    await once(child, "spawn");
    const client = new ClaudeAgentSdkCatalogClient(() => ({
      supportedModels: () => Promise.resolve([]),
      async closeAndWait() {
        child.kill("SIGTERM");
        await once(child, "close");
      }
    }));

    await expect(client.listModels(context)).resolves.toEqual([]);
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
  });

  it("keeps model-discovery failure primary when awaited SDK cleanup also fails", async () => {
    const primary = new Error("model request failed");
    const cleanup = new Error("transport exit failed");
    const client = new ClaudeAgentSdkCatalogClient(() => ({
      supportedModels: () => Promise.reject(primary),
      closeAndWait: () => Promise.reject(cleanup)
    }));

    const failure = await client.listModels(context).catch((error: unknown) => error);

    expect(failure).toBe(primary);
    expect(primary.cause).toBeInstanceOf(AggregateError);
    expect((primary.cause as AggregateError).errors).toContain(cleanup);
  });

  it("retains failed SDK cleanup for a later runtime-shutdown retry", async () => {
    const owner = new RuntimeResourceOwner();
    let cleanupAttempts = 0;
    const client = new ClaudeAgentSdkCatalogClient(
      () => ({
        supportedModels: () => Promise.resolve([]),
        closeAndWait: () => {
          cleanupAttempts += 1;
          return cleanupAttempts === 1
            ? Promise.reject(new Error("SDK cleanup ambiguous"))
            : Promise.resolve();
        }
      }),
      owner,
      50
    );

    await expect(client.listModels(context)).rejects.toThrow("SDK cleanup ambiguous");
    await expect(owner.closeAll()).resolves.toBeUndefined();
    expect(cleanupAttempts).toBe(2);
  });

  it("bounds a hanging SDK cleanup while retaining its one real close operation", async () => {
    let confirmClose!: () => void;
    const realClose = new Promise<void>((resolve) => {
      confirmClose = resolve;
    });
    const owner = new RuntimeResourceOwner();
    let cleanupAttempts = 0;
    const client = new ClaudeAgentSdkCatalogClient(
      () => ({
        supportedModels: () => Promise.resolve([]),
        closeAndWait: () => {
          cleanupAttempts += 1;
          return realClose;
        }
      }),
      owner,
      10
    );

    await expect(client.listModels(context)).rejects.toThrow(
      "Claude model discovery cleanup timed out."
    );
    const ownerFailure = await owner.closeAll().catch((error: unknown) => error);
    expect(ownerFailure).toBeInstanceOf(AggregateError);
    expect((ownerFailure as AggregateError).errors[0]).toEqual(
      expect.objectContaining({ message: "Claude model discovery cleanup timed out." })
    );
    expect(cleanupAttempts).toBe(1);

    confirmClose();
    await realClose;
    await expect(owner.closeAll()).resolves.toBeUndefined();
  });
});
