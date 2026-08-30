import { createHash } from "node:crypto";

import {
  providerCapabilitySchema,
  type ProviderCapability,
  type ProviderId
} from "@agentlab/contracts";

import type {
  AgentLauncher,
  ProviderCatalog,
  ResolvedProvider
} from "../../domain/agent-launcher.js";
import type { AsyncOperationOwner } from "../../domain/async-operation-owner.js";
import {
  discoveredProviderCapabilitySchema,
  IncompatibleProviderCapabilityError,
  type ProviderCapabilityDiscovery
} from "../../domain/provider-capability-discovery.js";
import type { CommandRunner } from "../process/command-runner.js";
import { withTimeout } from "../process/promise-timeout.js";
const VERSION_TIMEOUT_MS = 4_000;
const VERSION_BUFFER_BYTES = 32 * 1024;
const CATALOG_OUTCOME_TIMEOUT_MS = 12_000;
const MAX_PROVIDER_CANDIDATES = 8;
const DEFAULT_CACHE_ENTRIES = 256;
const DEFAULT_IN_FLIGHT_ENTRIES = 64;

export interface ProviderBinaryLocator {
  candidates(provider: ProviderId): Promise<readonly string[]>;
}

interface InstalledProvider {
  readonly executable: string;
  readonly version: string;
  readonly versionFingerprint: string;
}

interface ProviderProbe {
  readonly capability: ProviderCapability;
  readonly installed: InstalledProvider | null;
}

interface ExpiringProbe {
  readonly expiresAt: number;
  readonly probe: ProviderProbe;
}

interface LastKnownGood {
  readonly capability: ProviderCapability;
  readonly installed: InstalledProvider;
}

export class ProviderCapabilityCache {
  readonly #probes = new Map<string, ExpiringProbe>();
  readonly #lastKnownGood = new Map<string, LastKnownGood>();
  readonly #inFlight = new Map<string, Promise<ProviderProbe>>();
  readonly #locatorOperations = new Map<string, Promise<readonly string[]>>();

  public constructor(
    private readonly maximumEntries: number = DEFAULT_CACHE_ENTRIES,
    private readonly maximumInFlight: number = DEFAULT_IN_FLIGHT_ENTRIES
  ) {
    if (!Number.isSafeInteger(maximumEntries) || maximumEntries < 1) {
      throw new Error("Provider cache entry limit must be a positive integer.");
    }
    if (!Number.isSafeInteger(maximumInFlight) || maximumInFlight < 1) {
      throw new Error("Provider in-flight limit must be a positive integer.");
    }
  }

