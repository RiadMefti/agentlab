import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const runLiveProof = process.env.AGENTLAB_RUN_FACTORY_ROLE_ISOLATION === "1";

/** Proves the existing private-store boundary, not successful cross-role factory operation. */
describe.skipIf(!runLiveProof)("factory storage OS-role isolation", () => {
  it("denies another UID direct storage access even after relaxing fixture database modes", () => {
    const fixture = fileURLToPath(
      new URL("../fixtures/probe-factory-role-storage.ts", import.meta.url)
    );
    const result = spawnSync(
      "/usr/bin/unshare",
      [
        "--user",
        "--map-root-user",
        "--map-auto",
        "--fork",
        "--kill-child",
        process.execPath,
        fixture
      ],
      {
        encoding: "utf8",
        timeout: 40_000,
        killSignal: "SIGKILL",
        maxBuffer: 1_048_576,
        env: { PATH: "/usr/bin:/bin", NODE_NO_WARNINGS: "1", TMPDIR: "/tmp" }
      }
    );

    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    const observation: unknown = JSON.parse(result.stdout);
    expect(observation).toMatchObject({
      producer: {
        userId: 1,
        groupId: 1,
        databaseMode: "600",
        leaseMode: "600",
        artifactRootMode: "700"
      },
      separated: {
        userId: 2,
        groupId: 1,
        lease: { accessible: false, code: "ERR_SQLITE_ERROR" },
        database: { accessible: false, code: "ERR_SQLITE_ERROR" },
        artifact: { accessible: false, code: "EPERM" }
      },
      relaxedDatabaseModes: {
        userId: 2,
        groupId: 1,
        lease: { accessible: false },
        database: { accessible: false, code: "EPERM" },
        artifact: { accessible: false, code: "EPERM" }
      }
    });
  }, 45_000);
});
