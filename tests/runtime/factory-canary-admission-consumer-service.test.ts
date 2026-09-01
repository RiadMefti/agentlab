import { describe, expect, it, vi } from "vitest";

import { FactoryCanaryAdmissionConsumerService } from "../../packages/runtime/src/application/factory-canary-admission-consumer-service.js";
import { ConflictError } from "../../packages/runtime/src/domain/errors.js";
import type { FactoryDocumentCodec } from "../../packages/runtime/src/domain/factory-documents.js";
import { NodeFactoryDocumentCodec } from "../../packages/runtime/src/infrastructure/persistence/canonical-factory-documents.js";
import { testFactoryCanaryAdmissionFixture } from "../helpers/factory-canary-admission.js";
import { testFactorySchedulePolicy } from "../helpers/factory-schedule.js";
import { testDigest } from "../helpers/factory.js";

describe("FactoryCanaryAdmissionConsumerService", () => {
  it("reserves one bounded page only while scheduler authority is enabled", async () => {
    const first = testFactoryCanaryAdmissionFixture();
    const second = testFactoryCanaryAdmissionFixture({
      taskId: "22000000-0000-4000-8000-000000000002",
      deduplicationKey: testDigest("d")
    });
    const documents: FactoryDocumentCodec = new NodeFactoryDocumentCodec();
    const schedulePolicy = documents.schedulePolicy(
      testFactorySchedulePolicy({ maximumTasksPerTick: 1, maximumCandidatesPerTick: 2 })
    );
    const reserve = vi.fn((command: { readonly taskId: string }) =>
      Promise.resolve({
        schemaVersion: "agentlab.canary-admission-result.v1" as const,
        status: "reserved" as const,
        reservation: {} as never,
        reservationDigest: testDigest(
          command.taskId === first.preparation.request.taskId ? "1" : "2"
        )
      })
    );
    const dependencies = {
      schedulePolicy,
      pins: pins(first, schedulePolicy.digest),
      controls: { state: () => Promise.resolve({ scheduler: true, prBroker: false }) },
      preparations: {
        listScheduled: () => Promise.resolve([first.preparation, second.preparation])
      },
      reservations: { findByTaskId: () => Promise.resolve(null) },
      admission: { reserve }
    };

    await expect(
      new FactoryCanaryAdmissionConsumerService(dependencies).tick(dependencies.pins)
    ).resolves.toEqual({
      schemaVersion: "agentlab.canary-admission-tick-result.v1",
      status: "completed",
      schedulePolicyDigest: schedulePolicy.digest,
      candidates: 2,
      reserved: 1,
      existing: 0,
      skipped: 0,
      reasonCodes: []
    });
    expect(reserve).toHaveBeenCalledTimes(1);
    expect(reserve).toHaveBeenCalledWith({
      taskId: first.preparation.request.taskId,
      ...dependencies.pins
    });

    await expect(
      new FactoryCanaryAdmissionConsumerService({
        ...dependencies,
        controls: { state: () => Promise.resolve({ scheduler: false, prBroker: false }) }
      }).tick(dependencies.pins)
    ).resolves.toMatchObject({
      status: "blocked",
      reserved: 0,
      reasonCodes: ["scheduler-disabled"]
    });
  });

  it("counts existing reservations and safely skips authority denials", async () => {
    const first = testFactoryCanaryAdmissionFixture();
    const second = testFactoryCanaryAdmissionFixture({
      taskId: "22000000-0000-4000-8000-000000000002",
      deduplicationKey: testDigest("d")
    });
    const documents: FactoryDocumentCodec = new NodeFactoryDocumentCodec();
    const schedulePolicy = documents.schedulePolicy(testFactorySchedulePolicy());
    const configuredPins = pins(first, schedulePolicy.digest);
    const service = new FactoryCanaryAdmissionConsumerService({
      schedulePolicy,
      pins: configuredPins,
      controls: { state: () => Promise.resolve({ scheduler: true, prBroker: false }) },
      preparations: {
        listScheduled: () => Promise.resolve([first.preparation, second.preparation])
      },
      reservations: {
        findByTaskId: (taskId) =>
          Promise.resolve(taskId === first.preparation.request.taskId ? ({} as never) : null)
      },
      admission: {
        reserve: () => Promise.reject(new ConflictError("cohort capacity is exhausted"))
      }
    });

    await expect(service.tick(configuredPins)).resolves.toMatchObject({
      status: "blocked",
      candidates: 2,
      reserved: 0,
      existing: 1,
      skipped: 1,
      reasonCodes: ["task-canary-admission-denied"]
    });
    await expect(
      service.tick({ ...configuredPins, expectedCandidateDigest: testDigest("f") })
    ).rejects.toThrow(/pins changed/u);
  });
});

function pins(
  fixture: ReturnType<typeof testFactoryCanaryAdmissionFixture>,
  schedulePolicyDigest: string
) {
  return {
    expectedCohortDigest: fixture.canary.cohort.digest,
    expectedCandidateDigest: fixture.candidateDigest,
    expectedSchedulePolicyDigest: schedulePolicyDigest,
    expectedPolicyBundleDigest: fixture.preparation.authority.policyBundleDigest,
    expectedRoleIdentityPolicyDigest:
      fixture.attestation.attestation.signedAttestation.statement.predicate.roleIdentityPolicyDigest
  };
}
