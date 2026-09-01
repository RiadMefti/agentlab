import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadLocalFactoryCanaryAdmissionConfig } from "../../packages/runtime/src/infrastructure/filesystem/local-factory-canary-admission-config.js";
import { testFactoryRoleIdentityPolicy } from "../helpers/factory-evaluation.js";
import { testFactorySchedulePolicy } from "../helpers/factory-schedule.js";
import { testDigest } from "../helpers/factory.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true }))
  );
});

describe("local factory canary admission configuration boundary", () => {
  it("loads v2 automatic-consumer policy while preserving v1 manual admission", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentlab-canary-admission-config-"));
    temporaryRoots.push(root);
    const configPath = join(root, "admission.json");
    const roleIdentityPolicyPath = join(root, "roles.json");
    const schedulePolicyPath = join(root, "schedule.json");
    const roleIdentityPolicy = testFactoryRoleIdentityPolicy({
      keyId: testDigest("1"),
      workerUserId: 1_001,
      attestorUserId: 1_002
    });
    const schedulePolicy = testFactorySchedulePolicy();
    await Promise.all([
      writePrivate(roleIdentityPolicyPath, roleIdentityPolicy),
      writePrivate(schedulePolicyPath, schedulePolicy)
    ]);
    const common = {
      databasePath: join(root, "agentlab.sqlite"),
      runnerId: roleIdentityPolicy.evalAttestor.runnerId,
      trustedPublicKeyPath: join(root, "eval-public.pem"),
      trustedKeyId: roleIdentityPolicy.evalAttestor.keyId,
      roleIdentityPolicyPath,
      expectedRoleIdentityPolicyDigest: testDigest("2"),
      expectedCohortDigest: testDigest("3"),
      expectedCandidateDigest: testDigest("4"),
      expectedSchedulePolicyDigest: testDigest("5"),
      expectedPolicyBundleDigest: testDigest("6"),
      maximumIssuanceDelaySeconds: 300,
      maximumAttestationLifetimeSeconds: 3_600
    };
    await writePrivate(configPath, {
      schemaVersion: "agentlab.local-factory-canary-admission.v2",
      ...common,
      schedulePolicyPath
    });

    await expect(loadLocalFactoryCanaryAdmissionConfig(configPath)).resolves.toEqual({
      schemaVersion: "agentlab.local-factory-canary-admission.v2",
      ...common,
      schedulePolicyPath,
      roleIdentityPolicy,
      schedulePolicy
    });

    await writePrivate(configPath, {
      schemaVersion: "agentlab.local-factory-canary-admission.v1",
      ...common
    });
    await expect(loadLocalFactoryCanaryAdmissionConfig(configPath)).resolves.toEqual({
      schemaVersion: "agentlab.local-factory-canary-admission.v1",
      ...common,
      roleIdentityPolicy
    });
  });

  it("rejects unowned, relative, and structurally unknown input", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentlab-canary-admission-config-"));
    temporaryRoots.push(root);
    const configPath = join(root, "admission.json");
    await writePrivate(configPath, { schemaVersion: "unknown" });
    await expect(loadLocalFactoryCanaryAdmissionConfig(configPath)).rejects.toThrow();
    await expect(loadLocalFactoryCanaryAdmissionConfig("relative.json")).rejects.toThrow(
      /bounded absolute path/u
    );
    await chmod(configPath, 0o644);
    await expect(loadLocalFactoryCanaryAdmissionConfig(configPath)).rejects.toThrow(/owner-only/u);
  });
});

async function writePrivate(path: string, value: unknown): Promise<void> {
  await writeFile(path, JSON.stringify(value), { encoding: "utf8", mode: 0o600 });
  await chmod(path, 0o600);
}
