import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadLocalConfig } from "../../packages/runtime/src/infrastructure/filesystem/local-config.js";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "agentlab-config-"));
  temporaryRoots.push(root);
  return root;
}

describe("local application configuration", () => {
  it("creates the database directory without selecting a workspace", () => {
    const root = temporaryRoot();
    const config = loadLocalConfig({ AGENTLAB_DATABASE_PATH: "state/conversations.sqlite" }, root);

    expect(config).toEqual({ databasePath: join(root, "state", "conversations.sqlite") });
    expect(existsSync(join(root, "state"))).toBe(true);
  });

  it("uses the XDG data directory by default", () => {
    const root = temporaryRoot();
    const dataHome = join(root, "data");

    expect(loadLocalConfig({ XDG_DATA_HOME: dataHome }, root).databasePath).toBe(
      join(dataHome, "agentlab", "agentlab.sqlite")
    );
  });

  it("uses the standard data home when XDG_DATA_HOME is absent", () => {
    const root = temporaryRoot();
    expect(loadLocalConfig({ HOME: root }, root).databasePath).toBe(
      join(root, ".local", "share", "agentlab", "agentlab.sqlite")
    );
  });

  it("rejects empty, URI, null-byte, and oversized explicit database targets", () => {
    const root = temporaryRoot();

    expect(() => loadLocalConfig({ AGENTLAB_DATABASE_PATH: "" }, root)).toThrow("cannot be empty");
    expect(() =>
      loadLocalConfig({ AGENTLAB_DATABASE_PATH: "file:state.sqlite?mode=rwc" }, root)
    ).toThrow("SQLite URI");
    expect(() => loadLocalConfig({ AGENTLAB_DATABASE_PATH: "bad\0path" }, root)).toThrow(
      "null bytes"
    );
    expect(() => loadLocalConfig({ AGENTLAB_DATABASE_PATH: "x".repeat(4_097) }, root)).toThrow(
      "4096-byte"
    );
  });

  it("requires absolute non-empty HOME and XDG data paths", () => {
    const root = temporaryRoot();

    expect(() => loadLocalConfig({ HOME: "" }, root)).toThrow("HOME cannot be empty");
    expect(() => loadLocalConfig({ HOME: "relative" }, root)).toThrow(
      "HOME must be an absolute path"
    );
    expect(() => loadLocalConfig({ XDG_DATA_HOME: "relative", HOME: root }, root)).toThrow(
      "XDG_DATA_HOME must be an absolute path"
    );
  });
});
