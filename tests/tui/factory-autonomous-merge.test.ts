import { sha256DigestSchema, type Sha256Digest } from "@agentlab/contracts";
import type {
  FactoryAutonomousMergeAdmissionPreflight,
  LocalFactoryAutonomousMergeAdmissionConfig,
  LocalFactoryAutonomousMergeAdmissionRuntime
} from "@agentlab/runtime/factory-autonomous-merge-admission";
import type {
  FactoryAutonomousMergePreflight,
  FactoryAutonomousMergeTickReport,
  LocalFactoryAutonomousMergerConfig,
  LocalFactoryAutonomousMergerRuntime
} from "@agentlab/runtime/factory-autonomous-merger";
import { describe, expect, it, vi } from "vitest";

import {
  runFactoryAutonomousMergeAdmission,
  runFactoryAutonomousMergeAdmissionPreflight,
  runFactoryAutonomousMergeAdmissionTick
} from "../../apps/tui/src/run-factory-autonomous-merge-admission.js";
import {
  runFactoryAutonomousMergerPreflight,
  runFactoryAutonomousMergerTick
} from "../../apps/tui/src/run-factory-autonomous-merger.js";

const digests = Array.from({ length: 7 }, (_, index) =>
  sha256DigestSchema.parse(`sha256:${String(index + 1).repeat(64)}`)
);

describe("autonomous merge CLI runners", () => {
  it("reports credentialless admission readiness only after closing", async () => {
    const events: string[] = [];
    const runtime: LocalFactoryAutonomousMergeAdmissionRuntime = {
      commands: {
        preflight: () => Promise.resolve(admissionPreflight()),
        admit: () => Promise.resolve({ status: "denied", reasonCodes: [] }),
        tick: () => Promise.resolve(admissionTickReport())
      },
      close: () => {
        events.push("closed");
        return Promise.resolve();
      }
    };

    await expect(
      runFactoryAutonomousMergeAdmissionPreflight("/private/merge-admission.json", {
        loadConfig: () => Promise.resolve({} as LocalFactoryAutonomousMergeAdmissionConfig),
        createRuntime: () => runtime,
        write: (message) => events.push(message)
      })
    ).resolves.toBe(0);

    expect(events[0]).toBe("closed");
    expect(JSON.parse(events[1] ?? "")).toEqual(admissionPreflight());
  });

  it("passes every immutable coordinate to admission and reports deterministic denial", async () => {
    const admit = vi.fn(() =>
      Promise.resolve({ status: "denied" as const, reasonCodes: ["observation-stale"] })
    );
    const writes: string[] = [];
    const runtime: LocalFactoryAutonomousMergeAdmissionRuntime = {
      commands: {
        preflight: () => Promise.resolve(admissionPreflight()),
        admit,
        tick: () => Promise.resolve(admissionTickReport())
      },
      close: () => Promise.resolve()
    };
    const input = {
      configPath: "/private/merge-admission.json",
      taskId: "0198f005-4ec4-7000-8000-000000000001",
      observationDigest: requiredDigest(0),
      canaryReservationDigest: requiredDigest(1),
      expectedMergePolicyDigest: requiredDigest(2),
      expectedFactoryPolicyBundleDigest: requiredDigest(3),
      expectedSchedulePolicyDigest: requiredDigest(4),
      expectedDailyQuotaPolicyDigest: requiredDigest(5),
      expectedRoleIdentityPolicyDigest: requiredDigest(6)
    };

    await expect(
      runFactoryAutonomousMergeAdmission(input, {
        loadConfig: () => Promise.resolve({} as LocalFactoryAutonomousMergeAdmissionConfig),
        createRuntime: () => runtime,
        write: (message) => writes.push(message)
      })
    ).resolves.toBe(2);

    expect(admit).toHaveBeenCalledWith({
      taskId: input.taskId,
      observationDigest: input.observationDigest,
      canaryReservationDigest: input.canaryReservationDigest,
      expectedMergePolicyDigest: input.expectedMergePolicyDigest,
      expectedFactoryPolicyBundleDigest: input.expectedFactoryPolicyBundleDigest,
      expectedSchedulePolicyDigest: input.expectedSchedulePolicyDigest,
      expectedDailyQuotaPolicyDigest: input.expectedDailyQuotaPolicyDigest,
      expectedRoleIdentityPolicyDigest: input.expectedRoleIdentityPolicyDigest
    });
    expect(JSON.parse(writes[0] ?? "")).toMatchObject({
      schemaVersion: "agentlab.autonomous-merge-admission-command-result.v1",
      status: "denied",
      reasonCodes: ["observation-stale"]
    });
  });

  it("preflights then admits one bounded page with exact policy pins", async () => {
    const tick = vi.fn(() => Promise.resolve(admissionTickReport()));
    const runtime: LocalFactoryAutonomousMergeAdmissionRuntime = {
      commands: {
        preflight: () => Promise.resolve(admissionPreflight()),
        admit: () => Promise.resolve({ status: "denied", reasonCodes: [] }),
        tick
      },
      close: () => Promise.resolve()
    };
    const writes: string[] = [];
    const input = {
      configPath: "/private/merge-admission.json",
      expectedMergePolicyDigest: requiredDigest(0),
      expectedFactoryPolicyBundleDigest: requiredDigest(1),
      expectedSchedulePolicyDigest: requiredDigest(2),
      expectedDailyQuotaPolicyDigest: requiredDigest(3),
      expectedRoleIdentityPolicyDigest: requiredDigest(4)
    };

    await expect(
      runFactoryAutonomousMergeAdmissionTick(input, {
        loadConfig: () => Promise.resolve({} as LocalFactoryAutonomousMergeAdmissionConfig),
        createRuntime: () => runtime,
        write: (message) => writes.push(message)
      })
    ).resolves.toBe(0);
    expect(tick).toHaveBeenCalledWith({
      expectedMergePolicyDigest: input.expectedMergePolicyDigest,
      expectedFactoryPolicyBundleDigest: input.expectedFactoryPolicyBundleDigest,
      expectedSchedulePolicyDigest: input.expectedSchedulePolicyDigest,
      expectedDailyQuotaPolicyDigest: input.expectedDailyQuotaPolicyDigest,
      expectedRoleIdentityPolicyDigest: input.expectedRoleIdentityPolicyDigest
    });
    expect(JSON.parse(writes[0] ?? "")).toMatchObject({
      schemaVersion: "agentlab.autonomous-merge-admission-tick-command-result.v1",
      status: "completed",
      report: { inspected: 1, authorized: 1 }
    });
  });

  it.each([true, false])(
    "runs merger reconciliation with merge authority enabled=%s",
    async (enabled) => {
      const tick = vi.fn(() => Promise.resolve(mergeReport()));
      const close = vi.fn(() => Promise.resolve());
      const writes: string[] = [];
      const runtime: LocalFactoryAutonomousMergerRuntime = {
        commands: {
          preflight: () =>
            Promise.resolve({
              ...mergerPreflight(),
              status: enabled ? "ready" : "blocked",
              mergeBrokerEnabled: enabled,
              reasonCodes: enabled ? [] : ["merge-broker-disabled"]
            }),
          tick
        },
        close
      };
      const dependencies = {
        loadConfig: () => Promise.resolve({} as LocalFactoryAutonomousMergerConfig),
        createRuntime: () => runtime,
        write: (message: string) => writes.push(message)
      };

      await expect(
        runFactoryAutonomousMergerPreflight("/private/merger.json", dependencies)
      ).resolves.toBe(enabled ? 0 : 2);
      await expect(
        runFactoryAutonomousMergerTick(
          {
            configPath: "/private/merger.json",
            expectedMergePolicyDigest: requiredDigest(0),
            expectedFactoryPolicyBundleDigest: requiredDigest(1),
            expectedSchedulePolicyDigest: requiredDigest(2),
            expectedDailyQuotaPolicyDigest: requiredDigest(3),
            expectedRoleIdentityPolicyDigest: requiredDigest(4)
          },
          dependencies
        )
      ).resolves.toBe(0);

      expect(tick).toHaveBeenCalledWith({
        expectedMergePolicyDigest: requiredDigest(0),
        expectedFactoryPolicyBundleDigest: requiredDigest(1),
        expectedSchedulePolicyDigest: requiredDigest(2),
        expectedDailyQuotaPolicyDigest: requiredDigest(3),
        expectedRoleIdentityPolicyDigest: requiredDigest(4)
      });
      expect(close).toHaveBeenCalledTimes(2);
      expect(JSON.parse(writes[1] ?? "")).toMatchObject({
        schemaVersion: "agentlab.autonomous-merger-command-result.v1",
        status: "completed",
        report: { inspected: 1, completed: 1 }
      });
    }
  );
});

