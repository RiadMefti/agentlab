import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadLocalFactoryExternalPullRequestRepairAdmissionConfig } from "../../packages/runtime/src/infrastructure/filesystem/local-factory-external-pull-request-repair-admission-config.js";
import { testExternalPullRequestRepairAdmissionFixture } from "../helpers/factory-external-pull-request-repair-admission.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("local external PR repair admission configuration", () => {
  it("loads only an owner-private exact deterministic policy", async () => {
    const fixture = testExternalPullRequestRepairAdmissionFixture();
    const root = temporaryRoot();
    const admissionPolicyPath = privateJson(root, "admission-policy.json", fixture.policy);
    const value = {
      schemaVersion: "agentlab.local-factory-external-pull-request-repair-admission.v1" as const,
      databasePath: join(root, "state", "agentlab.sqlite"),
      repositoryId: fixture.policy.repositoryId,
      processUserId: process.getuid?.() ?? 1_000,
      admissionPolicyPath,
      expectedAdmissionPolicyDigest: fixture.policyDocument.digest
    };
    const configPath = privateJson(root, "config.json", value);

    await expect(
      loadLocalFactoryExternalPullRequestRepairAdmissionConfig(configPath)
    ).resolves.toEqual({ ...value, admissionPolicy: fixture.policy });

    const driftedPolicyPath = privateJson(root, "drifted-policy.json", {
      ...fixture.policy,
      maximumFindings: 7
    });
    const driftedConfig = privateJson(root, "drifted-config.json", {
      ...value,
      admissionPolicyPath: driftedPolicyPath
    });
    await expect(
      loadLocalFactoryExternalPullRequestRepairAdmissionConfig(driftedConfig)
    ).rejects.toThrow(/changed after owner review/u);
    chmodSync(configPath, 0o644);
    await expect(
      loadLocalFactoryExternalPullRequestRepairAdmissionConfig(configPath)
    ).rejects.toThrow(/owner-only/u);
  });
});

function privateJson(root: string, name: string, value: unknown): string {
  const path = join(root, name);
  writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "agentlab-external-pr-repair-admission-config-"));
  roots.push(root);
  return root;
}
