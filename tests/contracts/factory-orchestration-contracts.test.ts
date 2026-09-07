import {
  factoryDailyCycleBundleSchema,
  factoryDailyCycleManifestSchema
} from "@agentlab/contracts";
import { describe, expect, it } from "vitest";

import { testDigest } from "../helpers/factory.js";

describe("factory daily-cycle contracts", () => {
  it("admits one strict command-free manifest with separated OS identities", () => {
    const manifest = validManifest();

    expect(factoryDailyCycleManifestSchema.parse(manifest)).toEqual(manifest);
    expect(
      factoryDailyCycleManifestSchema.safeParse({ ...manifest, shellCommand: "do everything" })
        .success
    ).toBe(false);
    expect(
      factoryDailyCycleManifestSchema.safeParse({
        ...manifest,
        broker: { ...manifest.broker, userId: manifest.worker.userId }
      }).success
    ).toBe(false);
    expect(
      factoryDailyCycleManifestSchema.safeParse({
        ...manifest,
        worker: { ...manifest.worker, configPath: "/safe/worker.json\nOnSuccess=evil" }
      }).success
    ).toBe(false);
    expect(
      factoryDailyCycleManifestSchema.safeParse({
        ...manifest,
        executableChecksumPath: "/tmp/changeable.sha256"
      }).success
    ).toBe(false);
  });

  it("bounds content-addressed bundles and exact unit names", () => {
    const digest = testDigest("a");
    const bundle = {
      schemaVersion: "agentlab.daily-cycle-bundle.v1",
      manifestDigest: digest,
      schedulePolicyDigest: digest,
      roleIdentityPolicyDigest: digest,
      factoryPolicyBundleDigest: digest,
      agentlabExecutableDigest: digest,
      executableVerification: {
        verifierPath: "/usr/bin/sha256sum",
        checksumFilePath: "/etc/agentlab/factory-executable.sha256",
        checksumContent: `${"a".repeat(64)}  /opt/agentlab/bin/agentlab\n`,
        checksumDigest: digest
      },
      timerUnit: "agentlab-factory-daily.timer",
      units: [
        {
          name: "agentlab-factory-incident.target",
          kind: "target",
          content: "[Unit]\nDescription=incident\n",
          digest
        },
        {
          name: "agentlab-factory-scheduler.service",
          kind: "service",
          content: "[Service]\nType=oneshot\n",
          digest
        },
        {
          name: "agentlab-factory-draft.service",
          kind: "service",
          content: "[Service]\nType=oneshot\n",
          digest
        },
        {
          name: "agentlab-factory-daily.timer",
          kind: "timer",
          content: "[Timer]\nOnCalendar=daily\n",
          digest
        }
      ],
      bundleDigest: digest
    };

    expect(factoryDailyCycleBundleSchema.parse(bundle)).toEqual(bundle);
    expect(
      factoryDailyCycleBundleSchema.safeParse({
        ...bundle,
        units: [{ ...bundle.units[0], name: "arbitrary.service" }]
      }).success
    ).toBe(false);
  });

  it("pins every autonomous producer and consumer in a separate v2 capability config", () => {
    const manifest = {
      ...validManifest(),
      schemaVersion: "agentlab.daily-cycle-manifest.v2",
      maintenanceDiscoveryConfigPath: "/etc/agentlab/maintenance-discovery.json",
      canaryAdmissionConfigPath: "/etc/agentlab/canary-admission.json",
      expectedMaintenanceDiscoveryPolicyDigest: testDigest("5"),
      expectedPreparationGrantDigest: testDigest("6"),
      expectedCanaryCohortDigest: testDigest("7"),
      expectedCanaryCandidateDigest: testDigest("8")
    } as const;

    expect(factoryDailyCycleManifestSchema.parse(manifest)).toEqual(manifest);
    expect(
      factoryDailyCycleManifestSchema.safeParse({
        ...manifest,
        canaryAdmissionConfigPath: manifest.worker.configPath
      }).success
    ).toBe(false);
    expect(
      factoryDailyCycleManifestSchema.safeParse({
        ...manifest,
        expectedCanaryCohortDigest: "latest"
      }).success
    ).toBe(false);
  });

  it("pins a distinct disable-only incident role before a v4 autonomous cycle", () => {
    const manifest = {
      ...validManifest(),
      schemaVersion: "agentlab.daily-cycle-manifest.v4",
      incident: { userId: 1_004, configPath: "/etc/agentlab/incident.json" },
      incidentCommandTimeoutSeconds: 120,
      operationsHealthPolicyPath: "/etc/agentlab/operations-health-policy.json",
      expectedOperationsHealthPolicyDigest: testDigest("a"),
      maintenanceDiscoveryConfigPath: "/etc/agentlab/maintenance-discovery.json",
      canaryAdmissionConfigPath: "/etc/agentlab/canary-admission.json",
      dailyQuotaPolicyPath: "/etc/agentlab/daily-quota.json",
      expectedDailyQuotaPolicyDigest: testDigest("9"),
      expectedMaintenanceDiscoveryPolicyDigest: testDigest("5"),
      expectedPreparationGrantDigest: testDigest("6"),
      expectedCanaryCohortDigest: testDigest("7"),
      expectedCanaryCandidateDigest: testDigest("8")
    } as const;

    expect(factoryDailyCycleManifestSchema.parse(manifest)).toEqual(manifest);
    expect(
      factoryDailyCycleManifestSchema.safeParse({
        ...manifest,
        incident: { ...manifest.incident, userId: manifest.worker.userId }
      }).success
    ).toBe(false);
    expect(
      factoryDailyCycleManifestSchema.safeParse({
        ...manifest,
        incident: { ...manifest.incident, configPath: manifest.broker.configPath }
      }).success
    ).toBe(false);
  });

  it("pins separate admission configuration and merger identity in v5", () => {
    const manifest = {
      ...validManifest(),
      schemaVersion: "agentlab.daily-cycle-manifest.v5",
      incident: { userId: 1_004, configPath: "/etc/agentlab/incident.json" },
      merger: { userId: 1_005, configPath: "/etc/agentlab/merger.json" },
      incidentCommandTimeoutSeconds: 120,
      mergeAdmissionCommandTimeoutSeconds: 300,
      mergerCommandTimeoutSeconds: 900,
      operationsHealthPolicyPath: "/etc/agentlab/operations-health-policy.json",
      mergeAdmissionConfigPath: "/etc/agentlab/merge-admission.json",
      mergePolicyPath: "/etc/agentlab/merge-policy.json",
      expectedOperationsHealthPolicyDigest: testDigest("a"),
      expectedMergePolicyDigest: testDigest("b"),
      maintenanceDiscoveryConfigPath: "/etc/agentlab/maintenance-discovery.json",
      canaryAdmissionConfigPath: "/etc/agentlab/canary-admission.json",
      dailyQuotaPolicyPath: "/etc/agentlab/daily-quota.json",
      expectedDailyQuotaPolicyDigest: testDigest("9"),
      expectedMaintenanceDiscoveryPolicyDigest: testDigest("5"),
      expectedPreparationGrantDigest: testDigest("6"),
      expectedCanaryCohortDigest: testDigest("7"),
      expectedCanaryCandidateDigest: testDigest("8")
    } as const;

    expect(factoryDailyCycleManifestSchema.parse(manifest)).toEqual(manifest);
    expect(
      factoryDailyCycleManifestSchema.safeParse({
        ...manifest,
        merger: { ...manifest.merger, userId: manifest.broker.userId }
      }).success
    ).toBe(false);
    expect(
      factoryDailyCycleManifestSchema.safeParse({
        ...manifest,
        mergeAdmissionConfigPath: manifest.worker.configPath
      }).success
    ).toBe(false);
  });
});

function validManifest() {
  return {
    schemaVersion: "agentlab.daily-cycle-manifest.v1",
    id: "agentlab/daily-software-factory",
    version: "1.0.0",
    agentlabExecutable: { path: "/opt/agentlab/bin/agentlab", digest: testDigest("1") },
    executableChecksumPath: "/etc/agentlab/factory-executable.sha256",
    worker: { userId: 1_001, configPath: "/etc/agentlab/worker.json" },
    broker: { userId: 1_003, configPath: "/etc/agentlab/broker.json" },
    schedulePolicyPath: "/etc/agentlab/schedule.json",
    roleIdentityPolicyPath: "/etc/agentlab/roles.json",
    expectedSchedulePolicyDigest: testDigest("2"),
    expectedRoleIdentityPolicyDigest: testDigest("3"),
    expectedFactoryPolicyBundleDigest: testDigest("4"),
    maximumRepairRounds: 2,
    workerCommandTimeoutSeconds: 7_230,
    brokerCommandTimeoutSeconds: 900
  } as const;
}
