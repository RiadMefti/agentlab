import { createHash } from "node:crypto";
import { chmod, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadLocalFactoryOrchestrationConfig } from "../../packages/runtime/src/infrastructure/filesystem/local-factory-orchestration-config.js";
import { encodeCanonicalDocument } from "../../packages/runtime/src/infrastructure/persistence/canonical-factory-documents.js";
import { testFactoryAutonomousMergePolicy } from "../helpers/factory-autonomous-merge.js";
import { testFactoryDailyQuotaPolicy } from "../helpers/factory-daily-quota.js";
import { testFactoryRoleIdentityPolicy } from "../helpers/factory-evaluation.js";
import { testFactoryOperationsHealthPolicy } from "../helpers/factory-operations-health.js";
import { testFactorySchedulePolicy } from "../helpers/factory-schedule.js";
import { testDigest } from "../helpers/factory.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true }))
  );
});

describe("local factory orchestration configuration boundary", () => {
  it("loads owner-only policies and verifies the exact AgentLab executable", async () => {
    const fixture = await createFixture();

    await expect(loadLocalFactoryOrchestrationConfig(fixture.configPath)).resolves.toEqual({
      ...fixture.manifest,
      schedulePolicy: fixture.schedulePolicy,
      roleIdentityPolicy: fixture.roleIdentityPolicy
    });
  });

  it("rejects policy or executable drift and non-canonical paths", async () => {
    const fixture = await createFixture();

    await writePrivateJson(fixture.configPath, {
      ...fixture.manifest,
      expectedSchedulePolicyDigest: testDigest("f")
    });
    await expect(loadLocalFactoryOrchestrationConfig(fixture.configPath)).rejects.toThrow(
      /schedule policy changed/u
    );

    await writePrivateJson(fixture.configPath, fixture.manifest);
    await writeFile(fixture.executablePath, "#!/bin/sh\nexit 1\n", { mode: 0o700 });
    await expect(loadLocalFactoryOrchestrationConfig(fixture.configPath)).rejects.toThrow(
      /executable changed/u
    );

    await writeFile(fixture.executablePath, fixture.executableContent, { mode: 0o700 });
    await chmod(fixture.executablePath, 0o720);
    await expect(loadLocalFactoryOrchestrationConfig(fixture.configPath)).rejects.toThrow(
      /immutable to runtime role identities/u
    );

    await chmod(fixture.executablePath, 0o700);
    const executableLink = join(fixture.root, "agentlab-link");
    await symlink(fixture.executablePath, executableLink);
    await writePrivateJson(fixture.configPath, {
      ...fixture.manifest,
      agentlabExecutable: { ...fixture.manifest.agentlabExecutable, path: executableLink }
    });
    await expect(loadLocalFactoryOrchestrationConfig(fixture.configPath)).rejects.toThrow(
      /canonical and symlink-free/u
    );
  });

  it("loads the v4 containment, quota, and separate capability pins", async () => {
    const fixture = await createFixture();
    const dailyQuotaPolicyPath = join(fixture.root, "daily-quota.json");
    const dailyQuotaPolicy = testFactoryDailyQuotaPolicy();
    const operationsHealthPolicyPath = join(fixture.root, "operations-health.json");
    const operationsHealthPolicy = testFactoryOperationsHealthPolicy();
    const unavailableUserIds = new Set<number>([
      fixture.manifest.worker.userId,
      fixture.manifest.broker.userId,
      fixture.roleIdentityPolicy.evalAttestor.userId
    ]);
    const incidentUserId = [1_004, 1_005, 1_006, 1_007].find(
      (candidate) => !unavailableUserIds.has(candidate)
    );
    if (incidentUserId === undefined) throw new Error("No isolated incident test identity.");
    const manifest = {
      ...fixture.manifest,
      schemaVersion: "agentlab.daily-cycle-manifest.v4",
      incident: {
        userId: incidentUserId,
        configPath: join(fixture.root, "incident.json")
      },
      incidentCommandTimeoutSeconds: 120,
      operationsHealthPolicyPath,
      expectedOperationsHealthPolicyDigest: encodeCanonicalDocument(operationsHealthPolicy).digest,
      maintenanceDiscoveryConfigPath: join(fixture.root, "maintenance-discovery.json"),
      canaryAdmissionConfigPath: join(fixture.root, "canary-admission.json"),
      dailyQuotaPolicyPath,
      expectedDailyQuotaPolicyDigest: encodeCanonicalDocument(dailyQuotaPolicy).digest,
      expectedMaintenanceDiscoveryPolicyDigest: testDigest("5"),
      expectedPreparationGrantDigest: testDigest("6"),
      expectedCanaryCohortDigest: testDigest("7"),
      expectedCanaryCandidateDigest: testDigest("8")
    } as const;
    await Promise.all([
      writePrivateJson(dailyQuotaPolicyPath, dailyQuotaPolicy),
      writePrivateJson(operationsHealthPolicyPath, operationsHealthPolicy)
    ]);
    await writePrivateJson(fixture.configPath, manifest);

    await expect(loadLocalFactoryOrchestrationConfig(fixture.configPath)).resolves.toEqual({
      ...manifest,
      schedulePolicy: fixture.schedulePolicy,
      roleIdentityPolicy: fixture.roleIdentityPolicy,
      dailyQuotaPolicy,
      operationsHealthPolicy
    });

    await writePrivateJson(fixture.configPath, {
      ...manifest,
      expectedDailyQuotaPolicyDigest: testDigest("f")
    });
    await expect(loadLocalFactoryOrchestrationConfig(fixture.configPath)).rejects.toThrow(
      /quota policy changed/u
    );

    await writePrivateJson(fixture.configPath, {
      ...manifest,
      expectedOperationsHealthPolicyDigest: testDigest("f")
    });
    await expect(loadLocalFactoryOrchestrationConfig(fixture.configPath)).rejects.toThrow(
      /operations health policy changed/u
    );
  });

  it("loads v5 only when merger, broker, and every autonomous policy pin agree", async () => {
    const fixture = await createFixture();
    const dailyQuotaPolicyPath = join(fixture.root, "daily-quota.json");
    const dailyQuotaPolicy = testFactoryDailyQuotaPolicy();
    const operationsHealthPolicyPath = join(fixture.root, "operations-health.json");
    const operationsHealthPolicy = testFactoryOperationsHealthPolicy();
    const mergePolicyPath = join(fixture.root, "merge-policy.json");
    const unavailableUserIds = new Set<number>([
      process.getuid?.() ?? 0,
      fixture.manifest.worker.userId,
      fixture.manifest.broker.userId,
      fixture.roleIdentityPolicy.evalAttestor.userId
    ]);
    const [incidentUserId, mergerUserId] = [1_004, 1_005, 1_006, 1_007, 1_008].filter(
      (candidate) => !unavailableUserIds.has(candidate)
    );
    if (incidentUserId === undefined || mergerUserId === undefined) {
      throw new Error("No isolated autonomous merge test identities.");
    }
    const schedulePolicyDigest = encodeCanonicalDocument(fixture.schedulePolicy).digest;
    const dailyQuotaPolicyDigest = encodeCanonicalDocument(dailyQuotaPolicy).digest;
    const roleIdentityPolicyDigest = encodeCanonicalDocument(fixture.roleIdentityPolicy).digest;
    const mergePolicy = testFactoryAutonomousMergePolicy({
      mergerUserId,
      prBrokerUserId: fixture.manifest.broker.userId,
      schedulePolicyDigest,
      dailyQuotaPolicyDigest,
      roleIdentityPolicyDigest
    });
    const manifest = {
      ...fixture.manifest,
      schemaVersion: "agentlab.daily-cycle-manifest.v5",
      incident: { userId: incidentUserId, configPath: join(fixture.root, "incident.json") },
      merger: { userId: mergerUserId, configPath: join(fixture.root, "merger.json") },
      incidentCommandTimeoutSeconds: 120,
      mergeAdmissionCommandTimeoutSeconds: 300,
      mergerCommandTimeoutSeconds: 900,
      operationsHealthPolicyPath,
      mergeAdmissionConfigPath: join(fixture.root, "merge-admission.json"),
      mergePolicyPath,
      expectedOperationsHealthPolicyDigest: encodeCanonicalDocument(operationsHealthPolicy).digest,
      expectedMergePolicyDigest: encodeCanonicalDocument(mergePolicy).digest,
      maintenanceDiscoveryConfigPath: join(fixture.root, "maintenance-discovery.json"),
      canaryAdmissionConfigPath: join(fixture.root, "canary-admission.json"),
      dailyQuotaPolicyPath,
      expectedDailyQuotaPolicyDigest: dailyQuotaPolicyDigest,
      expectedMaintenanceDiscoveryPolicyDigest: testDigest("5"),
      expectedPreparationGrantDigest: testDigest("6"),
      expectedCanaryCohortDigest: testDigest("7"),
      expectedCanaryCandidateDigest: testDigest("8")
    } as const;
    await Promise.all([
      writePrivateJson(dailyQuotaPolicyPath, dailyQuotaPolicy),
      writePrivateJson(operationsHealthPolicyPath, operationsHealthPolicy),
      writePrivateJson(mergePolicyPath, mergePolicy),
      writePrivateJson(fixture.configPath, manifest)
    ]);

    await expect(loadLocalFactoryOrchestrationConfig(fixture.configPath)).resolves.toEqual({
      ...manifest,
      schedulePolicy: fixture.schedulePolicy,
      roleIdentityPolicy: fixture.roleIdentityPolicy,
      dailyQuotaPolicy,
      operationsHealthPolicy,
      autonomousMergePolicy: mergePolicy
    });

    await writePrivateJson(fixture.configPath, {
      ...manifest,
      merger: { ...manifest.merger, userId: incidentUserId }
    });
    await expect(loadLocalFactoryOrchestrationConfig(fixture.configPath)).rejects.toThrow(
      /separate operating-system identity/u
    );
  });

  it("rejects permissive, linked, relative, and structurally unsafe manifests", async () => {
    const fixture = await createFixture();
    await chmod(fixture.configPath, 0o644);
    await expect(loadLocalFactoryOrchestrationConfig(fixture.configPath)).rejects.toThrow(
      /owner-only/u
    );

    await chmod(fixture.configPath, 0o600);
    const linkPath = join(fixture.root, "orchestration-link.json");
    await symlink(fixture.configPath, linkPath);
    await expect(loadLocalFactoryOrchestrationConfig(linkPath)).rejects.toThrow(
      /owner-only|canonical/u
    );
    await expect(loadLocalFactoryOrchestrationConfig("orchestration.json")).rejects.toThrow(
      /bounded absolute path/u
    );

    await writePrivateJson(fixture.configPath, {
      ...fixture.manifest,
      broker: { ...fixture.manifest.broker, userId: fixture.manifest.worker.userId }
    });
    await expect(loadLocalFactoryOrchestrationConfig(fixture.configPath)).rejects.toThrow(
      /different operating-system identities/u
    );
  });
});