  public freshProbe(key: string, now: number): ProviderProbe | null {
    const cached = this.#probes.get(key);
    if (cached === undefined || cached.expiresAt <= now) {
      if (cached !== undefined) this.#probes.delete(key);
      return null;
    }
    touch(this.#probes, key, cached);
    return cached.probe;
  }

  public storeProbe(key: string, probe: ProviderProbe, expiresAt: number): void {
    this.#probes.set(key, { probe, expiresAt });
    trimOldest(this.#probes, this.maximumEntries);
  }

  public lastKnownGood(key: string): LastKnownGood | null {
    const cached = this.#lastKnownGood.get(key);
    if (cached === undefined) return null;
    touch(this.#lastKnownGood, key, cached);
    return cached;
  }

  public storeLastKnownGood(key: string, value: LastKnownGood): void {
    this.#lastKnownGood.set(key, value);
    trimOldest(this.#lastKnownGood, this.maximumEntries);
  }

  public inFlight(key: string): Promise<ProviderProbe> | null {
    return this.#inFlight.get(key) ?? null;
  }

  public startInFlight(
    key: string,
    operation: () => Promise<ProviderProbe>
  ): Promise<ProviderProbe> {
    if (!this.#inFlight.has(key) && this.#inFlight.size >= this.maximumInFlight) {
      throw new Error("Provider discovery concurrency limit reached.");
    }
    const value = Promise.resolve(operation());
    this.#inFlight.set(key, value);
    return value;
  }

  public clearInFlight(key: string, value: Promise<ProviderProbe>): void {
    if (this.#inFlight.get(key) === value) this.#inFlight.delete(key);
  }

  /** Deduplicates uncancellable binary discovery until the underlying operation really settles. */
  public locate(
    key: string,
    operation: () => Promise<readonly string[]>
  ): Promise<readonly string[]> {
    const existing = this.#locatorOperations.get(key);
    if (existing !== undefined) return existing;
    if (this.#locatorOperations.size >= this.maximumInFlight) {
      throw new Error("Provider locator concurrency limit reached.");
    }
    const value = Promise.resolve().then(operation);
    this.#locatorOperations.set(key, value);
    void value.then(
      () => {
        this.clearLocator(key, value);
      },
      () => {
        this.clearLocator(key, value);
      }
    );
    return value;
  }

  private clearLocator(key: string, value: Promise<readonly string[]>): void {
    if (this.#locatorOperations.get(key) === value) this.#locatorOperations.delete(key);
  }
}

export interface LocalProviderCatalogOptions {
  readonly workspace: string;
  readonly cacheDurationMs?: number;
  readonly versionTimeoutMs?: number;
  readonly catalogTimeoutMs?: number;
  readonly maxCandidates?: number;
  readonly now?: () => number;
  readonly cache?: ProviderCapabilityCache;
  readonly operationOwner?: AsyncOperationOwner;
}

/** Cached, provider-neutral catalog of CLIs installed on this machine. */
export class LocalProviderCatalog implements ProviderCatalog {
  readonly #launchers: ReadonlyMap<ProviderId, AgentLauncher>;
  readonly #discoveries: ReadonlyMap<ProviderId, ProviderCapabilityDiscovery>;
  readonly #cacheDurationMs: number;
  readonly #now: () => number;
  readonly #cache: ProviderCapabilityCache;

  public constructor(
    launchers: readonly AgentLauncher[],
    discoveries: readonly ProviderCapabilityDiscovery[],
    private readonly locator: ProviderBinaryLocator,
    private readonly runner: CommandRunner,
    private readonly options: LocalProviderCatalogOptions
  ) {
    this.#launchers = new Map(launchers.map((launcher) => [launcher.id, launcher]));
    this.#discoveries = new Map(discoveries.map((discovery) => [discovery.id, discovery]));
    this.#cacheDurationMs = options.cacheDurationMs ?? 5_000;
    this.#now = options.now ?? Date.now;
    this.#cache = options.cache ?? new ProviderCapabilityCache();
  }

  public async list(): Promise<readonly ProviderCapability[]> {
    return Promise.all(
      [...this.#launchers.keys()].map(async (id) => (await this.probe(id)).capability)
    );
  }

  public async resolve(id: ProviderId): Promise<ResolvedProvider | null> {
    const launcher = this.#launchers.get(id);
    if (launcher === undefined) return null;
    const probe = await this.probe(id);
    if (probe.installed === null || !probe.capability.available) return null;
    return {
      launcher,
      capability: probe.capability,
      executable: probe.installed.executable,
      version: probe.installed.version
    };
  }

  private async probe(id: ProviderId): Promise<ProviderProbe> {
    const probeKey = cacheKey(id, this.options.workspace);
    const cached = this.#cache.freshProbe(probeKey, this.#now());
    if (cached !== null) return markCached(cached);

    const existing = this.#cache.inFlight(probeKey);
    if (existing !== null) return existing;

    const pending = this.#cache.startInFlight(probeKey, async () => {
      const probe = await this.discover(id);
      this.#cache.storeProbe(probeKey, probe, this.#now() + this.#cacheDurationMs);
      return probe;
    });
    try {
      return await pending;
    } finally {
      this.#cache.clearInFlight(probeKey, pending);
    }
  }

  private async discover(id: ProviderId): Promise<ProviderProbe> {
    const launcher = this.#launchers.get(id);
    if (launcher === undefined) throw new Error(`Unknown provider: ${id}`);
    try {
      return await this.discoverWithinCatalog(id);
    } catch (error: unknown) {
      return unavailableProbe(launcher, errorReason(error, "Provider catalog timed out."));
    }
  }

  private async discoverWithinCatalog(id: ProviderId): Promise<ProviderProbe> {
    const launcher = this.#launchers.get(id);
    if (launcher === undefined) throw new Error(`Unknown provider: ${id}`);
    const discovery = this.#discoveries.get(id);
    if (discovery === undefined) {
      return unavailableProbe(launcher, "Capability discovery is not configured.");
    }

    let reason = "Executable not found.";
    let fallback: ProviderProbe | null = null;
    const catalogBudgetMs = this.options.catalogTimeoutMs ?? CATALOG_OUTCOME_TIMEOUT_MS;
    if (!Number.isSafeInteger(catalogBudgetMs) || catalogBudgetMs < 1) {
      throw new Error("Provider catalog budget must be a positive integer.");
    }
    const deadline = this.#now() + catalogBudgetMs;
    try {
      const ownedLocatorOperation = this.#cache.locate(
        cacheKey("locator", id, this.options.workspace),
        () => {
          const locatorOperation = this.locator.candidates(id);
          return this.options.operationOwner === undefined
            ? locatorOperation
            : this.options.operationOwner.own(locatorOperation);
        }
      );
      const candidates = await withTimeout(ownedLocatorOperation, {
        timeoutMs: Math.max(1, Math.floor(deadline - this.#now())),
        message: `${launcher.label} provider catalog exhausted its discovery budget.`
      });
      const maxCandidates = this.options.maxCandidates ?? MAX_PROVIDER_CANDIDATES;
      if (!Number.isSafeInteger(maxCandidates) || maxCandidates <= 0) {
        throw new Error("Provider candidate limit must be a positive integer.");
      }
      for (const executable of candidates.slice(0, maxCandidates)) {
        if (this.#now() >= deadline) {
          reason = `${launcher.label} provider catalog exhausted its discovery budget.`;
          break;
        }
        let installed: InstalledProvider;
        try {
          const remainingBudgetMs = Math.floor(deadline - this.#now());
          if (remainingBudgetMs < 1) {
            reason = `${launcher.label} provider catalog exhausted its discovery budget.`;
            break;
          }
          installed = await withTimeout(this.probeVersion(executable), {
            timeoutMs: remainingBudgetMs,
            message: `${launcher.label} provider catalog exhausted its discovery budget.`
          });
        } catch (error: unknown) {
          reason = errorReason(error, "Version probe failed.");
          continue;
        }

        const capabilityKey = cacheKey(
          id,
          this.options.workspace,
          installed.executable,
          installed.versionFingerprint
        );
        try {
          const remainingBudgetMs = Math.floor(deadline - this.#now());
          if (remainingBudgetMs < 1) {
            throw new Error(`${launcher.label} provider catalog exhausted its discovery budget.`);
          }
          const discovered = discoveredProviderCapabilitySchema.parse(
            await withTimeout(
              discovery.discover({
                executable: installed.executable,
                version: installed.version,
                workspace: this.options.workspace
              }),
              {
                timeoutMs: remainingBudgetMs,
                message: `${launcher.label} provider catalog exhausted its discovery budget.`
              }
            )
          );
          const capability = providerCapabilitySchema.parse({
            id,
            label: launcher.label,
            available: true,
            version: installed.version,
            reason: null,
            source: "live",
            discoveredAt: new Date(this.#now()).toISOString(),
            defaultModel: discovered.defaultModel,
            models: discovered.models,
            customModelPolicy: launcher.customModelPolicy
          });
          const probe = { capability, installed };
          this.#cache.storeLastKnownGood(capabilityKey, probe);
          return probe;
        } catch (error: unknown) {
          reason = errorReason(error, "Model discovery failed.");
          if (error instanceof IncompatibleProviderCapabilityError) {
            return unavailableProbe(launcher, reason);
          }
          const lastKnownGood = this.#cache.lastKnownGood(capabilityKey);
          if (lastKnownGood !== null) {
            return {
              installed,
              capability: providerCapabilitySchema.parse({
                ...lastKnownGood.capability,
                source: "stale",
                reason: conciseReason(`Using last known models: ${reason}`)
              })
            };
          }
          fallback ??= {
            installed,
            capability: providerCapabilitySchema.parse({
              id,
              label: launcher.label,
              available: true,
              version: installed.version,
              reason: conciseReason(`Model discovery failed: ${reason}`),
              source: "fallback",
              discoveredAt: null,
              defaultModel: null,
              models: [],
              customModelPolicy: launcher.customModelPolicy
            })
          };
        }
      }
    } catch (error: unknown) {
      reason = errorReason(error, "Provider discovery failed.");
    }

    return fallback ?? unavailableProbe(launcher, conciseReason(reason));
  }

  private async probeVersion(executable: string): Promise<InstalledProvider> {
    const commandTimeoutMs = this.options.versionTimeoutMs ?? VERSION_TIMEOUT_MS;
    const { stdout, stderr } = await this.runner.run(executable, ["--version"], {
      cwd: this.options.workspace,
      timeoutMs: commandTimeoutMs,
      maxBufferBytes: VERSION_BUFFER_BYTES,
      cleanupProcessTree: true
    });
    const version = providerVersion(stdout, stderr);
    if (version === null) {
      throw new Error("Version probe returned no version.");
    }
    return {
      executable,
      version: conciseReason(version),
      versionFingerprint: versionFingerprint(version)
    };
  }
}

function touch<Value>(map: Map<string, Value>, key: string, value: Value): void {
  map.delete(key);
  map.set(key, value);
}

function trimOldest<Value>(map: Map<string, Value>, maximumEntries: number): void {
  while (map.size > maximumEntries) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) return;
    map.delete(oldest);
  }
}

function unavailableProbe(launcher: AgentLauncher, reason: string): ProviderProbe {
  return {
    installed: null,
    capability: providerCapabilitySchema.parse({
      id: launcher.id,
      label: launcher.label,
      available: false,
      version: null,
      reason: conciseReason(reason),
      source: "unavailable",
      discoveredAt: null,
      defaultModel: null,
      models: [],
      customModelPolicy: launcher.customModelPolicy
    })
  };
}

function markCached(probe: ProviderProbe): ProviderProbe {
  if (probe.capability.source !== "live") return probe;
  const capability = providerCapabilitySchema.parse({ ...probe.capability, source: "cache" });
  return { ...probe, capability };
}

function cacheKey(...parts: readonly string[]): string {
  return parts.join("\0");
}

function providerVersion(stdout: string, stderr: string): string | null {
  const lines = `${stdout}\n${stderr}`
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.find((line) => !line.toLowerCase().startsWith("mise ")) ?? lines[0] ?? null;
}

function versionFingerprint(version: string): string {
  return createHash("sha256").update(version, "utf8").digest("hex");
}

function errorReason(error: unknown, fallback: string): string {
  return conciseReason(error instanceof Error ? error.message : fallback);
}

function conciseReason(reason: string): string {
  const firstLine =
    reason
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .find(Boolean) ?? "Provider unavailable.";
  return firstLine.length > 180 ? `${firstLine.slice(0, 179)}…` : firstLine;
}
