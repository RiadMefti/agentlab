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
