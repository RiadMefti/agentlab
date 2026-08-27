import { readFileSync, readdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const injection = vi.hoisted<{
  mode:
    | "close-failure"
    | "close-swap"
    | "fchmod"
    | "fchmod-swap"
    | "first-fstat"
    | "none"
    | "rename-failure";
}>(() => ({ mode: "none" }));

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
      if (
        (injection.mode === "fchmod" || injection.mode === "fchmod-swap") &&
        filesystem.fstatSync(fd).isFile()
      ) {
        if (injection.mode === "fchmod-swap") swapActivePath(filesystem, fd);
        injection.mode = "none";
        throw Object.assign(new Error("injected post-open permission failure"), { code: "EPERM" });
      }
      filesystem.fchmodSync(fd, mode);
    },
    closeSync(fd: number): void {
      const path = descriptorPath(filesystem, fd);
      if (path?.endsWith(".active") === true && injection.mode === "close-swap") {
        swapActivePath(filesystem, fd);
        injection.mode = "none";
      }
      if (path?.endsWith(".active") === true && injection.mode === "close-failure") {
        injection.mode = "none";
        filesystem.closeSync(fd);
        throw new Error("injected close failure");
      }
      filesystem.closeSync(fd);
    },
    renameSync(oldPath: string, newPath: string): void {
      if (
        injection.mode === "rename-failure" &&
        oldPath.endsWith(".active") &&
        newPath.endsWith(".log")
      ) {
        injection.mode = "none";
        throw new Error("injected rename failure");
      }
      filesystem.renameSync(oldPath, newPath);
    }
  };
});

function descriptorPath(filesystem: typeof import("node:fs"), fd: number): string | undefined {
  try {
    return filesystem.readlinkSync(`/proc/self/fd/${String(fd)}`);
  } catch {
    return undefined;
  }
}

function swapActivePath(filesystem: typeof import("node:fs"), fd: number): void {
  const activePath = descriptorPath(filesystem, fd);
  if (activePath === undefined) throw new Error("Missing injected active path.");
  filesystem.renameSync(activePath, `${activePath}.opened-aside`);
  filesystem.writeFileSync(activePath, "UNRELATED_REPLACEMENT");
}

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

  it("preserves a replacement swapped in after identity exists and before fchmod fails", async () => {
    const state = await temporaryState("fchmod-swap");
    const descriptorsBefore = readdirSync("/proc/self/fd").length;
    injection.mode = "fchmod-swap";

    expect(() => openNativeDiagnosticsLog({ ...process.env, XDG_STATE_HOME: state })).toThrow(
      /injected post-open permission failure/u
    );

    expect(readdirSync("/proc/self/fd")).toHaveLength(descriptorsBefore);
    expectReplacementPreserved(state);
  });

  it("does not finalize a replacement swapped in while closing the opened artifact", async () => {
    const state = await temporaryState("close-swap");
    const log = openNativeDiagnosticsLog({ ...process.env, XDG_STATE_HOME: state });
    const activePath = log.path;
    injection.mode = "close-swap";

    log.close();

    expect(log.path).toBe(activePath);
    expect(readFileSync(activePath, "utf8")).toBe("UNRELATED_REPLACEMENT");
    expect(readFileSync(`${activePath}.opened-aside`, "utf8")).toBe("");
  });

  it("leaves the active artifact recoverable when descriptor close fails", async () => {
    const state = await temporaryState("close-failure");
    const descriptorsBefore = readdirSync("/proc/self/fd").length;
    const log = openNativeDiagnosticsLog({ ...process.env, XDG_STATE_HOME: state });
    const activePath = log.path;
    injection.mode = "close-failure";

    log.close();

    expect(log.path).toBe(activePath);
    expect(readFileSync(activePath, "utf8")).toBe("");
    expect(readdirSync("/proc/self/fd")).toHaveLength(descriptorsBefore);
  });

  it("leaves the active artifact recoverable when final rename fails", async () => {
    const state = await temporaryState("rename-failure");
    const log = openNativeDiagnosticsLog({ ...process.env, XDG_STATE_HOME: state });
    const activePath = log.path;
    injection.mode = "rename-failure";

    log.close();

    expect(log.path).toBe(activePath);
    expect(readFileSync(activePath, "utf8")).toBe("");
  });
});

async function temporaryState(label: string): Promise<string> {
  const state = await mkdtemp(join(tmpdir(), `agentlab-diagnostics-${label}-`));
  temporaryDirectories.push(state);
  return state;
}

function expectReplacementPreserved(state: string): void {
  const directory = join(state, "agentlab", "logs");
  const active = readdirSync(directory).find((name) => name.endsWith(".active"));
  expect(active).toBeDefined();
  expect(readFileSync(join(directory, active ?? "missing"), "utf8")).toBe("UNRELATED_REPLACEMENT");
  expect(readdirSync(directory).some((name) => name.endsWith(".opened-aside"))).toBe(true);
}
