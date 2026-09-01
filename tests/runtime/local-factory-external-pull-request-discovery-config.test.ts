import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadLocalFactoryExternalPullRequestDiscoveryConfig } from "../../packages/runtime/src/infrastructure/filesystem/local-factory-external-pull-request-discovery-config.js";
import { encodeCanonicalDocument } from "../../packages/runtime/src/infrastructure/persistence/canonical-factory-documents.js";
import { testExternalPullRequestDiscoveryFixture } from "../helpers/factory-external-pull-request-discovery.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("local external PR discovery configuration", () => {
  it("loads exact owner-reviewed policies and a separate reader App identity", async () => {
    const root = temporaryRoot();
    const fixture = testExternalPullRequestDiscoveryFixture();
    const policyPath = privateJson(root, "external-pr-policy.json", fixture.policy);
    const schedulePath = privateJson(root, "schedule-policy.json", fixture.schedulePolicy);
    const value = config(root, policyPath, schedulePath, fixture);
    const configPath = privateJson(root, "config.json", value);

    await expect(loadLocalFactoryExternalPullRequestDiscoveryConfig(configPath)).resolves.toEqual({
      ...value,
      discoveryPolicy: fixture.policy,
      schedulePolicy: fixture.schedulePolicy
    });
  });

  it("rejects policy drift, another repository, overlapping storage, and exposed config", async () => {
    const root = temporaryRoot();
    const fixture = testExternalPullRequestDiscoveryFixture();
    const policyPath = privateJson(root, "external-pr-policy.json", fixture.policy);
    const schedulePath = privateJson(root, "schedule-policy.json", fixture.schedulePolicy);
    const value = config(root, policyPath, schedulePath, fixture);
    const drift = privateJson(root, "drift.json", {
      ...value,
      expectedDiscoveryPolicyDigest: `sha256:${"f".repeat(64)}`
    });
    const otherRepositoryPolicy = { ...fixture.policy, repositoryId: "owner/other" };
    const otherPolicyPath = privateJson(root, "other-policy.json", otherRepositoryPolicy);
    const other = privateJson(root, "other.json", {
      ...value,
      discoveryPolicyPath: otherPolicyPath,
      expectedDiscoveryPolicyDigest: encodeCanonicalDocument(otherRepositoryPolicy).digest
    });
    const overlap = privateJson(root, "overlap.json", {
      ...value,
      databasePath: join(value.artifactRoot, "agentlab.sqlite")
    });
    const exposed = privateJson(root, "exposed.json", value);
    chmodSync(exposed, 0o640);

    await expect(loadLocalFactoryExternalPullRequestDiscoveryConfig(drift)).rejects.toThrow(
      /changed after owner review/u
    );
    await expect(loadLocalFactoryExternalPullRequestDiscoveryConfig(other)).rejects.toThrow(
      /another repository/u
    );
    await expect(loadLocalFactoryExternalPullRequestDiscoveryConfig(overlap)).rejects.toThrow(
      /must not overlap/u
    );
    await expect(loadLocalFactoryExternalPullRequestDiscoveryConfig(exposed)).rejects.toThrow(
      /owner-only/u
    );
  });
});

function config(
  root: string,
  policyPath: string,
  schedulePath: string,
  fixture: ReturnType<typeof testExternalPullRequestDiscoveryFixture>
) {
  return {
    schemaVersion: "agentlab.local-factory-external-pull-request-discovery.v1" as const,
    databasePath: join(root, "agentlab.sqlite"),
    artifactRoot: join(root, "artifacts"),
    repositoryId: "owner/agentlab",
    repositoryNumericId: 99,
    observerId: "github/pr-reader",
    discoveryPolicyPath: policyPath,
    expectedDiscoveryPolicyDigest: fixture.policyDocument.digest,
    schedulePolicyPath: schedulePath,
    expectedSchedulePolicyDigest: fixture.scheduleDocument.digest,
    githubApp: {
      clientId: "Iv1.external-pr-reader",
      installationId: 123,
      privateKeyPath: join(root, "reader-key.pem")
    }
  };
}

function privateJson(root: string, name: string, value: unknown): string {
  const path = join(root, name);
  writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "agentlab-external-pr-discovery-config-"));
  roots.push(root);
  return root;
}
