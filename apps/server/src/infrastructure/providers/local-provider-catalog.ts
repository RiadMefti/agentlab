import type { ProviderCapability, ProviderId } from "@orchestrator/contracts";

import type {
  CaptainLauncher,
  ProviderCatalog,
  ResolvedCaptainProvider
} from "../../domain/captain-launcher.js";
import type { CommandRunner } from "../process/command-runner.js";

export interface ProviderBinaryLocator {
  candidates(provider: ProviderId): Promise<readonly string[]>;
}

interface ProbeResult {
  readonly executable: string;
  readonly version: string;
}

interface CacheEntry {
  readonly expiresAt: number;
  readonly result: ProbeResult | null;
  readonly reason: string | null;
}

export class LocalProviderCatalog implements ProviderCatalog {
  readonly #launchers: ReadonlyMap<ProviderId, CaptainLauncher>;
  readonly #cache = new Map<ProviderId, CacheEntry>();

  public constructor(
    launchers: readonly CaptainLauncher[],
    private readonly locator: ProviderBinaryLocator,
    private readonly runner: CommandRunner,
    private readonly cacheDurationMs = 5_000,
    private readonly now: () => number = Date.now
  ) {
    this.#launchers = new Map(launchers.map((launcher) => [launcher.capability.id, launcher]));
  }

  public async list(): Promise<readonly ProviderCapability[]> {
    return Promise.all(
      [...this.#launchers.values()].map(async (launcher) => {
        const probe = await this.probe(launcher.capability.id);
        return {
          ...launcher.capability,
          available: probe.result !== null,
          version: probe.result?.version ?? null,
          reason: probe.reason
        };
      })
    );
  }

  public async resolveCaptain(id: ProviderId): Promise<ResolvedCaptainProvider | null> {
    const launcher = this.#launchers.get(id);
    if (launcher === undefined) return null;
    const probe = await this.probe(id);
    if (probe.result === null) return null;
    return { launcher, ...probe.result };
  }

  private async probe(id: ProviderId): Promise<CacheEntry> {
    const cached = this.#cache.get(id);
    if (cached !== undefined && cached.expiresAt > this.now()) return cached;

    let reason = "Executable not found.";
    try {
      const candidates = await this.locator.candidates(id);
      for (const executable of candidates) {
        try {
          const { stdout, stderr } = await this.runner.run(executable, ["--version"], {
            timeoutMs: 4_000
          });
          const version = providerVersion(stdout, stderr);
          const entry: CacheEntry = {
            expiresAt: this.now() + this.cacheDurationMs,
            result: { executable, version: version ?? "Installed" },
            reason: null
          };
          this.#cache.set(id, entry);
          return entry;
        } catch (error: unknown) {
          reason = error instanceof Error ? error.message : "Version probe failed.";
        }
      }
    } catch (error: unknown) {
      reason = error instanceof Error ? error.message : "Provider discovery failed.";
    }

    const entry: CacheEntry = {
      expiresAt: this.now() + this.cacheDurationMs,
      result: null,
      reason: conciseReason(reason)
    };
    this.#cache.set(id, entry);
    return entry;
  }
}

function firstNonEmptyLine(output: string): string | null {
  return (
    output
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? null
  );
}

function providerVersion(stdout: string, stderr: string): string | null {
  const lines = `${stdout}\n${stderr}`
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.find((line) => !line.toLowerCase().startsWith("mise ")) ?? lines[0] ?? null;
}

function conciseReason(reason: string): string {
  const firstLine = firstNonEmptyLine(reason) ?? "Provider unavailable.";
  return firstLine.length > 180 ? `${firstLine.slice(0, 179)}…` : firstLine;
}
