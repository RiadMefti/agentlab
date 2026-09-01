import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadLocalFactoryExternalPullRequestFeedbackConfig } from "../../packages/runtime/src/infrastructure/filesystem/local-factory-external-pull-request-feedback-config.js";
import { testExternalPullRequestFeedbackFixture } from "../helpers/factory-external-pull-request-feedback.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("local external PR feedback configuration", () => {
  it("loads only an owner-private exact policy and separated publisher identity", async () => {
    const fixture = testExternalPullRequestFeedbackFixture();
    const root = temporaryRoot();
    const feedbackPolicyPath = privateJson(root, "feedback-policy.json", fixture.policy);
    const value = {
      schemaVersion: "agentlab.local-factory-external-pull-request-feedback.v1" as const,
      databasePath: join(root, "state", "agentlab.sqlite"),
      artifactRoot: join(root, "artifacts"),
      repositoryId: fixture.policy.repositoryId,
      repositoryNumericId: 77,
      processUserId: process.getuid?.() ?? 1_000,
      feedbackPolicyPath,
      expectedFeedbackPolicyDigest: fixture.policyDocument.digest,
      githubApp: {
        clientId: "Iv1.agentlab-feedback",
        installationId: 88,
        privateKeyPath: join(root, "feedback-app.pem")
      }
    };
    const configPath = privateJson(root, "config.json", value);

    await expect(loadLocalFactoryExternalPullRequestFeedbackConfig(configPath)).resolves.toEqual({
      ...value,
      feedbackPolicy: fixture.policy
    });

    const driftedPolicyPath = privateJson(root, "drifted-policy.json", {
      ...fixture.policy,
      maximumPublicationsPerTick: 2
    });
    const driftedConfig = privateJson(root, "drifted-config.json", {
      ...value,
      feedbackPolicyPath: driftedPolicyPath
    });
    await expect(loadLocalFactoryExternalPullRequestFeedbackConfig(driftedConfig)).rejects.toThrow(
      /changed after owner review/u
    );
    chmodSync(configPath, 0o644);
    await expect(loadLocalFactoryExternalPullRequestFeedbackConfig(configPath)).rejects.toThrow(
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
  const root = mkdtempSync(join(tmpdir(), "agentlab-external-pr-feedback-config-"));
  roots.push(root);
  return root;
}
