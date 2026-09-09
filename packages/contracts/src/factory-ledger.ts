import { z } from "zod";

import {
  factoryIdentifierSchema,
  factoryTaskStateSchema,
  factoryTimestampSchema,
  immutableTaskContractSchema,
  sha256DigestSchema,
  taskEventSchema
} from "./factory.js";

/** A read grant is not an execution, gate, publication, or switch capability. */
export const factoryLedgerReadPolicySchema = z
  .strictObject({
    schemaVersion: z.literal("agentlab.ledger-read-policy.v1"),
    expiresAt: factoryTimestampSchema,
    principals: z
      .array(
        z.strictObject({
          uid: z.number().int().min(1).max(0xffff_fffe),
          id: factoryIdentifierSchema,
          role: z.enum(["operator", "worker", "broker"]),
          tasks: z
            .array(z.strictObject({ taskId: z.uuid(), contractDigest: sha256DigestSchema }))
            .max(256)
        })
      )
      .min(1)
      .max(32)
  })
  .superRefine((policy, context) => {
    const uids = policy.principals.map(({ uid }) => uid);
    const ids = policy.principals.map(({ id }) => id);
    if (new Set(uids).size !== uids.length || new Set(ids).size !== ids.length) {
      context.addIssue({
        code: "custom",
        message: "Each ledger principal needs a distinct UID and identity."
      });
    }
    for (const principal of policy.principals) {
      if (new Set(principal.tasks.map(({ taskId }) => taskId)).size !== principal.tasks.length) {
        context.addIssue({
          code: "custom",
          message: "A principal cannot contain duplicate task grants."
        });
      }
    }
  });
export type FactoryLedgerReadPolicy = z.infer<typeof factoryLedgerReadPolicySchema>;

const requestFields = {
  schemaVersion: z.literal("agentlab.ledger-read-request.v1"),
  requestId: z.uuid(),
  peerPolicyDigest: sha256DigestSchema
};
export const factoryLedgerReadRequestSchema = z.discriminatedUnion("operation", [
  z.strictObject({ ...requestFields, operation: z.literal("authority.read") }),
  z.strictObject({
    ...requestFields,
    operation: z.literal("task.read"),
    taskId: z.uuid(),
    contractDigest: sha256DigestSchema
  })
]);
export type FactoryLedgerReadRequest = z.infer<typeof factoryLedgerReadRequestSchema>;

const responseFields = {
  schemaVersion: z.literal("agentlab.ledger-read-response.v1"),
  requestId: z.uuid().nullable()
};
export const factoryLedgerReadResponseSchema = z.discriminatedUnion("status", [
  z.strictObject({ ...responseFields, status: z.literal("denied") }),
  z.strictObject({
    ...responseFields,
    status: z.literal("authority"),
    scheduler: z.boolean(),
    prBroker: z.boolean(),
    mergeBroker: z.boolean()
  }),
  z.strictObject({
    ...responseFields,
    status: z.literal("task"),
    snapshot: z.strictObject({
      contract: immutableTaskContractSchema,
      contractDigest: sha256DigestSchema,
      state: factoryTaskStateSchema,
      sequence: z.number().int().min(1),
      lastEvent: taskEventSchema,
      lastEventDigest: sha256DigestSchema
    })
  })
]);
export type FactoryLedgerReadResponse = z.infer<typeof factoryLedgerReadResponseSchema>;
