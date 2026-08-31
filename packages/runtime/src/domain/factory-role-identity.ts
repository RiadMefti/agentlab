import type { FactoryRoleIdentityPolicy } from "@agentlab/contracts";

export type EnforcedFactoryProcessRole = "worker" | "eval-attestor";

/** Fails closed when a security-sensitive composition cannot prove its configured POSIX identity. */
export function assertFactoryProcessRoleIdentity(
  policy: FactoryRoleIdentityPolicy,
  role: EnforcedFactoryProcessRole,
  userId: number | undefined
): void {
  if (userId === undefined || !Number.isSafeInteger(userId) || userId < 1) {
    throw new Error(`Factory ${role} requires a non-root POSIX process identity.`);
  }
  const expectedUserId = role === "worker" ? policy.worker.userId : policy.evalAttestor.userId;
  if (userId !== expectedUserId) {
    throw new Error(`Factory ${role} process identity does not match its reviewed policy.`);
  }
}
