import { chmod, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadLocalFactoryIncidentContainmentConfig } from "../../packages/runtime/src/infrastructure/filesystem/local-factory-incident-containment-config.js";
import { encodeCanonicalDocument } from "../../packages/runtime/src/infrastructure/persistence/canonical-factory-documents.js";
import { testFactoryDailyQuotaPolicy } from "../helpers/factory-daily-quota.js";
import { testFactoryOperationsHealthPolicy } from "../helpers/factory-operations-health.js";
import { testDigest } from "../helpers/factory.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true }))
  );
});

describe("local factory incident containment configuration boundary", () => {
  it("loads only owner-reviewed health and quota policy", async () => {
    const fixture = await createFixture();

    await expect(loadLocalFactoryIncidentContainmentConfig(fixture.configPath)).resolves.toEqual({
      ...fixture.config,
      healthPolicy: fixture.healthPolicy,
      dailyQuotaPolicy: fixture.dailyQuotaPolicy
    });
  });

  it("rejects permissive files and either policy digest drifting", async () => {
    const fixture = await createFixture();
    await chmod(fixture.configPath, 0o644);
    await expect(loadLocalFactoryIncidentContainmentConfig(fixture.configPath)).rejects.toThrow(
      /owner-only/u
    );

    await writePrivateJson(fixture.configPath, {
      ...fixture.config,
      expectedHealthPolicyDigest: testDigest("f")
    });
    await expect(loadLocalFactoryIncidentContainmentConfig(fixture.configPath)).rejects.toThrow(
      /health policy changed/u
    );

    await writePrivateJson(fixture.configPath, {
      ...fixture.config,
      expectedDailyQuotaPolicyDigest: testDigest("e")
    });
    await expect(loadLocalFactoryIncidentContainmentConfig(fixture.configPath)).rejects.toThrow(
      /daily quota policy changed/u
    );
  });
});

async function createFixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agentlab-incident-config-")));
  temporaryRoots.push(root);
  const configPath = join(root, "incident.json");
  const healthPolicyPath = join(root, "health-policy.json");
  const dailyQuotaPolicyPath = join(root, "daily-quota.json");
  const healthPolicy = testFactoryOperationsHealthPolicy();
  const dailyQuotaPolicy = testFactoryDailyQuotaPolicy();
  const config = {
    schemaVersion: "agentlab.local-factory-incident-containment.v1",
    databasePath: join(root, "factory.sqlite"),
    controllerId: "incident-controller",
    controllerUserId: process.getuid?.() ?? 1_000,
    healthPolicyPath,
    expectedHealthPolicyDigest: encodeCanonicalDocument(healthPolicy).digest,
    dailyQuotaPolicyPath,
    expectedDailyQuotaPolicyDigest: encodeCanonicalDocument(dailyQuotaPolicy).digest
  } as const;
  await Promise.all([
    writePrivateJson(healthPolicyPath, healthPolicy),
    writePrivateJson(dailyQuotaPolicyPath, dailyQuotaPolicy),
    writePrivateJson(configPath, config)
  ]);
  return { configPath, config, healthPolicy, dailyQuotaPolicy };
}

async function writePrivateJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, JSON.stringify(value), { encoding: "utf8", mode: 0o600 });
  await chmod(path, 0o600);
}
