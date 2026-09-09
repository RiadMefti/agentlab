import { z } from "zod";

import {
  factoryArtifactReferenceSchema,
  factoryTimestampSchema,
  sha256DigestSchema
} from "./factory.js";
import {
  factoryLedgerOperationPrincipalSchema,
  factoryLedgerOperationSchema
} from "./factory-ledger-operation.js";

export const factoryLedgerOperationPolicySchema = z
  .strictObject({
    schemaVersion: z.literal("agentlab.ledger-operation-policy.v1"),
    expiresAt: factoryTimestampSchema,
    maximumTaskJobs: z.number().int().min(1).max(256),
    maximumTotalJobs: z.number().int().min(1).max(65536),
    maximumStoredJobBytes: z.number().int().min(1).max(1_073_741_824),
    principals: z
      .array(
        factoryLedgerOperationPrincipalSchema.extend({ workerPolicyDigest: sha256DigestSchema })
      )
      .min(1)
      .max(32)
  })
  .superRefine((policy, context) => {
    if (
      new Set(policy.principals.map(({ uid }) => uid)).size !== policy.principals.length ||
      new Set(policy.principals.map(({ id }) => id)).size !== policy.principals.length ||
      policy.maximumTaskJobs > policy.maximumTotalJobs
    )
      context.addIssue({
        code: "custom",
        message: "Operation policy requires distinct principals and coherent job quotas."
      });
  });
export type FactoryLedgerOperationPolicy = z.infer<typeof factoryLedgerOperationPolicySchema>;

export const factoryLedgerOperationClaimSchema = z.strictObject({
  schemaVersion: z.literal("agentlab.ledger-operation-claim.v1"),
  jobId: z.uuid(),
  jobDigest: sha256DigestSchema,
  principalUid: z.number().int().min(1).max(0xffff_fffe),
  invocationId: z.uuid(),
  claimedAt: factoryTimestampSchema
});
export type FactoryLedgerOperationClaim = z.infer<typeof factoryLedgerOperationClaimSchema>;
export const factoryLedgerOperationReceiptSchema = z.strictObject({
  schemaVersion: z.literal("agentlab.ledger-operation-receipt.v1"),
  jobId: z.uuid(),
  jobDigest: sha256DigestSchema,
  claimDigest: sha256DigestSchema,
  principalUid: z.number().int().min(1).max(0xffff_fffe),
  artifactReservationDigest: sha256DigestSchema,
  resultArtifact: factoryArtifactReferenceSchema,
  reportedAt: factoryTimestampSchema
});
export type FactoryLedgerOperationReceipt = z.infer<typeof factoryLedgerOperationReceiptSchema>;

const envelope = {
  schemaVersion: z.literal("agentlab.ledger-operation-request.v1"),
  requestId: z.uuid(),
  peerPolicyDigest: sha256DigestSchema,
  operationPolicyDigest: sha256DigestSchema
};
const task = { taskId: z.uuid(), contractDigest: sha256DigestSchema };
const job = { ...task, jobId: z.uuid(), jobDigest: sha256DigestSchema };
export const factoryLedgerOperationRequestSchema = z.discriminatedUnion("operation", [
  z.strictObject({ ...envelope, ...task, operation: z.literal("operation.next") }),
  z.strictObject({ ...envelope, ...job, operation: z.literal("operation.inspect") }),
  z.strictObject({
    ...envelope,
    ...job,
    operation: z.literal("operation.claim"),
    invocationId: z.uuid()
  }),
  z.strictObject({
    ...envelope,
    ...job,
    operation: z.literal("operation.report"),
    claimDigest: sha256DigestSchema,
    artifactReservationKey: z.uuid(),
    artifactReservationDigest: sha256DigestSchema
  })
]);
export type FactoryLedgerOperationRequest = z.infer<typeof factoryLedgerOperationRequestSchema>;
const response = {
  schemaVersion: z.literal("agentlab.ledger-operation-response.v1"),
  requestId: z.uuid().nullable()
};
export const factoryLedgerOperationResponseSchema = z.discriminatedUnion("status", [
  z.strictObject({ ...response, status: z.literal("denied") }),
  z.strictObject({ ...response, status: z.literal("empty") }),
  z.strictObject({
    ...response,
    status: z.literal("job"),
    job: factoryLedgerOperationSchema,
    jobDigest: sha256DigestSchema,
    claim: factoryLedgerOperationClaimSchema.nullable(),
    claimDigest: sha256DigestSchema.nullable(),
    receipt: factoryLedgerOperationReceiptSchema.nullable(),
    receiptDigest: sha256DigestSchema.nullable(),
    newlyClaimed: z.boolean()
  })
]);
export type FactoryLedgerOperationResponse = z.infer<typeof factoryLedgerOperationResponseSchema>;
