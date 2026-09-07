import type { FactoryRoleIdentityPolicy } from "@agentlab/contracts";

export type EnforcedFactoryProcessRole = "worker" | "eval-attestor";

/** Fails closed when a security-sensitive composition cannot prove its configured POSIX identity. */
export function assertFactoryProcessRoleIdentity(
  policy: FactoryRoleIdentityPolicy,
  role: EnforcedFactoryProcessRole,
  userId: number | undefined
): void {
  const expectedUserId = role === "worker" ? policy.worker.userId : policy.evalAttestor.userId;
  assertFactoryProcessUserIdentity(role, expectedUserId, userId);
}

/** Enforces a separately reviewed POSIX identity for a narrow authority-bearing process. */
export function assertFactoryProcessUserIdentity(
  role: string,
  expectedUserId: number,
  userId: number | undefined
): void {
  if (userId === undefined || !Number.isSafeInteger(userId) || userId < 1) {
    throw new Error(`Factory ${role} requires a non-root POSIX process identity.`);
  }
  if (userId !== expectedUserId) {
    throw new Error(`Factory ${role} process identity does not match its reviewed policy.`);
  }
}
