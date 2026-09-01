import type {
  LocalFactoryCanaryAdmissionConfig,
  LocalFactoryCanaryAdmissionRuntime
} from "@agentlab/runtime/factory-canary-admission";
import { describe, expect, it, vi } from "vitest";

import {
  runFactoryCanaryAdmissionTick,
  runFactoryCanaryReserve
} from "../../apps/tui/src/run-factory-canary-admission.js";
import {
  testFactoryCanaryAdmissionFixture,
  testFactoryCanaryReservationDocument
} from "../helpers/factory-canary-admission.js";
import { testEvalDigest, testFactoryRoleIdentityPolicy } from "../helpers/factory-evaluation.js";
import { testFactorySchedulePolicy } from "../helpers/factory-schedule.js";

describe("factory canary admission CLI runner", () => {
  it("loads exact pins, reserves once, closes, and emits compact deterministic JSON", async () => {
    const fixture = testFactoryCanaryAdmissionFixture();
    const reservation = testFactoryCanaryReservationDocument(fixture);
    const config = admissionConfig(fixture);
    const reserve = vi.fn(() =>
      Promise.resolve({
        schemaVersion: "agentlab.canary-admission-result.v1" as const,
        status: "reserved" as const,
        reservation: reservation.value,
        reservationDigest: reservation.digest
      })
    );
    const close = vi.fn(() => Promise.resolve());
    const runtime: LocalFactoryCanaryAdmissionRuntime = {
      commands: {
        reserve,
        tick: () => Promise.reject(new Error("not configured"))
      },
      close
    };
    const write = vi.fn();

    await expect(
      runFactoryCanaryReserve("/private/canary-admission.json", reservation.value.taskId, {
        loadConfig: vi.fn(() => Promise.resolve(config)),
        createRuntime: vi.fn(() => runtime),
        write
      })
    ).resolves.toBe(0);

    expect(reserve).toHaveBeenCalledWith({
      taskId: reservation.value.taskId,
      expectedCohortDigest: config.expectedCohortDigest,
      expectedCandidateDigest: config.expectedCandidateDigest,
      expectedSchedulePolicyDigest: config.expectedSchedulePolicyDigest,
      expectedPolicyBundleDigest: config.expectedPolicyBundleDigest,
      expectedRoleIdentityPolicyDigest: config.expectedRoleIdentityPolicyDigest
    });
    expect(close).toHaveBeenCalledOnce();
    const output = JSON.parse(String(write.mock.calls[0]?.[0])) as Record<string, unknown>;
    expect(output).toMatchObject({
      schemaVersion: "agentlab.canary-admission-command-result.v1",
      status: "reserved",
      reservationDigest: reservation.digest,
      cohortDigest: reservation.value.cohortDigest,
      taskId: reservation.value.taskId,
      autoMerge: false,
      release: false
    });
  });

  it("rejects invalid boundaries and closes after an operation failure", async () => {
    const fixture = testFactoryCanaryAdmissionFixture();
    const config = admissionConfig(fixture);
    const close = vi.fn(() => Promise.resolve());
    const runtime: LocalFactoryCanaryAdmissionRuntime = {
      commands: {
        reserve: () => Promise.reject(new Error("reservation failed")),
        tick: () => Promise.reject(new Error("not configured"))
      },
      close
    };
    const dependencies = {
      loadConfig: vi.fn(() => Promise.resolve(config)),
      createRuntime: vi.fn(() => runtime),
      write: vi.fn()
    };

    await expect(
      runFactoryCanaryReserve("relative.json", fixture.preparation.request.taskId, dependencies)
    ).rejects.toThrow(/absolute config path/u);
    await expect(
      runFactoryCanaryReserve("/private/admission.json", "not-a-task", dependencies)
    ).rejects.toThrow(/task ID/u);
    await expect(
      runFactoryCanaryReserve(
        "/private/admission.json",
        fixture.preparation.request.taskId,
        dependencies
      )
    ).rejects.toThrow(/reservation failed/u);
    expect(close).toHaveBeenCalledOnce();
  });

  it("runs automatic admission only with v2 config and five explicit pins", async () => {
    const fixture = testFactoryCanaryAdmissionFixture();
    const config = admissionConfigV2(fixture);
    const tick = vi.fn(() =>
      Promise.resolve({
        schemaVersion: "agentlab.canary-admission-tick-result.v1" as const,
        status: "completed" as const,
        schedulePolicyDigest: config.expectedSchedulePolicyDigest,
        candidates: 1,
        reserved: 1,
        existing: 0,
        skipped: 0,
        reasonCodes: []
      })
    );
    const close = vi.fn(() => Promise.resolve());
    const runtime: LocalFactoryCanaryAdmissionRuntime = {
      commands: {
        reserve: () => Promise.reject(new Error("not used")),
        tick
      },
      close
    };
    const write = vi.fn();

    await expect(
      runFactoryCanaryAdmissionTick(
        "/private/canary-admission.json",
        config.expectedCohortDigest,
        config.expectedCandidateDigest,
        config.expectedSchedulePolicyDigest,
        config.expectedRoleIdentityPolicyDigest,
        config.expectedPolicyBundleDigest,
        {
          loadConfig: vi.fn(() => Promise.resolve(config)),
          createRuntime: vi.fn(() => runtime),
          write
        }
      )
    ).resolves.toBe(0);
    expect(tick).toHaveBeenCalledWith({
      expectedCohortDigest: config.expectedCohortDigest,
      expectedCandidateDigest: config.expectedCandidateDigest,
      expectedSchedulePolicyDigest: config.expectedSchedulePolicyDigest,
      expectedRoleIdentityPolicyDigest: config.expectedRoleIdentityPolicyDigest,
      expectedPolicyBundleDigest: config.expectedPolicyBundleDigest
    });
    expect(close).toHaveBeenCalledOnce();
    expect(JSON.parse(String(write.mock.calls[0]?.[0]))).toMatchObject({
      status: "completed",
      reserved: 1,
      skipped: 0
    });

    await expect(
      runFactoryCanaryAdmissionTick(
        "/private/canary-admission.json",
        config.expectedCohortDigest,
        config.expectedCandidateDigest,
        config.expectedSchedulePolicyDigest,
        config.expectedRoleIdentityPolicyDigest,
        config.expectedPolicyBundleDigest,
        {
          loadConfig: () => Promise.resolve(admissionConfig(fixture)),
          createRuntime: () => runtime,
          write
        }
      )
    ).rejects.toThrow(/requires config v2/u);
  });
});

