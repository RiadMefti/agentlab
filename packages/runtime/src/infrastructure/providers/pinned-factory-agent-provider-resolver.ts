import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { access, lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import { sha256DigestSchema, type ProviderId, type Sha256Digest } from "@agentlab/contracts";
import { z } from "zod";

import type {
  FactoryAgentProviderResolver,
  ResolvedFactoryAgentProvider
} from "../../domain/factory-agent-executor.js";
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
    await assertCanonicalExecutable(binding.executable);
    if ((await executableDigest(binding.executable)) !== binding.executableDigest) {
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

async function assertCanonicalExecutable(path: string): Promise<void> {
  if ((await realpath(path)) !== path) {
    throw new Error("Pinned factory provider executable must be canonical and symlink-free.");
  }
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error("Pinned factory provider executable must be a real file.");
  }
  await access(path, constants.X_OK);
}

async function executableDigest(path: string): Promise<Sha256Digest> {
  const before = await lstat(path, { bigint: true });
  if (before.size < 1n || before.size > 1_073_741_824n) {
    throw new Error("Pinned factory provider executable has an unsafe size.");
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat({ bigint: true });
    if (!sameFile(before, opened)) {
      throw new Error("Pinned factory provider executable changed while it was opened.");
    }
    const hash = createHash("sha256");
    const stream = handle.createReadStream({ autoClose: false });
    for await (const chunk of stream as AsyncIterable<Buffer>) hash.update(chunk);
    const after = await handle.stat({ bigint: true });
    if (!sameFile(opened, after)) {
      throw new Error("Pinned factory provider executable changed while it was hashed.");
    }
    return sha256DigestSchema.parse(`sha256:${hash.digest("hex")}`);
  } finally {
    await handle.close();
  }
}

function sameFile(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function providerVersion(stdout: string, stderr: string): string | null {
  const lines = `${stdout}\n${stderr}`
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.find((line) => !line.toLowerCase().startsWith("mise ")) ?? lines[0] ?? null;
}
