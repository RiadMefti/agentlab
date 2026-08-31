import type { FactoryCanaryTaskReservation, Sha256Digest } from "@agentlab/contracts";
import { describe, expect, it, vi } from "vitest";

import { FactoryCanaryAdmissionService } from "../../packages/runtime/src/application/factory-canary-admission-service.js";
import type {
  FactoryCanaryReservationRepository,
  FactoryCanaryReservationSnapshot,
  FactoryCanaryReservationWriteResult
} from "../../packages/runtime/src/domain/factory-canary-reservation-repository.js";
import type { CanonicalFactoryDocument } from "../../packages/runtime/src/domain/factory-documents.js";
import {
  TEST_CANARY_RESERVATION_ID,
  testFactoryCanaryAdmissionFixture
} from "../helpers/factory-canary-admission.js";
import { testEvalDigest } from "../helpers/factory-evaluation.js";

describe("FactoryCanaryAdmissionService", () => {
  it("re-verifies and idempotently reserves one exact scheduled task", async () => {
    const fixture = testFactoryCanaryAdmissionFixture();
    const reservations = new MemoryReservations();
    const requireVerifiedAttestation = vi.fn(() => Promise.resolve(fixture.attestation));
    const createId = vi.fn(() => TEST_CANARY_RESERVATION_ID);
    const service = new FactoryCanaryAdmissionService({
      ...pins(fixture),
      canaries: {
        findByCohortDigest: () => Promise.resolve(fixture.canarySnapshot)
      },
      evaluations: {
        findByAssessmentDigest: () => Promise.resolve(fixture.evaluation.snapshot)
      },
      attestations: { requireVerifiedAttestation },
      preparations: { findById: () => Promise.resolve(fixture.preparation) },
      reservations,
      documents: fixture.documents,
      now: () => "2026-08-30T12:02:00.000Z",
      createId
    });
    const command = { taskId: fixture.preparation.request.taskId, ...pins(fixture) };

    const first = await service.reserve(command);
    const second = await service.reserve(command);

    expect(first).toMatchObject({
      schemaVersion: "agentlab.canary-admission-result.v1",
      status: "reserved",
      reservation: {
        cohortDigest: fixture.canary.cohort.digest,
        attestationDigest: fixture.attestation.attestationDigest,
        challengerCandidateDigest: fixture.candidateDigest,
        taskId: fixture.preparation.request.taskId,
        maximumRiskTier: "R1",
        autoMerge: false,
        release: false
      }
    });
    expect(second).toEqual({ ...first, status: "existing" });
    expect(requireVerifiedAttestation).toHaveBeenCalledTimes(2);
    expect(reservations.reserveCalls).toBe(1);
    expect(createId).toHaveBeenCalledOnce();
  });

  it("fails closed on reviewed-pin drift, candidate drift, and post-verification expiry", async () => {
    const fixture = testFactoryCanaryAdmissionFixture();
    const build = (now: string) =>
      new FactoryCanaryAdmissionService({
        ...pins(fixture),
        canaries: { findByCohortDigest: () => Promise.resolve(fixture.canarySnapshot) },
        evaluations: {
          findByAssessmentDigest: () => Promise.resolve(fixture.evaluation.snapshot)
        },
        attestations: {
          requireVerifiedAttestation: () => Promise.resolve(fixture.attestation)
        },
        preparations: { findById: () => Promise.resolve(fixture.preparation) },
        reservations: new MemoryReservations(),
        documents: fixture.documents,
        now: () => now,
        createId: () => TEST_CANARY_RESERVATION_ID
      });
    const command = { taskId: fixture.preparation.request.taskId, ...pins(fixture) };

    await expect(
      build("2026-08-30T12:02:00.000Z").reserve({
        ...command,
        expectedCandidateDigest: testEvalDigest(999)
      })
    ).rejects.toThrow(/pin changed/u);

    const drifted = testFactoryCanaryAdmissionFixture();
    const badPreparation = {
      ...drifted.preparation,
      authority: {
        ...drifted.preparation.authority,
        skills: drifted.preparation.authority.skills.slice(0, -1)
      }
    };
    const candidateDrift = new FactoryCanaryAdmissionService({
      ...pins(drifted),
      canaries: { findByCohortDigest: () => Promise.resolve(drifted.canarySnapshot) },
      evaluations: {
        findByAssessmentDigest: () => Promise.resolve(drifted.evaluation.snapshot)
      },
      attestations: {
        requireVerifiedAttestation: () => Promise.resolve(drifted.attestation)
      },
      preparations: { findById: () => Promise.resolve(badPreparation) },
      reservations: new MemoryReservations(),
      documents: drifted.documents,
      now: () => "2026-08-30T12:02:00.000Z",
      createId: () => TEST_CANARY_RESERVATION_ID
    });
    await expect(candidateDrift.reserve(command)).rejects.toThrow(/candidate/u);

    await expect(build("2026-08-31T12:00:00.000Z").reserve(command)).rejects.toThrow(
      /not currently valid/u
    );
  });
});

function pins(fixture: ReturnType<typeof testFactoryCanaryAdmissionFixture>) {
  return {
    expectedCohortDigest: fixture.canary.cohort.digest,
    expectedCandidateDigest: fixture.candidateDigest,
    expectedSchedulePolicyDigest: fixture.schedulePolicyDigest,
    expectedPolicyBundleDigest: fixture.preparation.authority.policyBundleDigest,
    expectedRoleIdentityPolicyDigest:
      fixture.attestation.attestation.signedAttestation.statement.predicate.roleIdentityPolicyDigest
  };
}

class MemoryReservations implements FactoryCanaryReservationRepository {
  readonly #byTask = new Map<string, FactoryCanaryReservationSnapshot>();
  public reserveCalls = 0;

  public reserve(
    reservation: CanonicalFactoryDocument<FactoryCanaryTaskReservation>
  ): Promise<FactoryCanaryReservationWriteResult> {
    this.reserveCalls += 1;
    const existing = this.#byTask.get(reservation.value.taskId);
    if (existing !== undefined) {
      if (existing.reservationDigest !== reservation.digest) {
        throw new Error("Factory task already has different immutable canary authority.");
      }
      return Promise.resolve({ status: "existing", ...existing });
    }
    const snapshot = {
      reservation: reservation.value,
      reservationDigest: reservation.digest
    };
    this.#byTask.set(reservation.value.taskId, snapshot);
    return Promise.resolve({ status: "reserved", ...snapshot });
  }

  public findByTaskId(taskId: string): Promise<FactoryCanaryReservationSnapshot | null> {
    return Promise.resolve(this.#byTask.get(taskId) ?? null);
  }

  public findByReservationDigest(
    reservationDigest: Sha256Digest
  ): Promise<FactoryCanaryReservationSnapshot | null> {
    return Promise.resolve(
      [...this.#byTask.values()].find(
        (snapshot) => snapshot.reservationDigest === reservationDigest
      ) ?? null
    );
  }

  public listByCohortDigest(
    cohortDigest: Sha256Digest
  ): Promise<readonly FactoryCanaryReservationSnapshot[]> {
    return Promise.resolve(
      [...this.#byTask.values()].filter(
        ({ reservation }) => reservation.cohortDigest === cohortDigest
      )
    );
  }

  public close(): void {
    this.#byTask.clear();
  }
}
