import { constants } from "node:fs";
import { access, lstat, realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import type { ProviderId } from "@agentlab/contracts";

import type { FactoryAgentProviderResolver } from "../../domain/factory-agent-executor.js";
import type { FactoryGateDefinition } from "../../domain/factory-gate.js";
import type {
  FactoryWorkerHostInspection,
  FactoryWorkerHostInspector
} from "../../domain/factory-worker-host.js";
import type { CommandRunner } from "./command-runner.js";
import { systemdUserManagerEnvironment } from "./systemd-user-manager.js";

const probeEnvironment = Object.freeze({
  CI: "true",
  LC_ALL: "C",
  NO_COLOR: "1",
  PATH: "/usr/local/bin:/usr/bin:/bin",
  TERM: "dumb"
});
const maximumProbeOutputBytes = 32 * 1_024;
const probeTimeoutMs = 5_000;

type WorkerProviderId = Extract<ProviderId, "codex" | "claude">;

export interface LocalFactoryWorkerHostInspectorOptions {
  readonly workingDirectory: string;
  readonly artifactRoot: string;
  readonly workspaceRoot: string;
  readonly gitExecutable: string;
  readonly flockExecutable: string;
  readonly systemdRunExecutable: string;
  readonly systemdControlExecutable: string;
  readonly environmentExecutable: string;
  readonly systemdVersion: string;
  readonly bubblewrapExecutable: string;
  readonly runtimeRoots: readonly string[];
  readonly gates: readonly FactoryGateDefinition[];
  readonly configuredProviders: readonly WorkerProviderId[];
  readonly providers: FactoryAgentProviderResolver;
  readonly hostEnvironment?: NodeJS.ProcessEnv;
}

/** Probes only owner-pinned local tools with fixed argv and a credentialless environment. */
export class LocalFactoryWorkerHostInspector implements FactoryWorkerHostInspector {
  readonly #workingDirectory: string;
  readonly #ownedRoots: readonly { readonly reasonCode: string; readonly path: string }[];
  readonly #fixedProbes: readonly FixedProbe[];
  readonly #systemdProbes: readonly FixedProbe[];
  readonly #runtimeRoots: readonly string[];
  readonly #gateExecutables: readonly { readonly id: string; readonly executable: string }[];
  readonly #configuredProviders: readonly WorkerProviderId[];
  readonly #providers: FactoryAgentProviderResolver;
  readonly #systemdControlExecutable: string;
  readonly #systemdEnvironment: Readonly<Record<string, string>>;
  readonly #systemdManagerVersion: string;

  public constructor(
    private readonly runner: CommandRunner,
    options: LocalFactoryWorkerHostInspectorOptions
  ) {
    this.#workingDirectory = safeAbsolutePath(options.workingDirectory, "working directory");
    this.#ownedRoots = [
      {
        reasonCode: "artifact-root-unavailable",
        path: safeAbsolutePath(options.artifactRoot, "artifact root")
      },
      {
        reasonCode: "workspace-root-unavailable",
        path: safeAbsolutePath(options.workspaceRoot, "worktree root")
      }
    ];
    this.#fixedProbes = [
      {
        reasonCode: "git-unavailable",
        executable: safeAbsolutePath(options.gitExecutable, "Git executable")
      },
      {
        reasonCode: "flock-unavailable",
        executable: safeAbsolutePath(options.flockExecutable, "flock executable")
      },
      {
        reasonCode: "environment-executable-unavailable",
        executable: safeAbsolutePath(options.environmentExecutable, "env executable")
      },
      {
        reasonCode: "bubblewrap-unavailable",
        executable: safeAbsolutePath(options.bubblewrapExecutable, "Bubblewrap executable")
      }
    ];
    this.#systemdProbes = [
      {
        reasonCode: "systemd-run-identity-unverified",
        executable: safeAbsolutePath(options.systemdRunExecutable, "systemd-run executable"),
        expectedVersion: safeVersion(options.systemdVersion)
      },
      {
        reasonCode: "systemctl-identity-unverified",
        executable: safeAbsolutePath(options.systemdControlExecutable, "systemctl executable"),
        expectedVersion: safeVersion(options.systemdVersion)
      }
    ];
    this.#systemdControlExecutable = safeAbsolutePath(
      options.systemdControlExecutable,
      "systemctl executable"
    );
    this.#systemdEnvironment = systemdUserManagerEnvironment(
      options.hostEnvironment ?? process.env
    );
    this.#systemdManagerVersion = systemdManagerVersion(options.systemdVersion);
    if (options.runtimeRoots.length > 8) {
      throw new Error("Factory worker host inspection accepts at most eight runtime roots.");
    }
    this.#runtimeRoots = options.runtimeRoots.map((path) => safeAbsolutePath(path, "runtime root"));
    this.#gateExecutables = options.gates.map(({ id, command }) => ({
      id: safeIdentifier(id, "gate ID"),
      executable: safeAbsolutePath(command.executable, "gate executable")
    }));
    this.#configuredProviders = validatedProviders(options.configuredProviders);
    this.#providers = options.providers;
  }

  public async inspect(): Promise<FactoryWorkerHostInspection> {
    const checks: Promise<string | null>[] = [
      reasonOnFailure("working-directory-unavailable", () =>
        assertCanonicalDirectory(this.#workingDirectory)
      ),
      ...this.#ownedRoots.map(({ reasonCode, path }) =>
        reasonOnFailure(reasonCode, () => assertOwnerOnlyDirectory(path))
      ),
      ...this.#fixedProbes.map((probe) =>
        reasonOnFailure(probe.reasonCode, () => this.#probe(probe))
      ),
      ...this.#systemdProbes.map((probe) =>
        reasonOnFailure(probe.reasonCode, () => this.#probe(probe))
      ),
      reasonOnFailure("systemd-user-manager-identity-unverified", () => this.#probeUserManager()),
      ...this.#runtimeRoots.map((path, index) =>
        reasonOnFailure(`runtime-root-${String(index)}-unavailable`, () =>
          assertCanonicalDirectory(path)
        )
      ),
      ...this.#gateExecutables.map(({ id, executable }) =>
        reasonOnFailure(`gate-${id}-executable-unavailable`, () =>
          assertCanonicalExecutable(executable)
        )
      ),
      ...this.#configuredProviders.map((provider) =>
        reasonOnFailure(`provider-${provider}-unavailable`, async () => {
          if ((await this.#providers.resolve(provider, this.#workingDirectory)) === null) {
            throw new Error(`Configured provider ${provider} did not resolve.`);
          }
        })
      )
    ];
    const reasonCodes = (await Promise.all(checks))
      .filter((reason): reason is string => reason !== null)
      .sort();
    return {
      status: reasonCodes.length === 0 ? "ready" : "blocked",
      reasonCodes
    };
  }

  async #probe(probe: FixedProbe): Promise<void> {
    await assertCanonicalExecutable(probe.executable);
    const output = await this.runner.run(probe.executable, ["--version"], {
      cwd: this.#workingDirectory,
      timeoutMs: probeTimeoutMs,
      maxBufferBytes: maximumProbeOutputBytes,
      maxCombinedBufferBytes: maximumProbeOutputBytes,
      cleanupProcessTree: true,
      environment: probeEnvironment
    });
    if (
      probe.expectedVersion !== undefined &&
      firstOutputLine(output.stdout, output.stderr) !== probe.expectedVersion
    ) {
      throw new Error("Pinned systemd version does not match the installed executable.");
    }
  }

  async #probeUserManager(): Promise<void> {
    const output = await this.runner.run(
      this.#systemdControlExecutable,
      ["--user", "show", "--property=Version", "--value"],
      {
        cwd: this.#workingDirectory,
        timeoutMs: probeTimeoutMs,
        maxBufferBytes: maximumProbeOutputBytes,
        maxCombinedBufferBytes: maximumProbeOutputBytes,
        cleanupProcessTree: true,
        environment: { ...probeEnvironment, ...this.#systemdEnvironment }
      }
    );
    if (firstOutputLine(output.stdout, output.stderr) !== this.#systemdManagerVersion) {
      throw new Error("Factory worker systemd user manager has another version identity.");
    }
  }
}

