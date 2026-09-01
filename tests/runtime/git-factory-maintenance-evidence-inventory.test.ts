import { describe, expect, it } from "vitest";

import { GitFactoryMaintenanceEvidenceInventory } from "../../packages/runtime/src/infrastructure/filesystem/git-factory-maintenance-evidence-inventory.js";
import type {
  CommandRunner,
  RunOptions,
  RunResult
} from "../../packages/runtime/src/infrastructure/process/command-runner.js";

describe("GitFactoryMaintenanceEvidenceInventory", () => {
  it("lists tracked paths from one exact revision with fixed argv", async () => {
    const runner = new InventoryRunner("README.md\0docs/factory-operations.md\0");
    const inventory = new GitFactoryMaintenanceEvidenceInventory(runner, {
      gitExecutable: "/usr/bin/git",
      flockExecutable: "/usr/bin/flock"
    });

    await expect(inventory.trackedPaths("/work/agentlab", "a".repeat(40))).resolves.toEqual(
      new Set(["README.md", "docs/factory-operations.md"])
    );
    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]).toMatchObject({
      executable: "/usr/bin/git",
      args: [
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "core.fsmonitor=false",
        "-c",
        "core.untrackedCache=false",
        "-C",
        "/work/agentlab",
        "ls-tree",
        "-r",
        "--name-only",
        "-z",
        "a".repeat(40),
        "--"
      ]
    });
  });

  it("rejects malformed revisions, paths, duplicate output, and truncated output", async () => {
    const inventory = (output: string) =>
      new GitFactoryMaintenanceEvidenceInventory(new InventoryRunner(output), {
        gitExecutable: "/usr/bin/git",
        flockExecutable: "/usr/bin/flock"
      });

    await expect(inventory("README.md\0").trackedPaths("/work/agentlab", "main")).rejects.toThrow();
    await expect(
      inventory("../outside\0").trackedPaths("/work/agentlab", "a".repeat(40))
    ).rejects.toThrow();
    await expect(
      inventory("README.md\0README.md\0").trackedPaths("/work/agentlab", "a".repeat(40))
    ).rejects.toThrow(/duplicate/u);
    await expect(
      inventory("README.md").trackedPaths("/work/agentlab", "a".repeat(40))
    ).rejects.toThrow(/truncated/u);
  });
});

class InventoryRunner implements CommandRunner {
  public readonly calls: {
    readonly executable: string;
    readonly args: readonly string[];
    readonly options: RunOptions;
  }[] = [];

  public constructor(private readonly stdout: string) {}

  public run(
    executable: string,
    args: readonly string[],
    options: RunOptions = {}
  ): Promise<RunResult> {
    this.calls.push({ executable, args, options });
    return Promise.resolve({ stdout: this.stdout, stderr: "" });
  }
}
