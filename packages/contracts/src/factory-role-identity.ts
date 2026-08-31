import { z } from "zod";

import {
  factoryIdentifierSchema,
  factorySemanticVersionSchema,
  sha256DigestSchema
} from "./factory.js";

const posixUserIdSchema = z.number().int().min(1).max(4_294_967_294);

const posixPrincipalSchema = z
  .object({
    kind: z.literal("posix-uid"),
    userId: posixUserIdSchema
  })
  .strict();

/** Reviewed signer/worker identity separation pinned by every autonomous activation path. */
export const factoryRoleIdentityPolicySchema = z
  .object({
    schemaVersion: z.literal("agentlab.role-identity-policy.v1"),
    id: factoryIdentifierSchema,
    version: factorySemanticVersionSchema,
    worker: posixPrincipalSchema,
    evalAttestor: posixPrincipalSchema
      .extend({
        runnerId: factoryIdentifierSchema,
        keyId: sha256DigestSchema
      })
      .strict()
  })
  .strict()
  .superRefine((policy, context) => {
    if (policy.worker.userId === policy.evalAttestor.userId) {
      context.addIssue({
        code: "custom",
        path: ["evalAttestor", "userId"],
        message: "Factory worker and eval attestor must use distinct POSIX user IDs."
      });
    }
  });

export type FactoryRoleIdentityPolicy = z.infer<typeof factoryRoleIdentityPolicySchema>;
