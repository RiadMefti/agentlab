import {
  factorySchedulePolicySchema,
  factoryTimestampSchema,
  type FactorySchedulePolicy
} from "@agentlab/contracts";

import {
  factoryTimestampAddSeconds,
  factoryTimestampSubtractSeconds
} from "./factory-timestamp.js";

export interface FactoryDailyScheduleSlot {
  readonly scheduledFor: string;
  readonly deadlineAt: string;
  readonly status: "due" | "missed-deadline";
}

/** Resolves the latest daily UTC slot; callers reconcile its immutable key before acting. */
export function resolveFactoryDailyScheduleSlot(
  policyInput: FactorySchedulePolicy,
  nowInput: string
): FactoryDailyScheduleSlot {
  const policy = factorySchedulePolicySchema.parse(policyInput);
  const now = factoryTimestampSchema.parse(nowInput);
  const currentDateSlot = factoryTimestampSchema.parse(
    `${now.slice(0, 10)}T${policy.cadence.at}:00.000Z`
  );
  const scheduledFor =
    currentDateSlot > now
      ? factoryTimestampSubtractSeconds(currentDateSlot, 86_400)
      : currentDateSlot;
  const deadlineAt = factoryTimestampAddSeconds(scheduledFor, policy.cadence.startDeadlineSeconds);
  return {
    scheduledFor,
    deadlineAt,
    status: now <= deadlineAt ? "due" : "missed-deadline"
  };
}
