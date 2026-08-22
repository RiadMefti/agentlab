import { describe, expect, it, vi } from "vitest";

import type {
  CommandRunner,
  RunResult
} from "../../apps/server/src/infrastructure/process/command-runner.js";
import { codexCaptainLauncher } from "../../apps/server/src/infrastructure/providers/captain-launchers.js";
import {
  LocalProviderCatalog,
  type ProviderBinaryLocator
} from "../../apps/server/src/infrastructure/providers/local-provider-catalog.js";

describe("LocalProviderCatalog", () => {
  it("reports and resolves an installed CLI while caching its version probe", async () => {
    const locator: ProviderBinaryLocator = {
      candidates: vi.fn(() => Promise.resolve(["/opt/codex"]))
    };
    const run = vi.fn<CommandRunner["run"]>(() =>
      Promise.resolve({
        stdout: "mise ~/.config/mise/config.toml tools: codex@1.2.3\ncodex-cli 1.2.3\n",
        stderr: ""
      })
    );
    const catalog = new LocalProviderCatalog(
      [codexCaptainLauncher],
      locator,
      { run },
      5_000,
      () => 100
    );

    await expect(catalog.list()).resolves.toEqual([
      expect.objectContaining({
        id: "codex",
        available: true,
        version: "codex-cli 1.2.3",
        reason: null
      })
    ]);
    await expect(catalog.resolveCaptain("codex")).resolves.toMatchObject({
      executable: "/opt/codex",
      version: "codex-cli 1.2.3",
      launcher: codexCaptainLauncher
    });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("reports a missing CLI without failing the provider list", async () => {
    const locator: ProviderBinaryLocator = {
      candidates: () => Promise.resolve([])
    };
    const runner: CommandRunner = {
      run(): Promise<RunResult> {
        throw new Error("Version probing should not run without a candidate.");
      }
    };
    const catalog = new LocalProviderCatalog([codexCaptainLauncher], locator, runner);

    await expect(catalog.list()).resolves.toEqual([
      expect.objectContaining({
        id: "codex",
        available: false,
        version: null,
        reason: "Executable not found."
      })
    ]);
    await expect(catalog.resolveCaptain("codex")).resolves.toBeNull();
  });
});
