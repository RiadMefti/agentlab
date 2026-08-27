import { readFileSync, readdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const injection = vi.hoisted<{ mode: "fchmod" | "first-fstat" | "none" }>(() => ({
  mode: "none"
}));

vi.mock("node:fs", async (importOriginal) => {
  const filesystem = await importOriginal<typeof import("node:fs")>();
  return {
    ...filesystem,
    fstatSync(fd: number) {
      const metadata = filesystem.fstatSync(fd);
      if (injection.mode === "first-fstat" && metadata.isFile()) {
        injection.mode = "none";
        const activePath = filesystem.readlinkSync(`/proc/self/fd/${String(fd)}`);
        filesystem.renameSync(activePath, `${activePath}.opened-aside`);
        filesystem.writeFileSync(activePath, "UNRELATED_REPLACEMENT");
        throw new Error("injected first fstat failure");
      }
      return metadata;
    },
    fchmodSync(fd: number, mode: number): void {
      if (injection.mode === "fchmod" && filesystem.fstatSync(fd).isFile()) {
        injection.mode = "none";
        throw Object.assign(new Error("injected post-open permission failure"), { code: "EPERM" });
      }
      filesystem.fchmodSync(fd, mode);
    }
  };
});

import { openNativeDiagnosticsLog } from "../../apps/tui/src/bootstrap/native-diagnostics.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  injection.mode = "none";
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true }))
  );
});

describe.skipIf(process.platform !== "linux")("native diagnostics post-open failure", () => {
  it("leaves a replacement alone when the first descriptor identity check fails", async () => {
    const state = await mkdtemp(join(tmpdir(), "agentlab-diagnostics-first-fstat-failure-"));
    temporaryDirectories.push(state);
    const descriptorsBefore = readdirSync("/proc/self/fd").length;
    injection.mode = "first-fstat";

    expect(() => openNativeDiagnosticsLog({ ...process.env, XDG_STATE_HOME: state })).toThrow(
      /injected first fstat failure/u
    );

    expect(readdirSync("/proc/self/fd")).toHaveLength(descriptorsBefore);
    const directory = join(state, "agentlab", "logs");
    const active = readdirSync(directory).find((name) => name.endsWith(".active"));
    expect(active).toBeDefined();
    expect(readFileSync(join(directory, active ?? "missing"), "utf8")).toBe(
      "UNRELATED_REPLACEMENT"
    );
    expect(readdirSync(directory).some((name) => name.endsWith(".opened-aside"))).toBe(true);
  });

  it("closes the descriptor and removes the same-inode artifact after fchmod fails", async () => {
    const state = await mkdtemp(join(tmpdir(), "agentlab-diagnostics-open-failure-"));
    temporaryDirectories.push(state);
    const descriptorsBefore = readdirSync("/proc/self/fd").length;
    injection.mode = "fchmod";

    expect(() => openNativeDiagnosticsLog({ ...process.env, XDG_STATE_HOME: state })).toThrow(
      /injected post-open permission failure/u
    );

    expect(readdirSync("/proc/self/fd")).toHaveLength(descriptorsBefore);
    const directory = join(state, "agentlab", "logs");
    expect(readdirSync(directory).filter((name) => name.endsWith(".active"))).toEqual([]);
  });
});
