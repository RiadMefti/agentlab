import { chmod, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadLocalFactoryOperationsHealthConfig } from "../../packages/runtime/src/infrastructure/filesystem/local-factory-operations-health-config.js";
import { loadLocalFactoryOperationsHealthPolicy } from "../../packages/runtime/src/infrastructure/filesystem/local-factory-operations-health-policy.js";
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

describe("local factory operations health configuration boundary", () => {
  it("loads exact owner-only health and quota policy pins", async () => {
    const fixture = await configFixture();

    await expect(loadLocalFactoryOperationsHealthConfig(fixture.configPath)).resolves.toEqual({
      ...fixture.config,
      healthPolicy: fixture.healthPolicy,
      dailyQuotaPolicy: fixture.dailyQuotaPolicy
    });
    await expect(loadLocalFactoryOperationsHealthPolicy(fixture.healthPolicyPath)).resolves.toEqual(
      fixture.healthPolicy
    );
  });

  it("rejects policy drift, unknown authority fields, and permissive or linked policy files", async () => {
    const fixture = await configFixture();
    await writePrivateJson(fixture.configPath, {
      ...fixture.config,
      expectedHealthPolicyDigest: testDigest("f")
    });
    await expect(loadLocalFactoryOperationsHealthConfig(fixture.configPath)).rejects.toThrow(
      /changed after review/u
    );

    await writePrivateJson(fixture.configPath, { ...fixture.config, disableScheduler: true });
    await expect(loadLocalFactoryOperationsHealthConfig(fixture.configPath)).rejects.toThrow();

    await chmod(fixture.healthPolicyPath, 0o644);
    await writePrivateJson(fixture.configPath, fixture.config);
    await expect(loadLocalFactoryOperationsHealthConfig(fixture.configPath)).rejects.toThrow(
      /owner-only/u
    );

    await chmod(fixture.healthPolicyPath, 0o600);
    const alias = join(fixture.root, "health-policy-link.json");
    await symlink(fixture.healthPolicyPath, alias);
    await writePrivateJson(fixture.configPath, { ...fixture.config, healthPolicyPath: alias });
    await expect(loadLocalFactoryOperationsHealthConfig(fixture.configPath)).rejects.toThrow(
      /owner-only|canonical/u
    );
  });
});

async function configFixture() {
  const root = await temporaryRoot();
  const configPath = join(root, "health.json");
  const healthPolicyPath = join(root, "health-policy.json");
  const dailyQuotaPolicyPath = join(root, "daily-quota.json");
  const healthPolicy = testFactoryOperationsHealthPolicy();
  const dailyQuotaPolicy = testFactoryDailyQuotaPolicy();
  await writePrivateJson(healthPolicyPath, healthPolicy);
  await writePrivateJson(dailyQuotaPolicyPath, dailyQuotaPolicy);
  const config = {
    schemaVersion: "agentlab.local-factory-operations-health.v1" as const,
    databasePath: join(root, "factory.sqlite"),
    observerId: "operations-observer",
    healthPolicyPath,
    expectedHealthPolicyDigest: encodeCanonicalDocument(healthPolicy).digest,
    dailyQuotaPolicyPath,
    expectedDailyQuotaPolicyDigest: encodeCanonicalDocument(dailyQuotaPolicy).digest
  };
  await writePrivateJson(configPath, config);
  return {
    root,
    configPath,
    healthPolicyPath,
    healthPolicy,
    dailyQuotaPolicy,
    config
  };
}

async function writePrivateJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, JSON.stringify(value), { encoding: "utf8", mode: 0o600 });
  await chmod(path, 0o600);
}

async function temporaryRoot(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agentlab-health-config-")));
  temporaryRoots.push(root);
  return root;
}
