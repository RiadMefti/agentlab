import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import { sha256DigestSchema, type ProviderId, type Sha256Digest } from "@agentlab/contracts";
import { z } from "zod";

import type {
  FactoryAgentProviderResolver,
  ResolvedFactoryAgentProvider
} from "../../domain/factory-agent-executor.js";
import { pinnedLocalExecutableDigest } from "../filesystem/pinned-local-executable.js";
import type { CommandRunner } from "../process/command-runner.js";

const supportedProviderSchema = z.enum(["codex", "claude"]);
const bindingSchema = z
  .object({
    provider: supportedProviderSchema,
    executable: z
      .string()
      .min(1)
      .max(4_096)
      .refine(
        (value) => isAbsolute(value) && !value.includes("\0") && resolve(value) === value,
        "Provider executable must be a normalized absolute path."
      ),
    executableDigest: sha256DigestSchema,
    version: z
      .string()
      .trim()
      .min(1)
      .max(180)
      .refine((value) => !/[\0\r\n]/u.test(value))
  })
  .strict();
const workspaceSchema = z
  .string()
  .min(1)
  .max(4_096)
  .refine((value) => isAbsolute(value) && !value.includes("\0") && resolve(value) === value);
const providerProbeEnvironment = Object.freeze({
  CI: "true",
  LC_ALL: "C",
  NO_COLOR: "1",
  PATH: "/usr/local/bin:/usr/bin:/bin",
  TERM: "dumb"
});
const maximumVersionOutputBytes = 32 * 1_024;

export interface FactoryAgentProviderBinding {
  readonly provider: Extract<ProviderId, "codex" | "claude">;
  readonly executable: string;
  readonly executableDigest: Sha256Digest;
  readonly version: string;
}

export interface PinnedFactoryAgentProviderResolverOptions {
  readonly bindings: readonly FactoryAgentProviderBinding[];
  readonly versionTimeoutMs?: number;
}

/** Resolves only owner-pinned provider binaries after an exact scrubbed version probe. */
export class PinnedFactoryAgentProviderResolver implements FactoryAgentProviderResolver {
  readonly #bindings: ReadonlyMap<ProviderId, FactoryAgentProviderBinding>;
  readonly #versionTimeoutMs: number;

  public constructor(
    private readonly runner: CommandRunner,
    options: PinnedFactoryAgentProviderResolverOptions
  ) {
    const bindings = z.array(bindingSchema).min(1).max(2).parse(options.bindings);
    if (new Set(bindings.map(({ provider }) => provider)).size !== bindings.length) {
      throw new Error("Factory provider bindings must have unique provider IDs.");
    }
    const timeout = options.versionTimeoutMs ?? 5_000;
    if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 60_000) {
      throw new Error("Factory provider version timeout must be a bounded positive integer.");
    }
    this.#bindings = new Map(bindings.map((binding) => [binding.provider, binding]));
    this.#versionTimeoutMs = timeout;
  }

  public async resolve(
    provider: ProviderId,
    workspaceInput: string
  ): Promise<ResolvedFactoryAgentProvider | null> {
    const binding = this.#bindings.get(provider);
    if (binding === undefined) return null;
    const workspace = workspaceSchema.parse(workspaceInput);
    await assertCanonicalDirectory(workspace, "Factory provider workspace");
    if (
      (await pinnedLocalExecutableDigest(
        binding.executable,
        "Pinned factory provider executable"
      )) !== binding.executableDigest
    ) {
      throw new Error(`Pinned ${provider} provider executable digest does not match.`);
    }
    const { stdout, stderr } = await this.runner.run(binding.executable, ["--version"], {
      cwd: workspace,
      timeoutMs: this.#versionTimeoutMs,
      maxBufferBytes: maximumVersionOutputBytes,
      maxCombinedBufferBytes: maximumVersionOutputBytes,
      cleanupProcessTree: true,
      environment: providerProbeEnvironment
    });
    const observed = providerVersion(stdout, stderr);
    if (observed !== binding.version) {
      throw new Error(`Pinned ${provider} provider version does not match the installed binary.`);
    }
    return { executable: binding.executable, version: observed };
  }
}

async function assertCanonicalDirectory(path: string, label: string): Promise<void> {
  if ((await realpath(path)) !== path) throw new Error(`${label} must be canonical.`);
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`${label} must be a real directory.`);
  }
}

function providerVersion(stdout: string, stderr: string): string | null {
  const lines = `${stdout}\n${stderr}`
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.find((line) => !line.toLowerCase().startsWith("mise ")) ?? lines[0] ?? null;
}
