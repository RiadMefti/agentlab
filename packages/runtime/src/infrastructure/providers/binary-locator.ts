import { access, readdir } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { constants } from "node:fs";

import type { ProviderId } from "@agentlab/contracts";

import type { CommandRunner } from "../process/command-runner.js";
import { withTimeout } from "../../domain/promise-timeout.js";

const FILESYSTEM_PROBE_TIMEOUT_MS = 1_000;
const MAX_FILESYSTEM_CANDIDATES = 32;
const MAX_MISE_INSTALL_ENTRIES = 4_096;

export interface BinaryLocatorFilesystem {
  access(path: string, mode?: number): Promise<void>;
  readdir(path: string, options: { readonly withFileTypes: true }): Promise<Dirent[]>;
}

export interface BinaryLocatorOptions {
  readonly filesystemTimeoutMs?: number;
  readonly filesystem?: BinaryLocatorFilesystem;
}

const ENVIRONMENT_KEYS: Record<ProviderId, string> = {
  codex: "AGENTLAB_CODEX_BIN",
  claude: "AGENTLAB_CLAUDE_BIN",
  opencode: "AGENTLAB_OPENCODE_BIN"
};

/** Finds executable provider candidates without shell evaluation. */
export class BinaryLocator {
  public constructor(
    private readonly runner: CommandRunner,
    private readonly environment: NodeJS.ProcessEnv = process.env,
    private readonly userHome: string = homedir(),
    private readonly options: BinaryLocatorOptions = {}
  ) {}

  public async candidates(provider: ProviderId): Promise<readonly string[]> {
    const candidates: string[] = [];
    const configured = this.environment[ENVIRONMENT_KEYS[provider]];
    if (configured !== undefined && configured.trim() !== "") {
      if (!isAbsolute(configured)) {
        throw new Error(`${ENVIRONMENT_KEYS[provider]} must be an absolute path.`);
      }
      candidates.push(configured);
    }

    try {
      const { stdout } = await this.runner.run("which", [provider], {
        timeoutMs: 2_000
      });
      const discovered = stdout.trim();
      if (discovered !== "") candidates.push(discovered);
    } catch {
      // Missing from PATH is expected; mise is checked next.
    }

    candidates.push(...(await this.miseCandidates(provider)));

    const filesystem = this.options.filesystem ?? { access, readdir };
    const uniqueCandidates = [...new Set(candidates)].slice(0, MAX_FILESYSTEM_CANDIDATES);
    const checked = await Promise.all(
      uniqueCandidates.map(async (candidate) => {
        try {
          await withTimeout(filesystem.access(candidate, constants.X_OK), {
            timeoutMs: this.options.filesystemTimeoutMs ?? FILESYSTEM_PROBE_TIMEOUT_MS,
            message: `Executable probe timed out for ${candidate}.`
          });
          return candidate;
        } catch {
          // A stale, inaccessible, or stalled path is not a usable provider.
          return null;
        }
      })
    );
    return checked.filter((candidate): candidate is string => candidate !== null);
  }

  private async miseCandidates(provider: ProviderId): Promise<readonly string[]> {
    const installRoot = join(this.userHome, ".local", "share", "mise", "installs", provider);

    try {
      const filesystem = this.options.filesystem ?? { access, readdir };
      const entries = await withTimeout(filesystem.readdir(installRoot, { withFileTypes: true }), {
        timeoutMs: this.options.filesystemTimeoutMs ?? FILESYSTEM_PROBE_TIMEOUT_MS,
        message: "mise install discovery timed out."
      });
      return entries
        .slice(0, MAX_MISE_INSTALL_ENTRIES)
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }))
        .flatMap((version) => [
          join(installRoot, version, "bin", provider),
          join(installRoot, version, provider)
        ]);
    } catch {
      return [];
    }
  }
}
