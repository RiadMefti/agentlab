import { describe, expect, it, vi } from "vitest";

import { runFactoryOrchestrationRender } from "../../apps/tui/src/run-factory-orchestration-render.js";
import type {
  FactoryDailyCycleBundle,
  LocalFactoryOrchestrationConfig
} from "../../packages/runtime/src/local-factory-orchestration.js";
import { testFactoryRoleIdentityPolicy } from "../helpers/factory-evaluation.js";
import { testFactorySchedulePolicy } from "../helpers/factory-schedule.js";
import { testDigest } from "../helpers/factory.js";

describe("factory orchestration render command", () => {
  it("loads, renders, and emits only the dormant content-addressed bundle", async () => {
    const config = validConfig();
    const bundle = validBundle();
    const loadConfig = vi.fn(() => Promise.resolve(config));
    const render = vi.fn(() => bundle);
    const write = vi.fn();

    await expect(
      runFactoryOrchestrationRender("/private/orchestration.json", {
        loadConfig,
        render,
        write
      })
    ).resolves.toBe(0);

    expect(loadConfig).toHaveBeenCalledWith("/private/orchestration.json");
    expect(render).toHaveBeenCalledWith(config);
    expect(write).toHaveBeenCalledWith(`${JSON.stringify(bundle, null, 2)}\n`);
  });

  it("rejects a relative path before reaching the configuration boundary", async () => {
    const loadConfig = vi.fn(() => Promise.resolve(validConfig()));

    await expect(
      runFactoryOrchestrationRender("orchestration.json", {
        loadConfig,
        render: () => validBundle(),
        write: vi.fn()
      })
    ).rejects.toThrow(/normalized absolute/u);
    expect(loadConfig).not.toHaveBeenCalled();
  });
});

function validConfig(): LocalFactoryOrchestrationConfig {
  return {
    schemaVersion: "agentlab.daily-cycle-manifest.v1",
    id: "agentlab/daily-software-factory",
    version: "1.0.0",
    agentlabExecutable: { path: "/opt/agentlab", digest: testDigest("1") },
    executableChecksumPath: "/etc/agentlab/factory-executable.sha256",
    worker: { userId: 1_001, configPath: "/private/worker.json" },
    broker: { userId: 1_003, configPath: "/private/broker.json" },
    schedulePolicyPath: "/private/schedule.json",
    roleIdentityPolicyPath: "/private/roles.json",
    expectedSchedulePolicyDigest: testDigest("2"),
    expectedRoleIdentityPolicyDigest: testDigest("3"),
    expectedFactoryPolicyBundleDigest: testDigest("4"),
    maximumRepairRounds: 1,
    workerCommandTimeoutSeconds: 7_230,
    brokerCommandTimeoutSeconds: 900,
    schedulePolicy: testFactorySchedulePolicy(),
    roleIdentityPolicy: testFactoryRoleIdentityPolicy({
      keyId: testDigest("8"),
      workerUserId: 1_001,
      attestorUserId: 1_002
    })
  };
}

function validBundle(): FactoryDailyCycleBundle {
  const digest = testDigest("a");
  return {
    schemaVersion: "agentlab.daily-cycle-bundle.v1",
    manifestDigest: digest,
    schedulePolicyDigest: digest,
    roleIdentityPolicyDigest: digest,
    factoryPolicyBundleDigest: digest,
    agentlabExecutableDigest: digest,
    executableVerification: {
      verifierPath: "/usr/bin/sha256sum",
      checksumFilePath: "/etc/agentlab/factory-executable.sha256",
      checksumContent: `${"a".repeat(64)}  /opt/agentlab\n`,
      checksumDigest: digest
    },
    timerUnit: "agentlab-factory-daily.timer",
    units: [
      {
        name: "agentlab-factory-incident.target",
        kind: "target",
        content: "target",
        digest
      },
      {
        name: "agentlab-factory-scheduler.service",
        kind: "service",
        content: "scheduler",
        digest
      },
      {
        name: "agentlab-factory-draft.service",
        kind: "service",
        content: "draft",
        digest
      },
      {
        name: "agentlab-factory-daily.timer",
        kind: "timer",
        content: "timer",
        digest
      }
    ],
    bundleDigest: digest
  };
}
