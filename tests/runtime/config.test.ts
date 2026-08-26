import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadLocalConfig } from "../../packages/runtime/src/local-config.js";

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
});
