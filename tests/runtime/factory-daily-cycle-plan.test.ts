import { describe, expect, it } from "vitest";

import { compileFactoryDailyCyclePlan } from "../../packages/runtime/src/domain/factory-daily-cycle-plan.js";
import { renderSystemdFactoryDailyCycle } from "../../packages/runtime/src/infrastructure/process/systemd-factory-daily-cycle-renderer.js";
import { testFactoryRoleIdentityPolicy } from "../helpers/factory-evaluation.js";
import { testFactorySchedulePolicy } from "../helpers/factory-schedule.js";
import { testDigest } from "../helpers/factory.js";

describe("factory daily-cycle compiler", () => {
  it("renders a fixed stop-on-failure worker/broker sequence and final head observation", () => {
    const manifest = validManifest();
    const schedule = testFactorySchedulePolicy({
      tickBudget: { ...testFactorySchedulePolicy().tickBudget, maxRepairAttempts: 2 }
    });
    const roles = testFactoryRoleIdentityPolicy({
      keyId: testDigest("8"),
      workerUserId: 1_001,
      attestorUserId: 1_002
    });
    const plan = compileFactoryDailyCyclePlan(manifest, schedule, roles);
    const bundle = renderSystemdFactoryDailyCycle(manifest, plan);

    expect(plan.stages.map(({ id, role }) => `${id}:${role}`)).toEqual([
      "scheduler:worker",
      "draft:broker",
      "maintenance-1:broker",
      "repair-1:worker",
      "update-1:broker",
      "maintenance-2:broker",
      "repair-2:worker",
      "update-2:broker",
      "maintenance-3:broker"
    ]);
    expect(bundle.units).toHaveLength(11);
    expect(new Set(bundle.units.map(({ digest }) => digest)).size).toBe(bundle.units.length);
    const scheduler = requiredUnit(bundle.units, "agentlab-factory-scheduler.service");
    expect(scheduler.content).toContain("User=1001\n");
    expect(scheduler.content).toContain("OnFailure=agentlab-factory-incident.target\n");
    expect(scheduler.content).toContain("OnSuccess=agentlab-factory-draft.service\n");
    expect(scheduler.content).toContain('ExecStart=:"/opt/agentlab/bin/agentlab" "factory"');
    expect(scheduler.content).toContain(
      'ExecStartPre=:"/usr/bin/sha256sum" "--status" "--check" "/etc/agentlab/factory-executable.sha256"'
    );
    expect(scheduler.content).not.toContain('ExecStart=:"/bin/sh"');
    expect(scheduler.content).not.toContain('ExecStart=:"/usr/bin/bash"');
    const draft = requiredUnit(bundle.units, "agentlab-factory-draft.service");
    expect(draft.content).toContain("User=1003\n");
    expect(draft.content).not.toContain("XDG_RUNTIME_DIR");
    const finalObservation = requiredUnit(bundle.units, "agentlab-factory-maintenance-3.service");
    expect(finalObservation.content).not.toContain("OnSuccess=");
    const timer = requiredUnit(bundle.units, "agentlab-factory-daily.timer");
    expect(timer.content).toContain("OnCalendar=*-*-* 12:00:00 UTC\n");
    expect(timer.content).toContain("Persistent=false\n");
  });

  it("escapes systemd specifiers without interpreting environment or shell syntax", () => {
    const manifest = {
      ...validManifest(),
      maximumRepairRounds: 0,
      worker: { userId: 1_001, configPath: "/private/worker $HOME%slot.json" }
    };
    const plan = compileFactoryDailyCyclePlan(
      manifest,
      testFactorySchedulePolicy(),
      testFactoryRoleIdentityPolicy({
        keyId: testDigest("8"),
        workerUserId: 1_001,
        attestorUserId: 1_002
      })
    );
    const bundle = renderSystemdFactoryDailyCycle(manifest, plan);
    const scheduler = requiredUnit(bundle.units, "agentlab-factory-scheduler.service");

    expect(bundle.units).toHaveLength(4);
    expect(scheduler.content).toContain('"/private/worker $HOME%%slot.json"');
    expect(scheduler.content).toContain('ExecStart=:"/opt/agentlab/bin/agentlab"');
  });

  it("rejects identity collapse, excessive repair rounds, and truncating worker timeouts", () => {
    const schedule = testFactorySchedulePolicy({
      tickBudget: { ...testFactorySchedulePolicy().tickBudget, maxRepairAttempts: 1 }
    });
    const roles = testFactoryRoleIdentityPolicy({
      keyId: testDigest("8"),
      workerUserId: 1_001,
      attestorUserId: 1_002
    });

    expect(() =>
      compileFactoryDailyCyclePlan({ ...validManifest(), maximumRepairRounds: 2 }, schedule, roles)
    ).toThrow(/repair rounds/u);
    expect(() =>
      compileFactoryDailyCyclePlan(
        { ...validManifest(), maximumRepairRounds: 1, workerCommandTimeoutSeconds: 7_200 },
        schedule,
        roles
      )
    ).toThrow(/timeout/u);
    expect(() =>
      compileFactoryDailyCyclePlan(
        {
          ...validManifest(),
          maximumRepairRounds: 1,
          broker: { userId: 1_002, configPath: "/private/broker.json" }
        },
        schedule,
        roles
      )
    ).toThrow(/attestor/u);
  });
});

function validManifest() {
  return {
    schemaVersion: "agentlab.daily-cycle-manifest.v1",
    id: "agentlab/daily-software-factory",
    version: "1.0.0",
    agentlabExecutable: { path: "/opt/agentlab/bin/agentlab", digest: testDigest("1") },
    executableChecksumPath: "/etc/agentlab/factory-executable.sha256",
    worker: { userId: 1_001, configPath: "/private/worker.json" },
    broker: { userId: 1_003, configPath: "/private/broker.json" },
    schedulePolicyPath: "/private/schedule.json",
    roleIdentityPolicyPath: "/private/roles.json",
    expectedSchedulePolicyDigest: testDigest("2"),
    expectedRoleIdentityPolicyDigest: testDigest("3"),
    expectedFactoryPolicyBundleDigest: testDigest("4"),
    maximumRepairRounds: 2,
    workerCommandTimeoutSeconds: 7_230,
    brokerCommandTimeoutSeconds: 900
  } as const;
}

function requiredUnit(
  units: readonly { readonly name: string; readonly content: string }[],
  name: string
) {
  const found = units.find((unit) => unit.name === name);
  if (found === undefined) throw new Error(`Missing unit ${name}.`);
  return found;
}
