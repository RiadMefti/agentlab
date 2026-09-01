import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadLocalFactoryExternalPullRequestReviewConfig } from "../../packages/runtime/src/infrastructure/filesystem/local-factory-external-pull-request-review-config.js";
import {
  encodeCanonicalDocument,
  NodeFactoryDocumentCodec
} from "../../packages/runtime/src/infrastructure/persistence/canonical-factory-documents.js";
import { testFactoryRoleIdentityPolicy, testEvalDigest } from "../helpers/factory-evaluation.js";
import { testExternalPullRequestReviewFixture } from "../helpers/factory-external-pull-request-review.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("local external PR review configuration", () => {
  it("loads only owner-private, exact policy, identity, provider, and skill inputs", async () => {
    const fixture = testExternalPullRequestReviewFixture();
    const root = temporaryRoot();
    const roleIdentityPolicy = testFactoryRoleIdentityPolicy({
      keyId: testEvalDigest(44),
      workerUserId: 1_000,
      attestorUserId: 1_001
    });
    const costPolicy = {
      schemaVersion: "agentlab.cost-policy.v1" as const,
      id: "agentlab/external-review-costs",
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
        },
        {
          provider: "claude" as const,
          model: "claude-sonnet-4-5",
          accounting: { mode: "provider-reported" as const }
        }
      ]
    };
    const reviewPolicyPath = privateJson(root, "review-policy.json", fixture.policy);
    const costPolicyPath = privateJson(root, "cost-policy.json", costPolicy);
    const rolePolicyPath = privateJson(root, "role-policy.json", roleIdentityPolicy);
    const skillPackagePaths = fixture.skillPackages.map((skill, index) =>
      privateJson(root, `skill-${String(index)}.json`, skill)
    );
    const value = {
      schemaVersion: "agentlab.local-factory-external-pull-request-review.v1" as const,
      databasePath: join(root, "state", "agentlab.sqlite"),
      artifactRoot: join(root, "artifacts"),
      workspaceRoot: join(root, "workspaces"),
      repositoryRoot: join(root, "repository"),
      repositoryId: fixture.policy.repositoryId,
      reviewPolicyPath,
      expectedReviewPolicyDigest: fixture.policyDocument.digest,
      costPolicyPath,
      expectedCostPolicyDigest: encodeCanonicalDocument(costPolicy).digest,
      roleIdentityPolicyPath: rolePolicyPath,
      expectedRoleIdentityPolicyDigest: new NodeFactoryDocumentCodec().roleIdentityPolicy(
        roleIdentityPolicy
      ).digest,
      skillPackagePaths,
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
          executableDigest: testEvalDigest(45),
          version: "codex 1"
        },
        {
          provider: "claude" as const,
          executable: "/opt/agentlab/claude",
          executableDigest: testEvalDigest(46),
          version: "claude 1"
        }
      ]
    };
    const configPath = privateJson(root, "config.json", value);

    await expect(loadLocalFactoryExternalPullRequestReviewConfig(configPath)).resolves.toEqual({
      ...value,
      reviewPolicy: fixture.policy,
      costPolicy,
      roleIdentityPolicy,
      skillPackages: fixture.skillPackages
    });

    const overlapPath = privateJson(root, "overlap.json", {
      ...value,
      repositoryRoot: join(value.workspaceRoot, "repository")
    });
    await expect(loadLocalFactoryExternalPullRequestReviewConfig(overlapPath)).rejects.toThrow(
      /must not overlap/u
    );
    chmodSync(configPath, 0o644);
    await expect(loadLocalFactoryExternalPullRequestReviewConfig(configPath)).rejects.toThrow(
      /owner-only/u
    );
  });
});

function privateJson(root: string, name: string, value: unknown): string {
  const path = join(root, name);
  writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "agentlab-external-pr-review-config-"));
  roots.push(root);
  return root;
}
