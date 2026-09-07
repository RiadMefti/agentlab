import { describe, expect, it } from "vitest";

import { assertFactoryProcessRoleIdentity } from "../../packages/runtime/src/domain/factory-role-identity.js";
import { testEvalDigest, testFactoryRoleIdentityPolicy } from "../helpers/factory-evaluation.js";

describe("factory process role identity", () => {
  const policy = testFactoryRoleIdentityPolicy({
    keyId: testEvalDigest(901),
    workerUserId: 1001,
    attestorUserId: 1002
  });

  it("accepts only the exact configured non-root role principal", () => {
    expect(() => {
      assertFactoryProcessRoleIdentity(policy, "worker", 1001);
    }).not.toThrow();
    expect(() => {
      assertFactoryProcessRoleIdentity(policy, "eval-attestor", 1002);
    }).not.toThrow();
    expect(() => {
      assertFactoryProcessRoleIdentity(policy, "worker", 1002);
    }).toThrow(/does not match/u);
    expect(() => {
      assertFactoryProcessRoleIdentity(policy, "eval-attestor", 1001);
    }).toThrow(/does not match/u);
  });

  it("fails closed without a provable non-root POSIX identity", () => {
    expect(() => {
      assertFactoryProcessRoleIdentity(policy, "worker", undefined);
    }).toThrow(/non-root POSIX/u);
    expect(() => {
      assertFactoryProcessRoleIdentity(policy, "worker", 0);
    }).toThrow(/non-root POSIX/u);
    expect(() => {
      assertFactoryProcessRoleIdentity(policy, "worker", Number.NaN);
    }).toThrow(/non-root POSIX/u);
  });
});
