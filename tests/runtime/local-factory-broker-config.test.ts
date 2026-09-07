import { chmod, link, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { factoryCostPolicySchema } from "@agentlab/contracts";

import { loadLocalFactoryBrokerConfig } from "../../packages/runtime/src/infrastructure/filesystem/local-factory-broker-config.js";
import { loadLocalFactoryCostPolicy } from "../../packages/runtime/src/infrastructure/filesystem/local-factory-cost-policy.js";
import { createAutonomousR1FactoryPolicyBundle } from "../../packages/runtime/src/domain/factory-policy.js";
import {
  encodeCanonicalDocument,
  NodeFactoryDocumentCodec
} from "../../packages/runtime/src/infrastructure/persistence/canonical-factory-documents.js";
import { testFactoryAutonomousMergePolicy } from "../helpers/factory-autonomous-merge.js";
import { testFactoryDailyQuotaPolicy } from "../helpers/factory-daily-quota.js";
import { testFactoryRoleIdentityPolicy } from "../helpers/factory-evaluation.js";
import {
  testFactoryScheduleBudget,
  testFactorySchedulePolicy
} from "../helpers/factory-schedule.js";
import { testDigest } from "../helpers/factory.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true }))
  );
});

describe("local factory broker configuration boundary", () => {
  it("loads an exact owner-only configuration", async () => {
    const root = await temporaryRoot();
    const path = join(root, "broker.json");
    const config = validConfig(root);
    await writePrivateJson(path, config);

    await expect(loadLocalFactoryBrokerConfig(path)).resolves.toEqual(config);
  });

  it("loads v2 with one separately protected exact cost policy", async () => {
    const root = await temporaryRoot();
    const path = join(root, "broker.json");
    const costPolicyPath = join(root, "cost-policy.json");
    const costPolicy = factoryCostPolicySchema.parse(validCostPolicy());
    const config = {
      ...validConfig(root),
      schemaVersion: "agentlab.local-factory-broker.v2" as const,
      costPolicyPath
    };
    await writePrivateJson(costPolicyPath, costPolicy);
    await writePrivateJson(path, config);

    await expect(loadLocalFactoryBrokerConfig(path)).resolves.toEqual({ ...config, costPolicy });
    await expect(loadLocalFactoryCostPolicy(costPolicyPath)).resolves.toEqual(costPolicy);
  });

  it("loads v3 with independently protected canary schedule and role-policy pins", async () => {
    const root = await temporaryRoot();
    const path = join(root, "broker.json");
    const costPolicyPath = join(root, "cost-policy.json");
    const schedulePolicyPath = join(root, "schedule-policy.json");
    const roleIdentityPolicyPath = join(root, "role-identities.json");
    const costPolicy = validCostPolicy();
    const schedulePolicy = testFactorySchedulePolicy();
    const roleIdentityPolicy = testFactoryRoleIdentityPolicy({
      keyId: testDigest("8"),
      workerUserId: 1_001,
      attestorUserId: 1_002
    });
    const expectedRoleIdentityPolicyDigest = new NodeFactoryDocumentCodec().roleIdentityPolicy(
      roleIdentityPolicy
    ).digest;
    const config = {
      ...validConfig(root),
      schemaVersion: "agentlab.local-factory-broker.v3" as const,
      costPolicyPath,
      schedulePolicyPath,
      roleIdentityPolicyPath,
      expectedRoleIdentityPolicyDigest
    };
    await Promise.all([
      writePrivateJson(costPolicyPath, costPolicy),
      writePrivateJson(schedulePolicyPath, schedulePolicy),
      writePrivateJson(roleIdentityPolicyPath, roleIdentityPolicy),
      writePrivateJson(path, config)
    ]);

    await expect(loadLocalFactoryBrokerConfig(path)).resolves.toEqual({
      ...config,
      costPolicy,
      schedulePolicy,
      roleIdentityPolicy
    });
  });

  it("loads v4 with an independently protected aggregate quota pin", async () => {
    const root = await temporaryRoot();
    const path = join(root, "broker.json");
    const costPolicyPath = join(root, "cost-policy.json");
    const schedulePolicyPath = join(root, "schedule-policy.json");
    const dailyQuotaPolicyPath = join(root, "daily-quota-policy.json");
    const roleIdentityPolicyPath = join(root, "role-identities.json");
    const costPolicy = validCostPolicy();
    const schedulePolicy = testFactorySchedulePolicy();
    const dailyQuotaPolicy = testFactoryDailyQuotaPolicy({
      repositories: [
        {
          repositoryId: "riadmefti/agentlab",
          maximumTasksPerDay: 3,
          maximumDraftPullRequestsPerDay: 3,
          budget: testFactoryScheduleBudget()
        }
      ]
    });
    const roleIdentityPolicy = testFactoryRoleIdentityPolicy({
      keyId: testDigest("8"),
      workerUserId: 1_001,
      attestorUserId: 1_002
    });
    const codec = new NodeFactoryDocumentCodec();
    const config = {
      ...validConfig(root),
      schemaVersion: "agentlab.local-factory-broker.v4" as const,
      costPolicyPath,
      schedulePolicyPath,
      dailyQuotaPolicyPath,
      expectedDailyQuotaPolicyDigest: codec.dailyQuotaPolicy(dailyQuotaPolicy).digest,
      roleIdentityPolicyPath,
      expectedRoleIdentityPolicyDigest: codec.roleIdentityPolicy(roleIdentityPolicy).digest
    };
    await Promise.all([
      writePrivateJson(costPolicyPath, costPolicy),
      writePrivateJson(schedulePolicyPath, schedulePolicy),
      writePrivateJson(dailyQuotaPolicyPath, dailyQuotaPolicy),
      writePrivateJson(roleIdentityPolicyPath, roleIdentityPolicy),
      writePrivateJson(path, config)
    ]);

    await expect(loadLocalFactoryBrokerConfig(path)).resolves.toEqual({
      ...config,
      costPolicy,
      schedulePolicy,
      roleIdentityPolicy,
      dailyQuotaPolicy
    });
    await writePrivateJson(path, {
      ...config,
      expectedDailyQuotaPolicyDigest: testDigest("f")
    });
    await expect(loadLocalFactoryBrokerConfig(path)).rejects.toThrow(/quota policy changed/u);
    const unauthorizedPolicy = testFactoryDailyQuotaPolicy();
    await writePrivateJson(dailyQuotaPolicyPath, unauthorizedPolicy);
    await writePrivateJson(path, {
      ...config,
      expectedDailyQuotaPolicyDigest: codec.dailyQuotaPolicy(unauthorizedPolicy).digest
    });
    await expect(loadLocalFactoryBrokerConfig(path)).rejects.toThrow(/not authorized/u);
  });

  it("loads v5 only when broker checks and all autonomous policy digests agree", async () => {
    const root = await temporaryRoot();
    const path = join(root, "broker.json");
    const costPolicyPath = join(root, "cost-policy.json");
    const schedulePolicyPath = join(root, "schedule-policy.json");
    const dailyQuotaPolicyPath = join(root, "daily-quota-policy.json");
    const roleIdentityPolicyPath = join(root, "role-identities.json");
    const mergePolicyPath = join(root, "merge-policy.json");
    const costPolicy = factoryCostPolicySchema.parse(validCostPolicy());
    const schedulePolicy = testFactorySchedulePolicy();
    const dailyQuotaPolicy = testFactoryDailyQuotaPolicy({
      repositories: [
        {
          repositoryId: "riadmefti/agentlab",
          maximumTasksPerDay: 3,
          maximumDraftPullRequestsPerDay: 3,
          budget: testFactoryScheduleBudget()
        }
      ]
    });
    const roleIdentityPolicy = testFactoryRoleIdentityPolicy({
      keyId: testDigest("8"),
      workerUserId: 1_001,
      attestorUserId: 1_002
    });
    const codec = new NodeFactoryDocumentCodec();
    const schedule = codec.schedulePolicy(schedulePolicy);
    const dailyQuota = codec.dailyQuotaPolicy(dailyQuotaPolicy);
    const roles = codec.roleIdentityPolicy(roleIdentityPolicy);
    const mergePolicy = testFactoryAutonomousMergePolicy({
      schedulePolicyDigest: schedule.digest,
      dailyQuotaPolicyDigest: dailyQuota.digest,
      roleIdentityPolicyDigest: roles.digest,
      requiredStatusChecks: [
        { context: "verify", producerId: "github-app/15368" },
        { context: "factory-sandbox", producerId: "github-app/15368" }
      ]
    });
    const merge = codec.autonomousMergePolicy(mergePolicy);
    const factoryPolicyBundle = encodeCanonicalDocument(
      createAutonomousR1FactoryPolicyBundle({ costPolicy, mergePolicy: merge })
    );
    const config = {
      ...validConfig(root),
      schemaVersion: "agentlab.local-factory-broker.v5" as const,
      costPolicyPath,
      schedulePolicyPath,
      dailyQuotaPolicyPath,
      roleIdentityPolicyPath,
      mergePolicyPath,
      expectedFactoryPolicyBundleDigest: factoryPolicyBundle.digest,
      expectedSchedulePolicyDigest: schedule.digest,
      expectedDailyQuotaPolicyDigest: dailyQuota.digest,
      expectedRoleIdentityPolicyDigest: roles.digest,
      expectedMergePolicyDigest: merge.digest
    };
    await Promise.all([
      writePrivateJson(costPolicyPath, costPolicy),
      writePrivateJson(schedulePolicyPath, schedulePolicy),
      writePrivateJson(dailyQuotaPolicyPath, dailyQuotaPolicy),
      writePrivateJson(roleIdentityPolicyPath, roleIdentityPolicy),
      writePrivateJson(mergePolicyPath, mergePolicy),
      writePrivateJson(path, config)
    ]);

    await expect(loadLocalFactoryBrokerConfig(path)).resolves.toEqual({
      ...config,
      costPolicy,
      schedulePolicy,
      dailyQuotaPolicy,
      roleIdentityPolicy,
      autonomousMergePolicy: mergePolicy
    });

    await writePrivateJson(mergePolicyPath, {
      ...mergePolicy,
      requiredStatusChecks: [
        { context: "verify", producerId: "github-app/999" },
        { context: "factory-sandbox", producerId: "github-app/15368" }
      ]
    });
    const changedMerge = codec.autonomousMergePolicy({
      ...mergePolicy,
      requiredStatusChecks: [
        { context: "verify", producerId: "github-app/999" },
        { context: "factory-sandbox", producerId: "github-app/15368" }
      ]
    });
    await writePrivateJson(path, {
      ...config,
      expectedMergePolicyDigest: changedMerge.digest,
      expectedFactoryPolicyBundleDigest: encodeCanonicalDocument(
        createAutonomousR1FactoryPolicyBundle({ costPolicy, mergePolicy: changedMerge })
      ).digest
    });
    await expect(loadLocalFactoryBrokerConfig(path)).rejects.toThrow(/status-check identities/u);
  });

  it("rejects unknown fields, unsafe numbers, relative fields, and malformed JSON", async () => {
    const root = await temporaryRoot();
    const path = join(root, "broker.json");

    await writePrivateJson(path, { ...validConfig(root), surprise: true });
    await expect(loadLocalFactoryBrokerConfig(path)).rejects.toThrow();

    await writePrivateJson(path, {
      ...validConfig(root),
      costPolicyPath: join(root, "cost-policy.json")
    });
    await expect(loadLocalFactoryBrokerConfig(path)).rejects.toThrow();

    await writePrivateJson(path, {
      ...validConfig(root),
      repositoryNumericId: Number.MAX_SAFE_INTEGER + 1
    });
    await expect(loadLocalFactoryBrokerConfig(path)).rejects.toThrow();

    await writePrivateJson(path, { ...validConfig(root), artifactRoot: "relative/artifacts" });
    await expect(loadLocalFactoryBrokerConfig(path)).rejects.toThrow(/normalized absolute/u);

    await writePrivateJson(path, {
      ...validConfig(root),
      githubApp: {
        ...validConfig(root).githubApp,
        trustedStatusChecks: [
          { context: "verify", appId: 15_368 },
          { context: "verify", appId: 15_368 }
        ]
      }
    });
    await expect(loadLocalFactoryBrokerConfig(path)).rejects.toThrow(/trusted status checks/iu);

    await writeFile(path, "{]", { encoding: "utf8", mode: 0o600 });
    await chmod(path, 0o600);
    await expect(loadLocalFactoryBrokerConfig(path)).rejects.toThrow(/not valid JSON/u);
  });

  it("rejects permissive, symbolic-link, hard-linked, and relative config paths", async () => {
    const root = await temporaryRoot();
    const path = join(root, "broker.json");
    const linkedPath = join(root, "linked.json");
    const symbolicPath = join(root, "symbolic.json");
    const canonicalDirectory = join(root, "canonical");
    const aliasDirectory = join(root, "alias");
    await writePrivateJson(path, validConfig(root));

    await chmod(path, 0o644);
    await expect(loadLocalFactoryBrokerConfig(path)).rejects.toThrow(/owner-only/u);

    await chmod(path, 0o600);
    await symlink(path, symbolicPath);
    await expect(loadLocalFactoryBrokerConfig(symbolicPath)).rejects.toThrow(
      /owner-only|canonical/u
    );

    await mkdir(canonicalDirectory, { mode: 0o700 });
    await writePrivateJson(join(canonicalDirectory, "broker.json"), validConfig(root));
    await symlink(canonicalDirectory, aliasDirectory);
    await expect(loadLocalFactoryBrokerConfig(join(aliasDirectory, "broker.json"))).rejects.toThrow(
      /canonical/u
    );

    await link(path, linkedPath);
    await expect(loadLocalFactoryBrokerConfig(path)).rejects.toThrow(/owner-only/u);
    await expect(loadLocalFactoryBrokerConfig("broker.json")).rejects.toThrow(
      /bounded absolute path/u
    );
  });

  it("rejects missing, malformed, permissive, or non-exact v2 cost policy", async () => {
    const root = await temporaryRoot();
    const path = join(root, "broker.json");
    const costPolicyPath = join(root, "cost-policy.json");
    const config = {
      ...validConfig(root),
      schemaVersion: "agentlab.local-factory-broker.v2" as const,
      costPolicyPath
    };
    await writePrivateJson(path, config);

    await expect(loadLocalFactoryBrokerConfig(path)).rejects.toThrow();

    await writePrivateJson(costPolicyPath, { ...validCostPolicy(), mutableFallback: 0 });
    await expect(loadLocalFactoryBrokerConfig(path)).rejects.toThrow();

    await writePrivateJson(costPolicyPath, {
      ...validCostPolicy(),
      rules: [{ ...validCostPolicy().rules[0], model: "gpt-*" }]
    });
    await expect(loadLocalFactoryBrokerConfig(path)).rejects.toThrow(/exact model/iu);

    await writePrivateJson(costPolicyPath, validCostPolicy());
    await chmod(costPolicyPath, 0o644);
    await expect(loadLocalFactoryBrokerConfig(path)).rejects.toThrow(/owner-only/u);
  });
});