function admissionPreflight(): FactoryAutonomousMergeAdmissionPreflight {
  return {
    schemaVersion: "agentlab.autonomous-merge-admission-preflight.v1",
    status: "ready",
    repositoryId: "riadmefti/agentlab",
    mergePolicyDigest: requiredDigest(0),
    factoryPolicyBundleDigest: requiredDigest(1),
    schedulerEnabled: true,
    prBrokerEnabled: true,
    mergeBrokerEnabled: true,
    credentialless: true,
    remoteWrite: false,
    directMerge: false,
    release: false,
    reasonCodes: []
  };
}

function mergerPreflight(): FactoryAutonomousMergePreflight {
  return {
    schemaVersion: "agentlab.autonomous-merge-preflight.v1",
    status: "ready",
    repositoryId: "riadmefti/agentlab",
    mergerId: "github-app/agentlab-merger",
    mergePolicyDigest: requiredDigest(0),
    factoryPolicyBundleDigest: requiredDigest(1),
    schedulerEnabled: true,
    prBrokerEnabled: true,
    mergeBrokerEnabled: true,
    deliveryMode: "merge-queue",
    directMerge: false,
    release: false,
    reasonCodes: []
  };
}

function admissionTickReport() {
  return {
    schemaVersion: "agentlab.autonomous-merge-admission-tick-result.v1" as const,
    status: "completed" as const,
    repositoryId: "riadmefti/agentlab",
    mergePolicyDigest: requiredDigest(0),
    inspected: 1,
    authorized: 1,
    denied: 0,
    reasonCodes: [],
    tasks: [
      {
        taskId: "0198f005-4ec4-7000-8000-000000000001",
        status: "authorized" as const,
        authorizationDigest: requiredDigest(6),
        reasonCodes: []
      }
    ]
  };
}

function mergeReport(): FactoryAutonomousMergeTickReport {
  return {
    schemaVersion: "agentlab.autonomous-merge-tick-result.v1",
    status: "completed",
    repositoryId: "riadmefti/agentlab",
    mergePolicyDigest: requiredDigest(0),
    inspected: 1,
    completed: 1,
    pending: 0,
    stale: 0,
    blocked: 0,
    quarantined: 0,
    reasonCodes: [],
    runs: []
  };
}

function requiredDigest(index: number): Sha256Digest {
  const digest = digests[index];
  if (digest === undefined) throw new Error("Missing test digest.");
  return digest;
}