interface FixedProbe {
  readonly reasonCode: string;
  readonly executable: string;
  readonly expectedVersion?: string;
}

async function reasonOnFailure(
  reasonCode: string,
  operation: () => Promise<void>
): Promise<string | null> {
  try {
    await operation();
    return null;
  } catch {
    return reasonCode;
  }
}

async function assertCanonicalExecutable(path: string): Promise<void> {
  if ((await realpath(path)) !== path) throw new Error("Executable path is not canonical.");
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error("Executable path is not a real file.");
  }
  await access(path, constants.X_OK);
}

async function assertCanonicalDirectory(path: string): Promise<void> {
  if ((await realpath(path)) !== path) throw new Error("Directory path is not canonical.");
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("Directory path is not a real directory.");
  }
}

async function assertOwnerOnlyDirectory(path: string): Promise<void> {
  await assertCanonicalDirectory(path);
  const metadata = await lstat(path);
  const currentUserId = process.getuid?.();
  if (
    (currentUserId !== undefined && metadata.uid !== currentUserId) ||
    (metadata.mode & 0o077) !== 0
  ) {
    throw new Error("Worker-owned directory is not owner-only.");
  }
}

function safeAbsolutePath(value: string, label: string): string {
  if (
    !isAbsolute(value) ||
    value.includes("\0") ||
    Buffer.byteLength(value) > 4_096 ||
    resolve(value) !== value
  ) {
    throw new Error(`Factory worker ${label} must be a normalized absolute path.`);
  }
  return value;
}

function safeVersion(value: string): string {
  const version = value.trim();
  if (version.length < 1 || version.length > 180 || /[\0\r\n]/u.test(version)) {
    throw new Error("Factory worker systemd version is invalid.");
  }
  return version;
}

function systemdManagerVersion(value: string): string {
  const version = safeVersion(value);
  const match = /^systemd ([^ ()]+)(?: \(([^()]+)\))?$/u.exec(version);
  const managerVersion = match?.[2] ?? match?.[1];
  if (managerVersion === undefined) {
    throw new Error("Factory worker systemd version must be an exact systemd identity line.");
  }
  return managerVersion;
}

function safeIdentifier(value: string, label: string): string {
  if (!/^[a-z0-9][a-z0-9._/-]{0,127}$/u.test(value)) {
    throw new Error(`Factory worker ${label} is invalid.`);
  }
  return value;
}

function validatedProviders(input: readonly WorkerProviderId[]): readonly WorkerProviderId[] {
  if (input.length < 1 || input.length > 2 || new Set(input).size !== input.length) {
    throw new Error("Factory worker host providers must be unique supported IDs.");
  }
  return [...input];
}

function firstOutputLine(stdout: string, stderr: string): string | null {
  return (
    `${stdout}\n${stderr}`
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .find(Boolean) ?? null
  );
}