function admissionConfig(
  fixture: ReturnType<typeof testFactoryCanaryAdmissionFixture>
): LocalFactoryCanaryAdmissionConfig {
  const trustedKeyId = testEvalDigest(901);
  return {
    schemaVersion: "agentlab.local-factory-canary-admission.v1",
    databasePath: "/private/agentlab.sqlite",
    runnerId: "trusted-eval-runner",
    trustedPublicKeyPath: "/private/eval-public.pem",
    trustedKeyId,
    roleIdentityPolicyPath: "/private/role-identities.json",
    expectedRoleIdentityPolicyDigest:
      fixture.attestation.attestation.signedAttestation.statement.predicate
        .roleIdentityPolicyDigest,
    expectedCohortDigest: fixture.canary.cohort.digest,
    expectedCandidateDigest: fixture.candidateDigest,
    expectedSchedulePolicyDigest: fixture.schedulePolicyDigest,
    expectedPolicyBundleDigest: fixture.preparation.authority.policyBundleDigest,
    maximumIssuanceDelaySeconds: 300,
    maximumAttestationLifetimeSeconds: 3_600,
    roleIdentityPolicy: testFactoryRoleIdentityPolicy({
      keyId: trustedKeyId,
      workerUserId: 1001,
      attestorUserId: 1002
    })
  };
}

function admissionConfigV2(
  fixture: ReturnType<typeof testFactoryCanaryAdmissionFixture>
): LocalFactoryCanaryAdmissionConfig {
  const legacy = admissionConfig(fixture);
  return {
    ...legacy,
    schemaVersion: "agentlab.local-factory-canary-admission.v2",
    schedulePolicyPath: "/private/schedule.json",
    schedulePolicy: testFactorySchedulePolicy()
  };
}