async function createFixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agentlab-orchestration-config-")));
  temporaryRoots.push(root);
  const configPath = join(root, "orchestration.json");
  const schedulePolicyPath = join(root, "schedule.json");
  const roleIdentityPolicyPath = join(root, "roles.json");
  const executablePath = join(root, "agentlab");
  const executableContent = "#!/bin/sh\nprintf 'agentlab test\\n'\n";
  const ownerUserId = process.getuid?.() ?? 0;
  const workerUserId = ownerUserId === 1_001 ? 1_004 : 1_001;
  const attestorUserId = ownerUserId === 1_002 ? 1_005 : 1_002;
  const brokerUserId = ownerUserId === 1_003 ? 1_006 : 1_003;
  const schedulePolicy = testFactorySchedulePolicy();
  const roleIdentityPolicy = testFactoryRoleIdentityPolicy({
    keyId: testDigest("8"),
    workerUserId,
    attestorUserId
  });
  await Promise.all([
    writePrivateJson(schedulePolicyPath, schedulePolicy),
    writePrivateJson(roleIdentityPolicyPath, roleIdentityPolicy),
    writeFile(executablePath, executableContent, { mode: 0o700 })
  ]);
  await chmod(executablePath, 0o700);
  const manifest = {
    schemaVersion: "agentlab.daily-cycle-manifest.v1",
    id: "agentlab/daily-software-factory",
    version: "1.0.0",
    agentlabExecutable: {
      path: executablePath,
      digest: `sha256:${createHash("sha256").update(executableContent).digest("hex")}`
    },
    executableChecksumPath: "/etc/agentlab/factory-executable.sha256",
    worker: { userId: workerUserId, configPath: join(root, "worker.json") },
    broker: { userId: brokerUserId, configPath: join(root, "broker.json") },
    schedulePolicyPath,
    roleIdentityPolicyPath,
    expectedSchedulePolicyDigest: encodeCanonicalDocument(schedulePolicy).digest,
    expectedRoleIdentityPolicyDigest: encodeCanonicalDocument(roleIdentityPolicy).digest,
    expectedFactoryPolicyBundleDigest: testDigest("4"),
    maximumRepairRounds: 2,
    workerCommandTimeoutSeconds: 7_230,
    brokerCommandTimeoutSeconds: 900
  } as const;
  await writePrivateJson(configPath, manifest);
  return {
    root,
    configPath,
    executablePath,
    executableContent,
    manifest,
    schedulePolicy,
    roleIdentityPolicy
  };
}

async function writePrivateJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, JSON.stringify(value), { encoding: "utf8", mode: 0o600 });
  await chmod(path, 0o600);
}
