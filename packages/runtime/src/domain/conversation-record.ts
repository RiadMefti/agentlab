import { conversationSchema, type Conversation } from "@agentlab/contracts";
import { z } from "zod";

export const conversationLifecycleStateSchema = z.enum([
  "creating",
  "active",
  "deleting",
  "legacy-unlinked"
]);
export type ConversationLifecycleState = z.infer<typeof conversationLifecycleStateSchema>;

export const conversationOwnershipModeSchema = z.enum(["nonce", "legacy-name"]);
export type ConversationOwnershipMode = z.infer<typeof conversationOwnershipModeSchema>;

const ownershipNonceSchema = z.uuid();

/** Internal durable aggregate. Lifecycle and ownership metadata never leak into public DTOs. */
export const storedConversationSchema = conversationSchema
  .extend({
    lifecycleState: conversationLifecycleStateSchema,
    ownershipMode: conversationOwnershipModeSchema,
    ownershipNonce: ownershipNonceSchema.nullable()
  })
  .superRefine((record, context) => {
    if (record.ownershipMode === "nonce" && record.ownershipNonce === null) {
      context.addIssue({
        code: "custom",
        path: ["ownershipNonce"],
        message: "Nonce-owned conversations require an ownership nonce."
      });
    }
    if (record.ownershipMode === "legacy-name" && record.ownershipNonce !== null) {
      context.addIssue({
        code: "custom",
        path: ["ownershipNonce"],
        message: "Legacy-name conversations cannot carry an ownership nonce."
      });
    }
    if (record.lifecycleState === "creating" && record.ownershipMode !== "nonce") {
      context.addIssue({
        code: "custom",
        path: ["lifecycleState"],
        message: "Creating conversations must use nonce ownership."
      });
    }
    if (record.lifecycleState === "legacy-unlinked" && record.ownershipMode !== "legacy-name") {
      context.addIssue({
        code: "custom",
        path: ["lifecycleState"],
        message: "Legacy-unlinked conversations must use legacy-name ownership."
      });
    }
    if (
      (record.lifecycleState === "creating" || record.lifecycleState === "active") &&
      record.workspacePath === null
    ) {
      context.addIssue({
        code: "custom",
        path: ["workspacePath"],
        message: `${record.lifecycleState} conversations require a workspace.`
      });
    }
    if (record.lifecycleState === "legacy-unlinked" && record.workspacePath !== null) {
      context.addIssue({
        code: "custom",
        path: ["workspacePath"],
        message: "Legacy-unlinked conversations cannot carry a workspace."
      });
    }
  });

export type StoredConversation = z.infer<typeof storedConversationSchema>;

/** The only record shape that normal product code may insert. Legacy authority is migration-only. */
export const newConversationReservationSchema = storedConversationSchema.and(
  z.object({
    workspacePath: z.string().min(1),
    lifecycleState: z.literal("creating"),
    ownershipMode: z.literal("nonce"),
    ownershipNonce: ownershipNonceSchema
  })
);
export type NewConversationReservation = z.infer<typeof newConversationReservationSchema>;

export function publicConversation(record: StoredConversation): Conversation {
  return conversationSchema.parse({
    id: record.id,
    title: record.title,
    workspacePath: record.workspacePath,
    provider: record.provider,
    model: record.model,
    reasoning: record.reasoning,
    captainSessionName: record.captainSessionName,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt
  });
}
