import { isAbsolute } from "node:path";

import { z } from "zod";

import type { FactoryEvalProcessRecovery } from "../../domain/factory-eval-harness.js";
import type { CommandRunner } from "./command-runner.js";
import { factorySystemdScopeName, systemdUserManagerEnvironment } from "./systemd-user-manager.js";

const maximumOutputBytes = 4_096;

/** Confirms the exact journal-bound transient scope is dead before terminal crash recovery. */
export class SystemdFactoryEvalProcessRecovery implements FactoryEvalProcessRecovery {
  readonly #executable: string;
  readonly #environment: Readonly<Record<string, string>>;

  public constructor(
    private readonly runner: CommandRunner,
    options: { readonly executable: string; readonly hostEnvironment?: NodeJS.ProcessEnv }
  ) {
    if (!isAbsolute(options.executable) || options.executable.includes("\0")) {
      throw new Error("Eval systemctl executable must be an absolute safe path.");
    }
    this.#executable = options.executable;
    this.#environment = systemdUserManagerEnvironment(options.hostEnvironment ?? process.env);
  }

  public async state(executionIdInput: string): Promise<"active" | "inactive" | "uncertain"> {
    const executionId = z.uuid().parse(executionIdInput);
    try {
      const result = await this.runner.run(
        this.#executable,
        [
          "--user",
          "show",
          factorySystemdScopeName(executionId),
          "--property=LoadState",
          "--property=ActiveState",
          "--property=SubState",
          "--no-pager"
        ],
        {
          timeoutMs: 10_000,
          maxBufferBytes: maximumOutputBytes,
          maxCombinedBufferBytes: maximumOutputBytes,
          cleanupProcessTree: true,
          environment: this.#environment
        }
      );
      const values = properties(result.stdout);
      if (values === null || (values.LoadState !== "loaded" && values.LoadState !== "not-found")) {
        return "uncertain";
      }
      return values.ActiveState === "inactive" && values.SubState === "dead"
        ? "inactive"
        : "active";
    } catch {
      return "uncertain";
    }
  }
}

function properties(value: string): Readonly<Record<string, string>> | null {
  const result: Record<string, string> = {};
  for (const line of value.split("\n")) {
    if (line.length === 0) continue;
    const separator = line.indexOf("=");
    if (separator < 1) return null;
    result[line.slice(0, separator)] = line.slice(separator + 1);
  }
  return result;
}