function validConfig(root: string) {
  return {
    schemaVersion: "agentlab.local-factory-broker.v1",
    databasePath: join(root, "agentlab.sqlite"),
    artifactRoot: join(root, "artifacts"),
    temporaryRoot: join(root, "temporary"),
    repositoryId: "riadmefti/agentlab",
    repositoryNumericId: 12_345,
    brokerId: "agentlab-pr-broker",
    gitExecutable: join(root, "git"),
    githubApp: {
      clientId: "Iv1.agentlab-test",
      installationId: 67_890,
      privateKeyPath: join(root, "github-app.pem"),
      trustedStatusChecks: [
        { context: "verify", appId: 15_368 },
        { context: "factory-sandbox", appId: 15_368 }
      ]
    }
  } as const;
}

function validCostPolicy() {
  return {
    schemaVersion: "agentlab.cost-policy.v1",
    id: "agentlab/live-costs",
    version: "1.0.0",
    rules: [
      {
        provider: "codex",
        model: "gpt-5.4",
        accounting: {
          mode: "token-rate",
          inputMicrousdPerMillionTokens: 1_000_000,
          outputMicrousdPerMillionTokens: 2_000_000
        }
      },
      {
        provider: "claude",
        model: "claude-sonnet-4-6",
        accounting: { mode: "provider-reported" }
      }
    ]
  } as const;
}

async function writePrivateJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, JSON.stringify(value), { encoding: "utf8", mode: 0o600 });
  await chmod(path, 0o600);
}

async function temporaryRoot(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agentlab-broker-config-")));
  temporaryRoots.push(root);
  return root;
}
