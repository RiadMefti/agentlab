import { factoryTimestampSchema } from "@agentlab/contracts";

import { factoryTimestampDifferenceSeconds } from "./factory-timestamp.js";

export interface FactoryEvalAttestationTimingPolicy {
  readonly maximumIssuanceDelaySeconds: number;
  readonly maximumAttestationLifetimeSeconds: number;
}

/** Independent local bounds for how long after a run it may be signed and trusted. */
export function assertFactoryEvalAttestationTimingPolicy(
  policy: FactoryEvalAttestationTimingPolicy
): void {
  if (
    !Number.isSafeInteger(policy.maximumIssuanceDelaySeconds) ||
    policy.maximumIssuanceDelaySeconds < 1 ||
    policy.maximumIssuanceDelaySeconds > 86_400
  ) {
    throw new Error("Factory eval attestation issuance delay must be between 1 second and 1 day.");
  }
  if (
    !Number.isSafeInteger(policy.maximumAttestationLifetimeSeconds) ||
    policy.maximumAttestationLifetimeSeconds < 60 ||
    policy.maximumAttestationLifetimeSeconds > 604_800
  ) {
    throw new Error("Factory eval attestation lifetime must be between 60 seconds and 7 days.");
  }
}

export function assertFactoryEvalAttestationTiming(
  completedAtInput: string,
  issuedAtInput: string,
  expiresAtInput: string,
  policy: FactoryEvalAttestationTimingPolicy
): void {
  assertFactoryEvalAttestationTimingPolicy(policy);
  const completedAt = factoryTimestampSchema.parse(completedAtInput);
  const issuedAt = factoryTimestampSchema.parse(issuedAtInput);
  const expiresAt = factoryTimestampSchema.parse(expiresAtInput);
  const issuanceDelay = factoryTimestampDifferenceSeconds(completedAt, issuedAt);
  if (issuanceDelay < 0 || issuanceDelay > policy.maximumIssuanceDelaySeconds) {
    throw new Error("Factory eval attestation was not issued within its trusted run window.");
  }
  const lifetime = factoryTimestampDifferenceSeconds(issuedAt, expiresAt);
  if (lifetime < 60 || lifetime > policy.maximumAttestationLifetimeSeconds) {
    throw new Error("Factory eval attestation exceeds its trusted validity window.");
  }
}
