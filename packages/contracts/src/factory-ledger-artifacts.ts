import { z } from "zod";

import {
  factoryArtifactReferenceSchema,
  factoryIdentifierSchema,
  factoryTimestampSchema,
  sha256DigestSchema
} from "./factory.js";

export const maximumLedgerArtifactBytes = 8_388_608;
export const factoryLedgerArtifactPolicySchema = z
  .strictObject({
    schemaVersion: z.literal("agentlab.ledger-artifact-policy.v1"),
    expiresAt: factoryTimestampSchema,
    maximumArtifactBytes: z.number().int().min(1).max(maximumLedgerArtifactBytes),
    maximumTaskBytes: z.number().int().min(1).max(67_108_864),
    maximumTaskArtifacts: z.number().int().min(1).max(256),
    maximumTotalBytes: z.number().int().min(1).max(8_589_934_592),
    maximumTotalArtifacts: z.number().int().min(1).max(65536),
    principals: z
      .array(
        z.strictObject({
          uid: z.number().int().min(1).max(0xffff_fffe),
          id: factoryIdentifierSchema,
          kind: z.enum(["implementer", "reviewer", "gate-observer", "reader"])
        })
      )
      .min(1)
      .max(32)
  })
  .superRefine((policy, context) => {
    if (
      new Set(policy.principals.map(({ uid }) => uid)).size !== policy.principals.length ||
      new Set(policy.principals.map(({ id }) => id)).size !== policy.principals.length ||
      policy.maximumArtifactBytes > policy.maximumTaskBytes ||
      policy.maximumTaskBytes > policy.maximumTotalBytes ||
      policy.maximumTaskArtifacts > policy.maximumTotalArtifacts
    ) {
      context.addIssue({
        code: "custom",
        message: "Artifact policy requires distinct principals and coherent byte limits."
      });
    }
  });
export type FactoryLedgerArtifactPolicy = z.infer<typeof factoryLedgerArtifactPolicySchema>;

const executionCoordinates = {
  runId: z.uuid(),
  runDigest: sha256DigestSchema,
  eventDigest: sha256DigestSchema
};
export const factoryLedgerArtifactExecutionSchema = z.discriminatedUnion("kind", [
  z.strictObject({ ...executionCoordinates, kind: z.literal("execution") }),
  z.strictObject({
    ...executionCoordinates,
    kind: z.literal("pull-request-repair"),
    authorizationDigest: sha256DigestSchema
  })
]);
export type FactoryLedgerArtifactExecution = z.infer<typeof factoryLedgerArtifactExecutionSchema>;

const taskFields = { taskId: z.uuid(), contractDigest: sha256DigestSchema };
export const factoryLedgerArtifactUploadSchema = z.strictObject({
  ...taskFields,
  idempotencyKey: z.uuid(),
  expiresAt: factoryTimestampSchema,
  expectedTaskEventDigest: sha256DigestSchema,
  execution: factoryLedgerArtifactExecutionSchema,
  attempt: z.number().int().min(1).max(20),
  operationId: z.uuid(),
  artifact: factoryArtifactReferenceSchema.extend({
    sizeBytes: z.number().int().min(0).max(maximumLedgerArtifactBytes)
  })
});
export type FactoryLedgerArtifactUpload = z.infer<typeof factoryLedgerArtifactUploadSchema>;

/** A reservation is an untrusted byte claim, never a gate result, review, or publication grant. */
export const factoryLedgerArtifactIntentSchema = z.strictObject({
  schemaVersion: z.literal("agentlab.ledger-artifact-intent.v1"),
  principalUid: z.number().int().min(1).max(0xffff_fffe),
  principalId: factoryIdentifierSchema,
  principalKind: z.enum(["implementer", "reviewer", "gate-observer"]),
  peerPolicyDigest: sha256DigestSchema,
  artifactPolicyDigest: sha256DigestSchema,
  upload: factoryLedgerArtifactUploadSchema
});
export type FactoryLedgerArtifactIntent = z.infer<typeof factoryLedgerArtifactIntentSchema>;
export const factoryLedgerArtifactReservationSchema = z.strictObject({
  schemaVersion: z.literal("agentlab.ledger-artifact-reservation.v1"),
  intent: factoryLedgerArtifactIntentSchema,
  intentDigest: sha256DigestSchema,
  reservedAt: factoryTimestampSchema
});
export type FactoryLedgerArtifactReservation = z.infer<
  typeof factoryLedgerArtifactReservationSchema
>;

const envelope = {
  schemaVersion: z.literal("agentlab.ledger-artifact-request.v1"),
  requestId: z.uuid(),
  peerPolicyDigest: sha256DigestSchema,
  artifactPolicyDigest: sha256DigestSchema
};
export const factoryLedgerArtifactRequestSchema = z.discriminatedUnion("operation", [
  z.strictObject({
    ...envelope,
    operation: z.literal("artifact.submit"),
    upload: factoryLedgerArtifactUploadSchema,
    contentBase64: z
      .string()
      .max(Math.ceil(maximumLedgerArtifactBytes / 3) * 4)
      .regex(/^[A-Za-z0-9+/]*={0,2}$/u)
      .refine((value) => value.length % 4 === 0, "Base64 length must be a multiple of four.")
  }),
  z.strictObject({
    ...envelope,
    ...taskFields,
    operation: z.literal("artifact.read"),
    artifactDigest: sha256DigestSchema
  }),
  z.strictObject({
    ...envelope,
    ...taskFields,
    operation: z.literal("artifact.receipt"),
    idempotencyKey: z.uuid(),
    intentDigest: sha256DigestSchema
  })
]);
export type FactoryLedgerArtifactRequest = z.infer<typeof factoryLedgerArtifactRequestSchema>;

const responseEnvelope = {
  schemaVersion: z.literal("agentlab.ledger-artifact-response.v1"),
  requestId: z.uuid().nullable()
};
export const factoryLedgerArtifactResponseSchema = z.discriminatedUnion("status", [
  z.strictObject({ ...responseEnvelope, status: z.literal("denied") }),
  z.strictObject({
    ...responseEnvelope,
    status: z.literal("artifact"),
    ...taskFields,
    artifact: factoryArtifactReferenceSchema,
    contentBase64: z.string().max(Math.ceil(maximumLedgerArtifactBytes / 3) * 4)
  }),
  z.strictObject({
    ...responseEnvelope,
    status: z.literal("reservation"),
    stored: z.boolean(),
    reservation: factoryLedgerArtifactReservationSchema,
    reservationDigest: sha256DigestSchema
  })
]);
export type FactoryLedgerArtifactResponse = z.infer<typeof factoryLedgerArtifactResponseSchema>;
