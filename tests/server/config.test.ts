import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadConfig } from "../../apps/server/src/config.js";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "agent-orchestrator-config-"));
  temporaryRoots.push(root);
  return root;
}

describe("application configuration", () => {
  it("resolves the workspace and creates the database directory", () => {
    const root = temporaryRoot();
    const workspace = join(root, "workspace");
    mkdirSync(workspace);

    const config = loadConfig(
      {
        AO_PORT: "5432",
        AO_WORKSPACE: workspace,
        AO_DATABASE_PATH: "state/conversations.sqlite"
      },
      root
    );

    expect(config).toEqual({
      host: "127.0.0.1",
      port: 5432,
      workspace,
      databasePath: join(root, "state", "conversations.sqlite")
    });
  });

  it("rejects invalid ports", () => {
    expect(() => loadConfig({ AO_PORT: "80" }, temporaryRoot())).toThrow(/AO_PORT/u);
  });

  it("accepts port zero for an ephemeral desktop server", () => {
    expect(loadConfig({ AO_PORT: "0" }, temporaryRoot()).port).toBe(0);
  });

  it("rejects a workspace that is not a directory", () => {
    const root = temporaryRoot();
    const workspace = join(root, "file.txt");
    writeFileSync(workspace, "not a directory");

    expect(() => loadConfig({ AO_WORKSPACE: workspace }, root)).toThrow(
      /must resolve to a directory/u
    );
  });
});
