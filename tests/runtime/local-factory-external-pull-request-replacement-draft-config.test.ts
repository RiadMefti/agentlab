import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  factoryExternalPullRequestRepairQualificationPolicySchema,
  factoryExternalPullRequestReplacementDraftPolicySchema
} from "@agentlab/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { loadLocalFactoryExternalPullRequestReplacementDraftConfig } from "../../packages/runtime/src/infrastructure/filesystem/local-factory-external-pull-request-replacement-draft-config.js";
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

describe("local external PR replacement-draft configuration", () => {
  it("pins qualification, role separation, broker identity, repository, and fixed GitHub checks", async () => {
    const root = mkdtempSync(join(tmpdir(), "agentlab-replacement-config-"));
    roots.push(root);
    const fixture = testExternalPullRequestRepairQualificationFixture();
    const roleIdentityPolicy = testFactoryRoleIdentityPolicy({
      keyId: testEvalDigest(90),
      workerUserId: 1001,
      attestorUserId: 1002
    });
    const roleDigest = new NodeFactoryDocumentCodec().roleIdentityPolicy(roleIdentityPolicy).digest;
    const qualificationPolicy = factoryExternalPullRequestRepairQualificationPolicySchema.parse({
      ...fixture.policy,
      roleIdentityPolicyDigest: roleDigest
    });
    const qualificationDigest = encodeCanonicalDocument(qualificationPolicy).digest;
    const publicationPolicy = factoryExternalPullRequestReplacementDraftPolicySchema.parse({
      schemaVersion: "agentlab.external-pull-request-replacement-draft-policy.v1",
      id: "agentlab/external-pull-request-replacement-draft",
      version: "1.0.0",
      repositoryId: qualificationPolicy.repositoryId,
      brokerId: "github-app/external-repair",
      publisherId: "github-user/77",
      brokerUserId: 1003,
      qualificationPolicyDigest: qualificationDigest,
      roleIdentityPolicyDigest: roleDigest,
      branchPrefix: "agentlab/external-repair",
      requiredStatusChecks: ["verify", "factory-sandbox"],
      maximumPatchBytes: qualificationPolicy.maximumPatchBytes,
      maximumCandidatesPerTick: 3,
      operationDeadlineSeconds: 900,
      maximumRiskTier: "R1",
      draft: true,
      contributorBranchWrite: false,
      forcePush: false,
      approval: false,
      autoMerge: false,
      release: false
    });
    const publicationDigest = encodeCanonicalDocument(publicationPolicy).digest;
    const value = {
      schemaVersion: "agentlab.local-factory-external-pull-request-replacement-draft.v1" as const,
      databasePath: join(root, "state", "agentlab.sqlite"),
      artifactRoot: join(root, "artifacts"),
      temporaryRoot: join(root, "temporary"),
      repositoryRoot: join(root, "repository"),
      repositoryId: publicationPolicy.repositoryId,
      repositoryNumericId: 123,
      publicationPolicyPath: privateJson(root, "publication.json", publicationPolicy),
      expectedPublicationPolicyDigest: publicationDigest,
      qualificationPolicyPath: privateJson(root, "qualification.json", qualificationPolicy),
      expectedQualificationPolicyDigest: qualificationDigest,
      roleIdentityPolicyPath: privateJson(root, "roles.json", roleIdentityPolicy),
      expectedRoleIdentityPolicyDigest: roleDigest,
      gitExecutable: "/usr/bin/git",
      githubApp: {
        clientId: "Iv1.external-repair",
        installationId: 456,
        publisherUserId: 77,
        privateKeyPath: join(root, "secrets", "broker.pem"),
        trustedStatusChecks: [
          { context: "verify" as const, appId: 77 },
          { context: "factory-sandbox" as const, appId: 77 }
        ]
      }
    };
    const configPath = privateJson(root, "config.json", value);
    await expect(
      loadLocalFactoryExternalPullRequestReplacementDraftConfig(configPath)
    ).resolves.toMatchObject({
      ...value,
      publicationPolicy,
      qualificationPolicy,
      roleIdentityPolicy
    });

    const badPolicy = factoryExternalPullRequestReplacementDraftPolicySchema.parse({
      ...publicationPolicy,
      brokerUserId: roleIdentityPolicy.worker.userId
    });
    const badPath = privateJson(root, "bad-publication.json", badPolicy);
    const badConfig = privateJson(root, "bad-config.json", {
      ...value,
      publicationPolicyPath: badPath,
      expectedPublicationPolicyDigest: encodeCanonicalDocument(badPolicy).digest
    });
    await expect(
      loadLocalFactoryExternalPullRequestReplacementDraftConfig(badConfig)
    ).rejects.toThrow(/role separation/u);
    chmodSync(configPath, 0o644);
    await expect(
      loadLocalFactoryExternalPullRequestReplacementDraftConfig(configPath)
    ).rejects.toThrow(/owner-only/u);
  });
});

function privateJson(root: string, name: string, value: unknown): string {
  const path = join(root, name);
  writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}
