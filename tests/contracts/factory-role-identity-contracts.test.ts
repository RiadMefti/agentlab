import { factoryRoleIdentityPolicySchema } from "@agentlab/contracts";
import { describe, expect, it } from "vitest";

import { NodeFactoryDocumentCodec } from "../../packages/runtime/src/infrastructure/persistence/canonical-factory-documents.js";
import { testEvalDigest } from "../helpers/factory-evaluation.js";

describe("factory role identity policy contract", () => {
  it("accepts one canonical non-root signer/worker separation policy", () => {
    const policy = validPolicy();
    expect(factoryRoleIdentityPolicySchema.parse(policy)).toEqual(policy);

    const document = new NodeFactoryDocumentCodec().roleIdentityPolicy(policy);
    expect(document.digest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(JSON.parse(document.json)).toEqual(policy);
  });

  it("rejects root, shared identities, unknown fields, and unbound key coordinates", () => {
    expect(
      factoryRoleIdentityPolicySchema.safeParse({
        ...validPolicy(),
        worker: { kind: "posix-uid", userId: 0 }
      }).success
    ).toBe(false);
    expect(
      factoryRoleIdentityPolicySchema.safeParse({
        ...validPolicy(),
        evalAttestor: { ...validPolicy().evalAttestor, userId: 1001 }
      }).success
    ).toBe(false);
    expect(
      factoryRoleIdentityPolicySchema.safeParse({ ...validPolicy(), githubToken: "forbidden" })
        .success
    ).toBe(false);
    expect(
      factoryRoleIdentityPolicySchema.safeParse({
        ...validPolicy(),
        evalAttestor: { ...validPolicy().evalAttestor, keyId: "unpinned" }
      }).success
    ).toBe(false);
  });
});

function validPolicy() {
  return {
    schemaVersion: "agentlab.role-identity-policy.v1" as const,
    id: "agentlab/production-role-identities",
    version: "1.0.0",
    worker: { kind: "posix-uid" as const, userId: 1001 },
    evalAttestor: {
      kind: "posix-uid" as const,
      userId: 1002,
      runnerId: "trusted-eval-runner",
      keyId: testEvalDigest(901)
    }
  };
}
