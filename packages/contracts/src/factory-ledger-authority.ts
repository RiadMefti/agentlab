import { z } from "zod";

import {
  factoryControlEventSchema,
  factoryControlNameSchema,
  factoryIdentifierSchema,
  factoryTimestampSchema,
  sha256DigestSchema
} from "./factory.js";

export const factoryLedgerAuthorityPolicySchema = z
  .strictObject({
    schemaVersion: z.literal("agentlab.ledger-authority-policy.v1"),
    expiresAt: factoryTimestampSchema,
    grants: z
      .array(
        z.strictObject({
          uid: z.number().int().min(1).max(0xffff_fffe),
          id: factoryIdentifierSchema,
          controls: z
            .array(
              z.strictObject({
                control: factoryControlNameSchema,
                allowEnable: z.boolean()
              })
            )
            .min(1)
            .max(3)
        })
      )
      .min(1)
      .max(32)
  })
  .superRefine((policy, context) => {
    if (
      new Set(policy.grants.map(({ uid }) => uid)).size !== policy.grants.length ||
      new Set(policy.grants.map(({ id }) => id)).size !== policy.grants.length ||
      policy.grants.some(
        ({ controls }) => new Set(controls.map(({ control }) => control)).size !== controls.length
      )
    ) {
      context.addIssue({
        code: "custom",
        message: "Authority principals and control grants must be distinct."
      });
    }
  });
export type FactoryLedgerAuthorityPolicy = z.infer<typeof factoryLedgerAuthorityPolicySchema>;

export const factoryLedgerAuthorityCommandSchema = z
  .strictObject({
    idempotencyKey: z.uuid(),
    expiresAt: factoryTimestampSchema,
    control: factoryControlNameSchema,
    expectedEnabled: z.boolean(),
    expectedEventDigest: sha256DigestSchema.nullable(),
    enabled: z.boolean(),
    reason: z.string().trim().min(1).max(500),
    confirmation: z.enum([
      "enable-scheduler",
      "disable-scheduler",
      "enable-draft-broker",
      "disable-draft-broker",
      "enable-autonomous-merge",
      "disable-autonomous-merge"
    ])
  })
  .superRefine((command, context) => {
    const target =
      command.control === "pr-broker"
        ? "draft-broker"
        : command.control === "merge-broker"
          ? "autonomous-merge"
          : "scheduler";
    if (
      command.enabled === command.expectedEnabled ||
      command.confirmation !== `${command.enabled ? "enable" : "disable"}-${target}`
    ) {
      context.addIssue({
        code: "custom",
        message: "Authority change needs an opposite expected state and exact confirmation."
      });
    }
  });
export type FactoryLedgerAuthorityCommand = z.infer<typeof factoryLedgerAuthorityCommandSchema>;

const requestFields = {
  schemaVersion: z.literal("agentlab.ledger-authority-request.v1"),
  requestId: z.uuid(),
  peerPolicyDigest: sha256DigestSchema,
  authorityPolicyDigest: sha256DigestSchema
};
export const factoryLedgerAuthorityRequestSchema = z.discriminatedUnion("operation", [
  z.strictObject({ ...requestFields, operation: z.literal("authority.inspect") }),
  z.strictObject({
    ...requestFields,
    operation: z.literal("authority.receipt"),
    idempotencyKey: z.uuid(),
    intentDigest: sha256DigestSchema
  }),
  z.strictObject({
    ...requestFields,
    operation: z.literal("authority.change"),
    command: factoryLedgerAuthorityCommandSchema
  })
]);
export type FactoryLedgerAuthorityRequest = z.infer<typeof factoryLedgerAuthorityRequestSchema>;

export const factoryLedgerAuthorityHeadSchema = z
  .strictObject({
    enabled: z.boolean(),
    event: factoryControlEventSchema.nullable(),
    eventDigest: sha256DigestSchema.nullable()
  })
  .superRefine((head, context) => {
    if (
      (head.event === null) !== (head.eventDigest === null) ||
      head.enabled !== (head.event?.enabled ?? false)
    ) {
      context.addIssue({ code: "custom", message: "Authority head does not match its event." });
    }
  });
export type FactoryLedgerAuthorityHead = z.infer<typeof factoryLedgerAuthorityHeadSchema>;

/** The transport request ID is deliberately excluded so reconnects can reconcile one intent. */
export const factoryLedgerAuthorityIntentSchema = z.strictObject({
  schemaVersion: z.literal("agentlab.ledger-authority-intent.v1"),
  principalUid: z.number().int().min(1).max(0xffff_fffe),
  principalId: factoryIdentifierSchema,
  peerPolicyDigest: sha256DigestSchema,
  authorityPolicyDigest: sha256DigestSchema,
  command: factoryLedgerAuthorityCommandSchema
});
export type FactoryLedgerAuthorityIntent = z.infer<typeof factoryLedgerAuthorityIntentSchema>;

export const factoryLedgerAuthorityReceiptSchema = z
  .strictObject({
    schemaVersion: z.literal("agentlab.ledger-authority-receipt.v1"),
    intent: factoryLedgerAuthorityIntentSchema,
    intentDigest: sha256DigestSchema,
    outcome: z.enum(["applied", "conflict"]),
    head: factoryLedgerAuthorityHeadSchema,
    recordedAt: factoryTimestampSchema
  })
  .superRefine((receipt, context) => {
    const { command } = receipt.intent;
    const event = receipt.head.event;
    if (
      (event !== null && event.control !== command.control) ||
      (receipt.outcome === "applied" &&
        (event === null ||
          receipt.head.enabled !== command.enabled ||
          event.reason !== command.reason ||
          event.actor.kind !== "human" ||
          event.actor.role !== "requester" ||
          event.actor.id !== receipt.intent.principalId ||
          event.actor.sessionId !== null ||
          event.occurredAt !== receipt.recordedAt))
    ) {
      context.addIssue({
        code: "custom",
        message: "Authority receipt does not bind its command and operator."
      });
    }
  });
export type FactoryLedgerAuthorityReceipt = z.infer<typeof factoryLedgerAuthorityReceiptSchema>;

const responseFields = {
  schemaVersion: z.literal("agentlab.ledger-authority-response.v1"),
  requestId: z.uuid().nullable()
};
export const factoryLedgerAuthorityResponseSchema = z.discriminatedUnion("status", [
  z.strictObject({ ...responseFields, status: z.literal("denied") }),
  z.strictObject({
    ...responseFields,
    status: z.literal("inspection"),
    scheduler: factoryLedgerAuthorityHeadSchema,
    prBroker: factoryLedgerAuthorityHeadSchema,
    mergeBroker: factoryLedgerAuthorityHeadSchema
  }),
  z.strictObject({
    ...responseFields,
    status: z.literal("receipt"),
    receipt: factoryLedgerAuthorityReceiptSchema,
    receiptDigest: sha256DigestSchema
  })
]);
export type FactoryLedgerAuthorityResponse = z.infer<typeof factoryLedgerAuthorityResponseSchema>;
