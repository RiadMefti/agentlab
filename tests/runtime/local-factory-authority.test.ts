import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createConfiguredLocalFactoryAuthority,
  createLocalFactoryAuthority
} from "../../packages/runtime/src/local-factory-authority.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true }))
  );
});

describe("local factory authority composition", () => {
  it("persists an auditable broker switch while leaving scheduler disabled", async () => {
    const root = await temporaryRoot();
    const databasePath = join(root, "agentlab.sqlite");
    const runtime = createLocalFactoryAuthority({
      databasePath,
      operatorId: "maintainer/riad",
      now: () => "2026-08-31T12:00:00.000Z",
      createId: () => "0198f005-4ec4-7000-8000-000000000001"
    });

    expect(Object.keys(runtime.commands).sort()).toEqual([
      "inspect",
      "setBrokerAuthority",
      "setSchedulerAuthority"
    ]);
    await expect(runtime.commands.inspect()).resolves.toMatchObject({
      schedulerEnabled: false,
      prBrokerEnabled: false,
      recentSchedulerEvents: [],
      recentBrokerEvents: []
    });
    await expect(
      runtime.commands.setBrokerAuthority({
        expectedEnabled: false,
        enabled: true,
        reason: "Approved for one governed draft-PR canary.",
        confirmation: "enable-draft-broker"
      })
    ).resolves.toMatchObject({ schedulerEnabled: false, prBrokerEnabled: true });
    await runtime.close();

    const reopened = createConfiguredLocalFactoryAuthority({
      schemaVersion: "agentlab.local-factory-authority.v1",
      databasePath,
      operatorId: "maintainer/riad"
    });
    await expect(reopened.commands.inspect()).resolves.toMatchObject({
      schedulerEnabled: false,
      prBrokerEnabled: true,
      recentBrokerEvents: [
        expect.objectContaining({
          eventId: "0198f005-4ec4-7000-8000-000000000001",
          control: "pr-broker",
          enabled: true
        })
      ]
    });
    await reopened.close();
  });

  it("requires durable storage and releases construction resources after invalid identity", async () => {
    expect(() =>
      createLocalFactoryAuthority({ databasePath: ":memory:", operatorId: "maintainer" })
    ).toThrow(/durable SQLite/u);

    const root = await temporaryRoot();
    const databasePath = join(root, "agentlab.sqlite");
    expect(() => createLocalFactoryAuthority({ databasePath, operatorId: "INVALID ID" })).toThrow();

    const runtime = createLocalFactoryAuthority({ databasePath, operatorId: "maintainer" });
    await expect(runtime.commands.inspect()).resolves.toMatchObject({ prBrokerEnabled: false });
    await runtime.close();
    await expect(runtime.close()).resolves.toBeUndefined();
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agentlab-local-authority-")));
  temporaryRoots.push(root);
  return root;
}
