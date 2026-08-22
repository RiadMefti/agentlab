import { describe, expect, it } from "vitest";

import { withDesktopDefaults } from "../../apps/desktop/src/desktop-environment.js";

describe("desktop server environment", () => {
  const paths = {
    appPath: "/opt/orchestrator",
    isPackaged: true,
    userDataPath: "/home/user/.config/orchestrator"
  } as const;

  it("uses an ephemeral port and writable packaged database by default", () => {
    expect(withDesktopDefaults({}, paths)).toMatchObject({
      AO_PORT: "0",
      AO_DATABASE_PATH: "/home/user/.config/orchestrator/orchestrator.sqlite"
    });
  });

  it("keeps explicit server configuration", () => {
    expect(
      withDesktopDefaults({ AO_PORT: "5432", AO_DATABASE_PATH: "/tmp/custom.sqlite" }, paths)
    ).toMatchObject({
      AO_PORT: "5432",
      AO_DATABASE_PATH: "/tmp/custom.sqlite"
    });
  });

  it("reuses the browser database during local development", () => {
    expect(withDesktopDefaults({}, { ...paths, isPackaged: false })).toMatchObject({
      AO_DATABASE_PATH: "/opt/orchestrator/apps/server/.data/orchestrator.sqlite"
    });
  });
});
