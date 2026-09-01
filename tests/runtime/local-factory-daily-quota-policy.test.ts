import { chmod, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadLocalFactoryDailyQuotaPolicy } from "../../packages/runtime/src/infrastructure/filesystem/local-factory-daily-quota-policy.js";
import { testFactoryDailyQuotaPolicy } from "../helpers/factory-daily-quota.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true }))
  );
});

describe("local factory daily quota policy boundary", () => {
  it("loads one strict owner-only reviewed policy", async () => {
    const root = await temporaryRoot();
    const path = join(root, "daily-quota.json");
    const policy = testFactoryDailyQuotaPolicy();
    await writePrivateJson(path, policy);

    await expect(loadLocalFactoryDailyQuotaPolicy(path)).resolves.toEqual(policy);
  });

  it("rejects permissive, linked, malformed, and structurally invalid policies", async () => {
    const root = await temporaryRoot();
    const path = join(root, "daily-quota.json");
    const alias = join(root, "daily-quota-link.json");
    const policy = testFactoryDailyQuotaPolicy();
    await writePrivateJson(path, policy);
    await chmod(path, 0o644);
    await expect(loadLocalFactoryDailyQuotaPolicy(path)).rejects.toThrow(/owner-only/u);

    await chmod(path, 0o600);
    await symlink(path, alias);
    await expect(loadLocalFactoryDailyQuotaPolicy(alias)).rejects.toThrow(/owner-only|canonical/u);

    await writeFile(path, "{]", { encoding: "utf8", mode: 0o600 });
    await expect(loadLocalFactoryDailyQuotaPolicy(path)).rejects.toThrow(/not valid JSON/u);

    await writePrivateJson(path, { ...policy, timeZone: "America/Toronto" });
    await expect(loadLocalFactoryDailyQuotaPolicy(path)).rejects.toThrow();
  });
});

async function writePrivateJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, JSON.stringify(value), { encoding: "utf8", mode: 0o600 });
  await chmod(path, 0o600);
}

async function temporaryRoot(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agentlab-daily-quota-policy-")));
  temporaryRoots.push(root);
  return root;
}
