import type {
  FactoryBudget,
  FactoryDailyQuotaPolicy,
  FactoryDailyQuotaReservation,
  Sha256Digest
} from "@agentlab/contracts";

import type { FactoryDailyQuotaReservationSnapshot } from "./factory-daily-quota-repository.js";
import type { CanonicalFactoryDocument, FactoryDocumentCodec } from "./factory-documents.js";
import { factoryTimestampAddSeconds } from "./factory-timestamp.js";

export interface FactoryDailyQuotaReservationIdentity {
  readonly policy: CanonicalFactoryDocument<FactoryDailyQuotaPolicy>;
  readonly organizationId: string;
  readonly repositoryId: string;
  readonly taskId: string;
  readonly scheduleRunId: string;
  readonly scheduleRunDigest: Sha256Digest;
  readonly canaryReservationDigest: Sha256Digest;
  readonly scheduledFor: string;
  readonly budget: FactoryBudget;
  readonly correlationId?: string;
}

export function factoryDailyQuotaWindow(scheduledFor: string): {
  readonly windowStart: string;
  readonly windowEnd: string;
} {
  const start = `${scheduledFor.slice(0, 10)}T00:00:00.000Z`;
  return {
    windowStart: start,
    windowEnd: factoryTimestampAddSeconds(start, 86_400)
  };
}

export function assertFactoryDailyQuotaReservation(
  snapshot: FactoryDailyQuotaReservationSnapshot,
  identity: FactoryDailyQuotaReservationIdentity,
  documents: Pick<FactoryDocumentCodec, "dailyQuotaPolicy" | "dailyQuotaReservation">
): CanonicalFactoryDocument<FactoryDailyQuotaReservation> {
  const reservation = documents.dailyQuotaReservation(snapshot.reservation);
  const embeddedPolicy = documents.dailyQuotaPolicy(reservation.value.quotaPolicy);
  const window = factoryDailyQuotaWindow(identity.scheduledFor);
  if (
    reservation.digest !== snapshot.reservationDigest ||
    embeddedPolicy.digest !== reservation.value.quotaPolicyDigest ||
    embeddedPolicy.digest !== identity.policy.digest ||
    reservation.value.organizationId !== identity.organizationId ||
    reservation.value.repositoryId !== identity.repositoryId ||
    reservation.value.taskId !== identity.taskId ||
    reservation.value.scheduleRunId !== identity.scheduleRunId ||
    reservation.value.scheduleRunDigest !== identity.scheduleRunDigest ||
    reservation.value.canaryReservationDigest !== identity.canaryReservationDigest ||
    reservation.value.windowStart !== window.windowStart ||
    reservation.value.windowEnd !== window.windowEnd ||
    !sameBudget(reservation.value.budget, identity.budget) ||
    (identity.correlationId !== undefined &&
      reservation.value.correlationId !== identity.correlationId)
  ) {
    throw new Error("Factory daily quota reservation failed immutable identity validation.");
  }
  return reservation;
}

export function factoryDailyQuotaRepositoryAuthorized(
  policy: FactoryDailyQuotaPolicy,
  repositoryId: string
): boolean {
  return policy.repositories.some((profile) => profile.repositoryId === repositoryId);
}

function sameBudget(left: FactoryBudget, right: FactoryBudget): boolean {
  return (
    left.wallClockSeconds === right.wallClockSeconds &&
    left.maxAgentTurns === right.maxAgentTurns &&
    left.maxToolCalls === right.maxToolCalls &&
    left.maxInputTokens === right.maxInputTokens &&
    left.maxOutputTokens === right.maxOutputTokens &&
    left.maxCostMicrousd === right.maxCostMicrousd &&
    left.maxProcesses === right.maxProcesses &&
    left.maxOutputBytes === right.maxOutputBytes &&
    left.maxWorkers === right.maxWorkers &&
    left.maxRepairAttempts === right.maxRepairAttempts &&
    left.maxChangedFiles === right.maxChangedFiles &&
    left.maxChangedLines === right.maxChangedLines
  );
}
