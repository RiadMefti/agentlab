import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  const root = mkdtempSync(join(tmpdir(), "agent-orchestrator-config-"));
  temporaryRoots.push(root);
  return root;
}

describe("local application configuration", () => {
  it("creates the database directory without selecting a workspace", () => {
    const root = temporaryRoot();
    const workspace = join(root, "workspace");
    mkdirSync(workspace);

    const config = loadLocalConfig(
      {
        AO_WORKSPACE: workspace,
        AO_DATABASE_PATH: "state/conversations.sqlite"
      },
      root
    );

    expect(config).toEqual({ databasePath: join(root, "state", "conversations.sqlite") });
  });

  it("uses the XDG data directory by default", () => {
    const root = temporaryRoot();
    const workspace = join(root, "workspace");
    const dataHome = join(root, "data");
    mkdirSync(workspace);

    expect(
      loadLocalConfig({ AO_WORKSPACE: workspace, XDG_DATA_HOME: dataHome }, root).databasePath
    ).toBe(join(dataHome, "agent-orchestrator", "orchestrator.sqlite"));
  });

  it("adopts an existing desktop database only when the new default is absent", () => {
    const root = temporaryRoot();
    const workspace = join(root, "workspace");
    const dataHome = join(root, "data");
    const configHome = join(root, "config");
    const legacyDirectory = join(configHome, "Orchestrator");
    const legacyDatabase = join(legacyDirectory, "orchestrator.sqlite");
    mkdirSync(workspace);
    mkdirSync(legacyDirectory, { recursive: true });
    writeFileSync(legacyDatabase, "legacy");

    const migrated = loadLocalConfig(
      {
        AO_WORKSPACE: workspace,
        HOME: root,
        XDG_CONFIG_HOME: configHome,
        XDG_DATA_HOME: dataHome
      },
      root
    );
    expect(migrated.databasePath).toBe(legacyDatabase);

    const preferredDatabase = join(dataHome, "agent-orchestrator", "orchestrator.sqlite");
    mkdirSync(join(dataHome, "agent-orchestrator"), { recursive: true });
    writeFileSync(preferredDatabase, "preferred");
    expect(
      loadLocalConfig(
        {
          AO_WORKSPACE: workspace,
          HOME: root,
          XDG_CONFIG_HOME: configHome,
          XDG_DATA_HOME: dataHome
        },
        root
      ).databasePath
    ).toBe(preferredDatabase);
  });

  it("does not treat AO_WORKSPACE as an implicit startup project", () => {
    const root = temporaryRoot();
    const workspace = join(root, "file.txt");
    writeFileSync(workspace, "not a directory");

    expect(() =>
      loadLocalConfig({ AO_WORKSPACE: workspace, XDG_DATA_HOME: join(root, "data") }, root)
    ).not.toThrow();
  });
});
