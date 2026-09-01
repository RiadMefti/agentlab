import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadLocalFactoryMaintenanceDiscoveryConfig } from "../../packages/runtime/src/infrastructure/filesystem/local-factory-maintenance-discovery-config.js";
import { NodeFactoryDocumentCodec } from "../../packages/runtime/src/infrastructure/persistence/canonical-factory-documents.js";
import { testFactoryRoleIdentityPolicy } from "../helpers/factory-evaluation.js";
import { testFactoryIntakePolicyFixture } from "../helpers/factory-intake.js";
import { testFactoryMaintenanceDiscoveryFixture } from "../helpers/factory-maintenance-discovery.js";
import { testFactorySchedulePolicy } from "../helpers/factory-schedule.js";
import { testDigest } from "../helpers/factory.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true }))
  );
});

describe("local factory maintenance discovery configuration boundary", () => {
  it("loads only a scheduled worker v3 plus exact discovery and preparation inputs", async () => {
    const fixture = await createFixture();

    const loaded = await loadLocalFactoryMaintenanceDiscoveryConfig(fixture.configPath);

    expect(loaded).toMatchObject({
      schemaVersion: "agentlab.local-factory-maintenance-discovery.v1",
      repositoryRoot: fixture.repositoryRoot,
      repositoryId: "owner/agentlab",
      discoveryPolicy: fixture.discovery.policy,
      discoverySkillPackage: fixture.discovery.skillPackage,
      preparationGrant: fixture.intake.grant,
      workerConfig: {
        schemaVersion: "agentlab.local-factory-worker.v3",
        schedulePolicy: fixture.schedulePolicy,
        roleIdentityPolicy: fixture.roleIdentityPolicy
      }
    });
    expect(loaded.preparationSkillPackages).toEqual(fixture.intake.packages);
  });

  it("rejects non-v3 workers, overlapping storage, and permissive config files", async () => {
    const fixture = await createFixture();
    await writePrivate(fixture.workerConfigPath, {
      ...fixture.workerConfig,
      schemaVersion: "agentlab.local-factory-worker.v2",
      roleIdentityPolicyPath: undefined,
      expectedRoleIdentityPolicyDigest: undefined
    });
    await expect(loadLocalFactoryMaintenanceDiscoveryConfig(fixture.configPath)).rejects.toThrow();

    await writePrivate(fixture.workerConfigPath, fixture.workerConfig);
    await writePrivate(fixture.configPath, {
      ...fixture.config,
      repositoryRoot: fixture.workerConfig.artifactRoot
    });
    await expect(loadLocalFactoryMaintenanceDiscoveryConfig(fixture.configPath)).rejects.toThrow(
      /must remain outside/u
    );

    await writePrivate(fixture.configPath, fixture.config);
    await chmod(fixture.configPath, 0o644);
    await expect(loadLocalFactoryMaintenanceDiscoveryConfig(fixture.configPath)).rejects.toThrow(
      /owner-only/u
    );
  });
});

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "agentlab-maintenance-discovery-config-"));
  temporaryRoots.push(root);
  const configPath = join(root, "maintenance-discovery.json");
  const workerConfigPath = join(root, "worker.json");
  const costPolicyPath = join(root, "cost.json");
  const schedulePolicyPath = join(root, "schedule.json");
  const roleIdentityPolicyPath = join(root, "roles.json");
  const discoveryPolicyPath = join(root, "discovery-policy.json");
  const discoverySkillPackagePath = join(root, "discovery-skill.json");
  const preparationGrantPath = join(root, "preparation-grant.json");
  const repositoryRoot = "/source/owner-agentlab";
  const discovery = testFactoryMaintenanceDiscoveryFixture();
  const intake = testFactoryIntakePolicyFixture();
  const schedulePolicy = testFactorySchedulePolicy();
  const roleIdentityPolicy = testFactoryRoleIdentityPolicy({
    keyId: testDigest("a"),
    workerUserId: 1_001,
    attestorUserId: 1_002
  });
  const expectedRoleIdentityPolicyDigest = new NodeFactoryDocumentCodec().roleIdentityPolicy(
    roleIdentityPolicy
  ).digest;
  const preparationSkillPackagePaths = intake.packages.map((_, index) =>
    join(root, `preparation-skill-${String(index + 1)}.json`)
  );
  const workerConfig = {
    schemaVersion: "agentlab.local-factory-worker.v3",
    databasePath: join(root, "storage", "agentlab.sqlite"),
    artifactRoot: join(root, "storage", "artifacts"),
    workspaceRoot: join(root, "storage", "worktrees"),
    costPolicyPath,
    schedulePolicyPath,
    roleIdentityPolicyPath,
    expectedRoleIdentityPolicyDigest,
    gitExecutable: "/usr/bin/git",
    flockExecutable: "/usr/bin/flock",
    systemd: {
      runExecutable: "/usr/bin/systemd-run",
      controlExecutable: "/usr/bin/systemctl",
      environmentExecutable: "/usr/bin/env",
      version: "systemd 261"
    },
    sandbox: {
      bubblewrapExecutable: "/usr/bin/bwrap",
      runtimeRoots: ["/opt/agentlab/node"]
    },
    providers: [
      {
        provider: "codex",
        executable: "/opt/agentlab/bin/codex",
        executableDigest: testDigest("b"),
        version: "codex-cli 1.2.3"
      }
    ],
    gates: gateDefinitions()
  } as const;
  const config = {
    schemaVersion: "agentlab.local-factory-maintenance-discovery.v1",
    workerConfigPath,
    repositoryRoot,
    repositoryId: "owner/agentlab",
    conversationId: "86000000-0000-4000-8000-000000000001",
    discoveryPolicyPath,
    discoverySkillPackagePath,
    preparationGrantPath,
    preparationSkillPackagePaths,
    authorityLifetimeSeconds: 3_600
  } as const;
  await Promise.all([
    writePrivate(costPolicyPath, intake.costPolicy),
    writePrivate(schedulePolicyPath, schedulePolicy),
    writePrivate(roleIdentityPolicyPath, roleIdentityPolicy),
    writePrivate(discoveryPolicyPath, discovery.policy),
    writePrivate(discoverySkillPackagePath, discovery.skillPackage),
    writePrivate(preparationGrantPath, intake.grant),
    ...preparationSkillPackagePaths.map((path, index) => writePrivate(path, intake.packages[index]))
  ]);
  await writePrivate(workerConfigPath, workerConfig);
  await writePrivate(configPath, config);
  return {
    configPath,
    workerConfigPath,
    repositoryRoot,
    workerConfig,
    config,
    discovery,
    intake,
    schedulePolicy,
    roleIdentityPolicy
  };
}

function gateDefinitions() {
  const evidenceKinds = {
    format: "test",
    architecture: "test",
    typecheck: "test",
    lint: "test",
    test: "test",
    build: "build",
    "secret-scan": "security"
  } as const;
  return Object.entries(evidenceKinds).map(([id, evidenceKind]) => ({
    id,
    evidenceKind,
    command: { executable: "/usr/bin/npm", args: ["run", id] },
    timeoutMs: 600_000,
    maximumOutputBytes: 8 * 1_024 * 1_024
  }));
}

async function writePrivate(path: string, value: unknown): Promise<void> {
  await writeFile(path, JSON.stringify(value), { encoding: "utf8", mode: 0o600 });
  await chmod(path, 0o600);
}
