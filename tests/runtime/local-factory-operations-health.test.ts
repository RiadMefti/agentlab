import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createConfiguredLocalFactoryOperationsHealth,
  createLocalFactoryOperationsHealth
} from "../../packages/runtime/src/local-factory-operations-health.js";
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

describe("local factory operations health composition", () => {
  it("exposes exactly one query-only command over a durable ledger", async () => {
    const root = await temporaryRoot();
    const databasePath = join(root, "factory.sqlite");
    new SqliteFactoryRepository(databasePath).close();
    const healthPolicy = testFactoryOperationsHealthPolicy();
    const dailyQuotaPolicy = testFactoryDailyQuotaPolicy();
    const options = {
      databasePath,
      observerId: "operations-observer",
      healthPolicy,
      expectedHealthPolicyDigest: documents.operationsHealthPolicy(healthPolicy).digest,
      dailyQuotaPolicy,
      expectedDailyQuotaPolicyDigest: documents.dailyQuotaPolicy(dailyQuotaPolicy).digest,
      now: () => "2026-08-31T13:00:00.000Z",
      createId: () => "10000000-0000-4000-8000-000000000001"
    };
    const runtime = createLocalFactoryOperationsHealth(options);

    expect(Object.keys(runtime.commands)).toEqual(["inspect"]);
    await expect(runtime.commands.inspect()).resolves.toMatchObject({
      value: { status: "healthy", observerId: "operations-observer" }
    });
    await runtime.close();
    await expect(runtime.close()).resolves.toBeUndefined();

    const configured = createConfiguredLocalFactoryOperationsHealth({
      ...options,
      schemaVersion: "agentlab.local-factory-operations-health.v1",
      healthPolicyPath: join(root, "health-policy.json"),
      dailyQuotaPolicyPath: join(root, "daily-quota.json")
    });
    await expect(configured.commands.inspect()).resolves.toMatchObject({
      value: { status: "healthy" }
    });
    await configured.close();
  });

  it("rejects ephemeral storage and changed policy pins before opening the ledger", () => {
    const healthPolicy = testFactoryOperationsHealthPolicy();
    const dailyQuotaPolicy = testFactoryDailyQuotaPolicy();
    const base = {
      databasePath: ":memory:",
      observerId: "operations-observer",
      healthPolicy,
      expectedHealthPolicyDigest: documents.operationsHealthPolicy(healthPolicy).digest,
      dailyQuotaPolicy,
      expectedDailyQuotaPolicyDigest: documents.dailyQuotaPolicy(dailyQuotaPolicy).digest
    };
    expect(() => createLocalFactoryOperationsHealth(base)).toThrow(/durable SQLite/u);
    expect(() =>
      createLocalFactoryOperationsHealth({
        ...base,
        databasePath: "/does/not/exist/factory.sqlite",
        expectedHealthPolicyDigest: testDigest("f")
      })
    ).toThrow(/changed after review/u);
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agentlab-local-health-")));
  temporaryRoots.push(root);
  return root;
}
