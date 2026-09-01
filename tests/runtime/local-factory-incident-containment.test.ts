import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createConfiguredLocalFactoryIncidentContainment,
  createLocalFactoryIncidentContainment
} from "../../packages/runtime/src/local-factory-incident-containment.js";
import { NodeFactoryDocumentCodec } from "../../packages/runtime/src/infrastructure/persistence/canonical-factory-documents.js";
import { SqliteFactoryRepository } from "../../packages/runtime/src/infrastructure/persistence/sqlite-factory-repository.js";
import { testFactoryDailyQuotaPolicy } from "../helpers/factory-daily-quota.js";
import { testFactoryOperationsHealthPolicy } from "../helpers/factory-operations-health.js";
import { testDigest } from "../helpers/factory.js";

const temporaryRoots: string[] = [];
const documents = new NodeFactoryDocumentCodec();

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true }))
  );
});

describe("local factory incident containment composition", () => {
  it("exposes exactly one providerless disable-only command over a durable ledger", async () => {
    const root = await temporaryRoot();
    const databasePath = join(root, "factory.sqlite");
    new SqliteFactoryRepository(databasePath).close();
    const options = validOptions(databasePath);
    const runtime = createLocalFactoryIncidentContainment(options);

    expect(Object.keys(runtime.commands)).toEqual(["containIfCritical"]);
    await expect(runtime.commands.containIfCritical()).resolves.toMatchObject({
      status: "healthy",
      authorityBefore: { scheduler: false, prBroker: false },
      authorityAfter: { scheduler: false, prBroker: false }
    });
    await runtime.close();
    await expect(runtime.close()).resolves.toBeUndefined();

    const configured = createConfiguredLocalFactoryIncidentContainment({
      ...options,
      schemaVersion: "agentlab.local-factory-incident-containment.v1",
      healthPolicyPath: join(root, "health-policy.json"),
      dailyQuotaPolicyPath: join(root, "daily-quota.json")
    });
    await expect(configured.commands.containIfCritical()).resolves.toMatchObject({
      status: "healthy"
    });
    await configured.close();
  });

  it("rejects identity collapse, ephemeral storage, and changed policy pins", () => {
    const userId = process.getuid?.() ?? 1_000;
    const valid = validOptions(":memory:");
    expect(() =>
      createLocalFactoryIncidentContainment({ ...valid, controllerUserId: userId + 1 })
    ).toThrow(/process identity/u);
    expect(() => createLocalFactoryIncidentContainment(valid)).toThrow(/durable SQLite/u);
    expect(() =>
      createLocalFactoryIncidentContainment({
        ...valid,
        databasePath: "/does/not/exist/factory.sqlite",
        expectedHealthPolicyDigest: testDigest("f")
      })
    ).toThrow(/changed after review/u);
  });
});

function validOptions(databasePath: string) {
  const healthPolicy = testFactoryOperationsHealthPolicy();
  const dailyQuotaPolicy = testFactoryDailyQuotaPolicy();
  return {
    databasePath,
    controllerId: "incident-controller",
    controllerUserId: process.getuid?.() ?? 1_000,
    healthPolicy,
    expectedHealthPolicyDigest: documents.operationsHealthPolicy(healthPolicy).digest,
    dailyQuotaPolicy,
    expectedDailyQuotaPolicyDigest: documents.dailyQuotaPolicy(dailyQuotaPolicy).digest,
    now: () => "2026-08-31T13:00:00.000Z",
    createId: () => "10000000-0000-4000-8000-000000000001"
  };
}

async function temporaryRoot(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agentlab-local-incident-")));
  temporaryRoots.push(root);
  return root;
}
