import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  factoryExternalPullRequestRepairExecutionPolicySchema,
  factoryExternalPullRequestRepairQualificationPolicySchema
} from "@agentlab/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { loadLocalFactoryExternalPullRequestRepairQualificationConfig } from "../../packages/runtime/src/infrastructure/filesystem/local-factory-external-pull-request-repair-qualification-config.js";
import {
  encodeCanonicalDocument,
  NodeFactoryDocumentCodec
} from "../../packages/runtime/src/infrastructure/persistence/canonical-factory-documents.js";
import { testEvalDigest, testFactoryRoleIdentityPolicy } from "../helpers/factory-evaluation.js";
import { testExternalPullRequestRepairQualificationFixture } from "../helpers/factory-external-pull-request-repair-qualification.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("local external PR repair qualification configuration", () => {
  it("pins exact policies, skills, and every installed gate executable", async () => {
    const root = temporaryRoot();
    const runtimeRoot = join(root, "runtime");
    const gateExecutable = join(runtimeRoot, "bin", "gate");
    mkdirSync(join(runtimeRoot, "bin"), { recursive: true, mode: 0o700 });
    writeFileSync(gateExecutable, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    chmodSync(gateExecutable, 0o700);
    const executableDigest = digestFile(gateExecutable);
    const fixture = testExternalPullRequestRepairQualificationFixture();
    const roleIdentityPolicy = testFactoryRoleIdentityPolicy({
      keyId: testEvalDigest(80),
      workerUserId: process.getuid?.() ?? 1_000,
      attestorUserId: (process.getuid?.() ?? 1_000) + 1
    });
    const costPolicy = {
      schemaVersion: "agentlab.cost-policy.v1" as const,
      id: "agentlab/external-repair-qualification-costs",
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
    const gateProfile = {
      ...fixture.gateProfile,
      gates: fixture.gateProfile.gates.map((gate) => ({
        ...gate,
        command: { ...gate.command, executable: gateExecutable, executableDigest }
      }))
    };
    const gateProfileDigest = encodeCanonicalDocument(gateProfile).digest;
    const qualificationPolicy = factoryExternalPullRequestRepairQualificationPolicySchema.parse({
      ...fixture.policy,
      costPolicyDigest,
      roleIdentityPolicyDigest,
      gateProfileDigest,
      gateProfile
    });
    const qualificationPolicyDigest = encodeCanonicalDocument(qualificationPolicy).digest;
    const repairExecutionPolicy = factoryExternalPullRequestRepairExecutionPolicySchema.parse({
      ...fixture.execution.executionPolicy,
      qualificationPolicyDigest,
      costPolicyDigest,
      roleIdentityPolicyDigest,
      gateProfileDigest
    });
    const repairExecutionPolicyDigest = encodeCanonicalDocument(repairExecutionPolicy).digest;
    const qualificationPolicyPath = privateJson(
      root,
      "qualification-policy.json",
      qualificationPolicy
    );
    const repairExecutionPolicyPath = privateJson(
      root,
      "repair-execution-policy.json",
      repairExecutionPolicy
    );
    const costPolicyPath = privateJson(root, "cost-policy.json", costPolicy);
    const roleIdentityPolicyPath = privateJson(root, "role-policy.json", roleIdentityPolicy);
    const skillPackagePath = privateJson(root, "review-skill.json", fixture.reviewerSkill);
    const value = {
      schemaVersion:
        "agentlab.local-factory-external-pull-request-repair-qualification.v1" as const,
      databasePath: join(root, "state", "agentlab.sqlite"),
      artifactRoot: join(root, "artifacts"),
      workspaceRoot: join(root, "workspaces"),
      repositoryRoot: join(root, "repository"),
      repositoryId: qualificationPolicy.repositoryId,
      qualificationPolicyPath,
      expectedQualificationPolicyDigest: qualificationPolicyDigest,
      repairExecutionPolicyPath,
      expectedRepairExecutionPolicyDigest: repairExecutionPolicyDigest,
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
      sandbox: { bubblewrapExecutable: "/usr/bin/bwrap", runtimeRoots: [runtimeRoot] },
      providers: [
        {
          provider: "codex" as const,
          executable: "/opt/agentlab/codex",
          executableDigest: testEvalDigest(81),
          version: "codex 1"
        }
      ]
    };
    const configPath = privateJson(root, "config.json", value);

    await expect(
      loadLocalFactoryExternalPullRequestRepairQualificationConfig(configPath)
    ).resolves.toMatchObject({
      ...value,
      qualificationPolicy,
      repairExecutionPolicy,
      costPolicy,
      roleIdentityPolicy,
      skillPackages: [fixture.reviewerSkill],
      gates: qualificationPolicy.gateProfile.gates.map(({ command, ...gate }) => ({
        ...gate,
        command: { executable: command.executable, args: command.args }
      }))
    });

    const unmountedConfigPath = privateJson(root, "unmounted-config.json", {
      ...value,
      sandbox: { ...value.sandbox, runtimeRoots: [] }
    });
    await expect(
      loadLocalFactoryExternalPullRequestRepairQualificationConfig(unmountedConfigPath)
    ).rejects.toThrow(/outside trusted mounts/u);

    writeFileSync(gateExecutable, "#!/bin/sh\nexit 1\n", { mode: 0o700 });
    await expect(
      loadLocalFactoryExternalPullRequestRepairQualificationConfig(configPath)
    ).rejects.toThrow(/executable changed/u);
    chmodSync(configPath, 0o644);
    await expect(
      loadLocalFactoryExternalPullRequestRepairQualificationConfig(configPath)
    ).rejects.toThrow(/owner-only/u);
  });
});

function digestFile(path: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
}

function privateJson(root: string, name: string, value: unknown): string {
  const path = join(root, name);
  writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "agentlab-external-pr-repair-qualification-config-"));
  roots.push(root);
  return root;
}
