import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type {
  CommandRunner,
  RunResult
} from "../../packages/runtime/src/infrastructure/process/command-runner.js";
import { BinaryLocator } from "../../packages/runtime/src/infrastructure/providers/binary-locator.js";

const temporaryRoots: string[] = [];
const unavailableRunner: CommandRunner = {
  run(): Promise<RunResult> {
    return Promise.reject(new Error("not found"));
  }
};

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

function executable(path: string): string {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, "#!/bin/sh\nexit 0\n");
  chmodSync(path, 0o755);
  return realpathSync(path);
}

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "agentlab-bin-"));
  temporaryRoots.push(root);
  return root;
}

describe("BinaryLocator", () => {
  it("requires configured overrides to be absolute", async () => {
    const locator = new BinaryLocator(unavailableRunner, { AGENTLAB_CODEX_BIN: "relative/codex" });
    await expect(locator.candidates("codex")).rejects.toThrow(/must be an absolute path/u);
  });

  it("uses an executable discovered on PATH", async () => {
    const root = temporaryRoot();
    const path = executable(join(root, "codex"));
    const runner: CommandRunner = {
      run(): Promise<RunResult> {
        return Promise.resolve({ stdout: `${path}\n`, stderr: "" });
      }
    };

    await expect(new BinaryLocator(runner, {}, root).candidates("codex")).resolves.toEqual([path]);
  });

  it("preserves a symlink entrypoint used by dispatching shims", async () => {
    const root = temporaryRoot();
    const target = executable(join(root, "provider-multiplexer"));
    const shim = join(root, "codex");
    symlinkSync(target, shim);
    const runner: CommandRunner = {
      run(): Promise<RunResult> {
        return Promise.resolve({ stdout: `${shim}\n`, stderr: "" });
      }
    };

    await expect(new BinaryLocator(runner, {}, root).candidates("codex")).resolves.toEqual([shim]);
  });

  it("discovers mise installs newest first", async () => {
    const root = temporaryRoot();
    const older = executable(join(root, ".local/share/mise/installs/codex/1.9.0/bin/codex"));
    const newer = executable(join(root, ".local/share/mise/installs/codex/1.10.0/bin/codex"));

    await expect(
      new BinaryLocator(unavailableRunner, {}, root).candidates("codex")
    ).resolves.toEqual([newer, older]);
  });
});
