import { readdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs", async (importOriginal) => {
  const filesystem = await importOriginal<typeof import("node:fs")>();
  return {
    ...filesystem,
    fchmodSync(fd: number, mode: number): void {
      if (filesystem.fstatSync(fd).isFile()) {
        throw Object.assign(new Error("injected post-open permission failure"), { code: "EPERM" });
      }
      filesystem.fchmodSync(fd, mode);
    }
  };
});

import { openNativeDiagnosticsLog } from "../../apps/tui/src/bootstrap/native-diagnostics.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true }))
  );
});

describe.skipIf(process.platform !== "linux")("native diagnostics post-open failure", () => {
  it("closes the descriptor and removes the active artifact", async () => {
    const state = await mkdtemp(join(tmpdir(), "agentlab-diagnostics-open-failure-"));
    temporaryDirectories.push(state);
    const descriptorsBefore = readdirSync("/proc/self/fd").length;

    expect(() => openNativeDiagnosticsLog({ ...process.env, XDG_STATE_HOME: state })).toThrow(
      /injected post-open permission failure/u
    );

    expect(readdirSync("/proc/self/fd")).toHaveLength(descriptorsBefore);
    const directory = join(state, "agentlab", "logs");
    expect(readdirSync(directory).filter((name) => name.endsWith(".active"))).toEqual([]);
  });
});
