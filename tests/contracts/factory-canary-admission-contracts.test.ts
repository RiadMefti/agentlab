import { factoryCanaryTaskReservationSchema } from "@agentlab/contracts";
import { describe, expect, it } from "vitest";

import { testEvalDigest, testFactoryEvalBudget } from "../helpers/factory-evaluation.js";

describe("factory canary admission contracts", () => {
  it("accepts only one strict, expiring, non-release task reservation", () => {
    const reservation = factoryCanaryTaskReservationSchema.parse({
      schemaVersion: "agentlab.canary-task-reservation.v1",
      reservationId: "10000000-0000-4000-8000-000000000010",
      cohortId: "10000000-0000-4000-8000-000000000011",
      cohortDigest: testEvalDigest(1),
      approvalDigest: testEvalDigest(2),
      assessmentDigest: testEvalDigest(3),
      attestationDigest: testEvalDigest(4),
      roleIdentityPolicyDigest: testEvalDigest(5),
      challengerCandidateDigest: testEvalDigest(6),
      schedulePolicyDigest: testEvalDigest(7),
      policyBundleDigest: testEvalDigest(8),
      stage: "brokered-draft-pr",
      repository: { id: "agentlab", baseRevision: "a".repeat(40) },
      taskId: "10000000-0000-4000-8000-000000000012",
      requestDigest: testEvalDigest(9),
      preparationAuthorityDigest: testEvalDigest(10),
      maximumRiskTier: "R1",
      budget: testFactoryEvalBudget(),
      reservedAt: "2026-08-30T12:01:00.000Z",
      expiresAt: "2026-08-31T12:00:00.000Z",
      actor: {
        kind: "control-plane",
        role: "policy-engine",
        id: "agentlab-canary-admission",
        sessionId: null
      },
      autoMerge: false,
      release: false
    });

    expect(factoryCanaryTaskReservationSchema.parse(reservation)).toEqual(reservation);
    expect(() =>
      factoryCanaryTaskReservationSchema.parse({ ...reservation, autoMerge: true })
    ).toThrow();
    expect(() =>
      factoryCanaryTaskReservationSchema.parse({
        ...reservation,
        actor: { ...reservation.actor, id: "worker" }
      })
    ).toThrow(/deterministic admission actor/u);
    expect(() =>
      factoryCanaryTaskReservationSchema.parse({
        ...reservation,
        expiresAt: reservation.reservedAt
      })
    ).toThrow(/expire after/u);
    expect(() =>
      factoryCanaryTaskReservationSchema.parse({ ...reservation, unexpected: true })
    ).toThrow();
  });
});
