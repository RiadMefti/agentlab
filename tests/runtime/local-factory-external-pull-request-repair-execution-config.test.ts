import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadLocalFactoryExternalPullRequestRepairExecutionConfig } from "../../packages/runtime/src/infrastructure/filesystem/local-factory-external-pull-request-repair-execution-config.js";
import {
  encodeCanonicalDocument,
  NodeFactoryDocumentCodec
} from "../../packages/runtime/src/infrastructure/persistence/canonical-factory-documents.js";
import { testEvalDigest, testFactoryRoleIdentityPolicy } from "../helpers/factory-evaluation.js";
import { testDigest } from "../helpers/factory.js";
import { testExternalPullRequestRepairExecutionFixture } from "../helpers/factory-external-pull-request-repair-execution.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("local external PR repair execution configuration", () => {
  it("loads only owner-private, mutually pinned credentialless repair inputs", async () => {
    const roleIdentityPolicy = testFactoryRoleIdentityPolicy({
      keyId: testEvalDigest(70),
      workerUserId: process.getuid?.() ?? 1_000,
      attestorUserId: (process.getuid?.() ?? 1_000) + 1
    });
    const costPolicy = {
      schemaVersion: "agentlab.cost-policy.v1" as const,
      id: "agentlab/external-repair-costs",
      version: "1.0.0",
      rules: [
        {
          provider: "codex" as const,
          model: "gpt-5.4",
          accounting: {
            mode: "token-rate" as const,
            inputMicrousdPerMillionTokens: 1_000_000,
            outputMicrousdPerMillionTokens: 2_000_000
          }
        }
      ]
    };
    const costPolicyDigest = encodeCanonicalDocument(costPolicy).digest;
    const roleIdentityPolicyDigest = new NodeFactoryDocumentCodec().roleIdentityPolicy(
      roleIdentityPolicy
    ).digest;
    const fixture = testExternalPullRequestRepairExecutionFixture({
      costPolicyDigest,
      roleIdentityPolicyDigest,
      gateProfileDigest: testDigest("6")
    });
    const root = temporaryRoot();
    const executionPolicyPath = privateJson(root, "execution-policy.json", fixture.executionPolicy);
    const admissionPolicyPath = privateJson(
      root,
      "admission-policy.json",
      fixture.admission.policy
    );
    const costPolicyPath = privateJson(root, "cost-policy.json", costPolicy);
    const roleIdentityPolicyPath = privateJson(root, "role-policy.json", roleIdentityPolicy);
    const skillPackagePath = privateJson(root, "repair-skill.json", fixture.skillPackage);
    const value = {
      schemaVersion: "agentlab.local-factory-external-pull-request-repair-execution.v1" as const,
      databasePath: join(root, "state", "agentlab.sqlite"),
      artifactRoot: join(root, "artifacts"),
      workspaceRoot: join(root, "workspaces"),
      repositoryRoot: join(root, "repository"),
      repositoryId: fixture.executionPolicy.repositoryId,
      executionPolicyPath,
      expectedExecutionPolicyDigest: fixture.executionPolicyDocument.digest,
      admissionPolicyPath,
      expectedAdmissionPolicyDigest: fixture.admission.policyDocument.digest,
      costPolicyPath,
      expectedCostPolicyDigest: costPolicyDigest,
      roleIdentityPolicyPath,
      expectedRoleIdentityPolicyDigest: roleIdentityPolicyDigest,
      skillPackagePaths: [skillPackagePath],
      gitExecutable: "/usr/bin/git",
      flockExecutable: "/usr/bin/flock",
      systemd: {
        runExecutable: "/usr/bin/systemd-run",
        controlExecutable: "/usr/bin/systemctl",
        environmentExecutable: "/usr/bin/env",
        version: "systemd 261"
      },
      providers: [
        {
          provider: "codex" as const,
          executable: "/opt/agentlab/codex",
          executableDigest: testEvalDigest(71),
          version: "codex 1"
        }
      ]
    };
    const configPath = privateJson(root, "config.json", value);

    await expect(
      loadLocalFactoryExternalPullRequestRepairExecutionConfig(configPath)
    ).resolves.toEqual({
      ...value,
      executionPolicy: fixture.executionPolicy,
      admissionPolicy: fixture.admission.policy,
      costPolicy,
      roleIdentityPolicy,
      skillPackages: [fixture.skillPackage]
    });

    const driftedPath = privateJson(root, "drifted-execution-policy.json", {
      ...fixture.executionPolicy,
      maximumChangedLines: fixture.executionPolicy.maximumChangedLines - 1
    });
    const driftedConfigPath = privateJson(root, "drifted-config.json", {
      ...value,
      executionPolicyPath: driftedPath
    });
    await expect(
      loadLocalFactoryExternalPullRequestRepairExecutionConfig(driftedConfigPath)
    ).rejects.toThrow(/changed or exceeds admission/u);
    chmodSync(configPath, 0o644);
    await expect(
      loadLocalFactoryExternalPullRequestRepairExecutionConfig(configPath)
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
  const root = mkdtempSync(join(tmpdir(), "agentlab-external-pr-repair-execution-config-"));
  roots.push(root);
  return root;
}
