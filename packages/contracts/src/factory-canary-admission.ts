import { z } from "zod";

import {
  factoryActorSchema,
  factoryBudgetSchema,
  factoryIdentifierSchema,
  factoryTimestampSchema,
  gitObjectIdSchema,
  sha256DigestSchema
} from "./factory.js";
import { factoryCanaryStageSchema } from "./factory-evaluation.js";

/**
 * One conservative reservation of a complete task ceiling against an attested canary cohort.
 * The record grants no merge or release authority and names no remote credential.
 */
export const factoryCanaryTaskReservationSchema = z
  .object({
    schemaVersion: z.literal("agentlab.canary-task-reservation.v1"),
    reservationId: z.uuid(),
    cohortId: z.uuid(),
    cohortDigest: sha256DigestSchema,
    approvalDigest: sha256DigestSchema,
    assessmentDigest: sha256DigestSchema,
    attestationDigest: sha256DigestSchema,
    roleIdentityPolicyDigest: sha256DigestSchema,
    challengerCandidateDigest: sha256DigestSchema,
    schedulePolicyDigest: sha256DigestSchema,
    policyBundleDigest: sha256DigestSchema,
    stage: factoryCanaryStageSchema,
    repository: z
      .object({
        id: factoryIdentifierSchema,
        baseRevision: gitObjectIdSchema
      })
      .strict(),
    taskId: z.uuid(),
    requestDigest: sha256DigestSchema,
    preparationAuthorityDigest: sha256DigestSchema,
    maximumRiskTier: z.enum(["R0", "R1"]),
    budget: factoryBudgetSchema,
    reservedAt: factoryTimestampSchema,
    expiresAt: factoryTimestampSchema,
    actor: factoryActorSchema,
    autoMerge: z.literal(false),
    release: z.literal(false)
  })
  .strict()
  .superRefine((reservation, context) => {
    if (reservation.expiresAt <= reservation.reservedAt) {
      context.addIssue({
        code: "custom",
        path: ["expiresAt"],
        message: "A canary task reservation must expire after it is recorded."
      });
    }
    if (
      reservation.actor.kind !== "control-plane" ||
      reservation.actor.role !== "policy-engine" ||
      reservation.actor.id !== "agentlab-canary-admission" ||
      reservation.actor.sessionId !== null
    ) {
      context.addIssue({
        code: "custom",
        path: ["actor"],
        message: "Canary task reservations require the deterministic admission actor."
      });
    }
  });

export type FactoryCanaryTaskReservation = z.infer<typeof factoryCanaryTaskReservationSchema>;
