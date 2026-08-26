import { access, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { constants } from "node:fs";

import type { ProviderId } from "@orchestrator/contracts";

import type { CommandRunner } from "../process/command-runner.js";

const ENVIRONMENT_KEYS: Record<ProviderId, string> = {
  codex: "AO_CODEX_BIN",
  claude: "AO_CLAUDE_BIN",
  opencode: "AO_OPENCODE_BIN"
};

/** Finds executable provider candidates without shell evaluation. */
export class BinaryLocator {
  public constructor(
    private readonly runner: CommandRunner,
    private readonly environment: NodeJS.ProcessEnv = process.env,
    private readonly userHome: string = homedir()
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

    const usable: string[] = [];
    for (const candidate of new Set(candidates)) {
      try {
        await access(candidate, constants.X_OK);
        usable.push(candidate);
      } catch {
        // A stale shim or configured path is not a usable provider.
      }
    }
    return [...new Set(usable)];
  }

  private async miseCandidates(provider: ProviderId): Promise<readonly string[]> {
    const installRoot = join(this.userHome, ".local", "share", "mise", "installs", provider);

    try {
      const entries = await readdir(installRoot, { withFileTypes: true });
      return entries
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
