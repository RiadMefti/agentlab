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
import {
  discoveredProviderCapabilitySchema,
  IncompatibleProviderCapabilityError,
  type ProviderCapabilityDiscovery
} from "../../domain/provider-capability-discovery.js";
import type { CommandRunner } from "../process/command-runner.js";
import { BINARY_LOCATOR_MAXIMUM_DURATION_MS } from "./binary-locator.js";
import { withTimeout } from "../../domain/promise-timeout.js";

const VERSION_TIMEOUT_MS = 4_000;
const VERSION_BUFFER_BYTES = 32 * 1024;
const OUTER_TIMEOUT_ALLOWANCE_MS = 250;
const LOCATOR_TIMEOUT_MS = BINARY_LOCATOR_MAXIMUM_DURATION_MS + OUTER_TIMEOUT_ALLOWANCE_MS;
const DISCOVERY_OUTCOME_TIMEOUT_MS = 8_000;
// Aggregate provider-availability budget for responsive project creation. This intentionally
// preempts the sum of every candidate-local maximum; those inner deadlines bound each attempt.
const CATALOG_OUTCOME_TIMEOUT_MS = 12_000;
const MAX_PROVIDER_CANDIDATES = 8;
const PROCESS_CLEANUP_ALLOWANCE_MS = 3_000;

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

  public freshProbe(key: string, now: number): ProviderProbe | null {
    const cached = this.#probes.get(key);
    return cached !== undefined && cached.expiresAt > now ? cached.probe : null;
  }

  public storeProbe(key: string, probe: ProviderProbe, expiresAt: number): void {
    this.#probes.set(key, { probe, expiresAt });
  }

  public lastKnownGood(key: string): LastKnownGood | null {
    return this.#lastKnownGood.get(key) ?? null;
  }

  public storeLastKnownGood(key: string, value: LastKnownGood): void {
    this.#lastKnownGood.set(key, value);
  }

  public inFlight(key: string): Promise<ProviderProbe> | null {
    return this.#inFlight.get(key) ?? null;
  }

  public storeInFlight(key: string, value: Promise<ProviderProbe>): void {
    this.#inFlight.set(key, value);
  }

  public clearInFlight(key: string, value: Promise<ProviderProbe>): void {
    if (this.#inFlight.get(key) === value) this.#inFlight.delete(key);
  }
}

export interface LocalProviderCatalogOptions {
  readonly workspace: string;
  readonly cacheDurationMs?: number;
  readonly versionTimeoutMs?: number;
  readonly locatorTimeoutMs?: number;
  readonly discoveryTimeoutMs?: number;
  readonly catalogTimeoutMs?: number;
  readonly maxCandidates?: number;
  readonly now?: () => number;
  readonly cache?: ProviderCapabilityCache;
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

    const pending = this.discover(id).then((probe) => {
      this.#cache.storeProbe(probeKey, probe, this.#now() + this.#cacheDurationMs);
      return probe;
    });
    this.#cache.storeInFlight(probeKey, pending);
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
      return await withTimeout(this.discoverWithinCatalog(id), {
        timeoutMs: this.options.catalogTimeoutMs ?? CATALOG_OUTCOME_TIMEOUT_MS,
        message: `${launcher.label} provider catalog timed out.`
      });
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
    try {
      const candidates = await withTimeout(this.locator.candidates(id), {
        timeoutMs: this.options.locatorTimeoutMs ?? LOCATOR_TIMEOUT_MS,
        message: `${launcher.label} executable discovery timed out.`
      });
      const maxCandidates = this.options.maxCandidates ?? MAX_PROVIDER_CANDIDATES;
      if (!Number.isSafeInteger(maxCandidates) || maxCandidates <= 0) {
        throw new Error("Provider candidate limit must be a positive integer.");
      }
      for (const executable of candidates.slice(0, maxCandidates)) {
        let installed: InstalledProvider;
        try {
          installed = await this.probeVersion(executable);
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
          const discovered = discoveredProviderCapabilitySchema.parse(
            await withTimeout(
              discovery.discover({
                executable: installed.executable,
                version: installed.version,
                workspace: this.options.workspace
              }),
              {
                timeoutMs: this.options.discoveryTimeoutMs ?? DISCOVERY_OUTCOME_TIMEOUT_MS,
                message: `${launcher.label} model catalog timed out.`
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
    const { stdout, stderr } = await withTimeout(
      this.runner.run(executable, ["--version"], {
        timeoutMs: commandTimeoutMs,
        maxBufferBytes: VERSION_BUFFER_BYTES,
        cleanupProcessTree: true
      }),
      {
        timeoutMs: commandTimeoutMs + PROCESS_CLEANUP_ALLOWANCE_MS,
        message: `Version probe timed out after ${String(commandTimeoutMs)} milliseconds.`
      }
    );
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
