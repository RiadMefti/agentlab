import type { FactoryDailyQuotaReservation, Sha256Digest } from "@agentlab/contracts";

import type { CanonicalFactoryDocument } from "./factory-documents.js";

export interface FactoryDailyQuotaReservationSnapshot {
  readonly reservation: FactoryDailyQuotaReservation;
  readonly reservationDigest: Sha256Digest;
}

export type FactoryDailyQuotaScope = "repository" | "organization";

export class FactoryDailyQuotaCapacityError extends Error {
  public constructor(public readonly scope: FactoryDailyQuotaScope) {
    super(`Factory daily ${scope} quota capacity exceeded.`);
    this.name = "FactoryDailyQuotaCapacityError";
  }
}

/** Append-only aggregate quota ledger; reservations are conservative and never released. */
export interface FactoryDailyQuotaRepository {
  reserve(
    reservation: CanonicalFactoryDocument<FactoryDailyQuotaReservation>
  ): Promise<FactoryDailyQuotaReservationSnapshot>;
  findByTaskId(taskId: string): Promise<FactoryDailyQuotaReservationSnapshot | null>;
  findByReservationDigest(
    reservationDigest: Sha256Digest
  ): Promise<FactoryDailyQuotaReservationSnapshot | null>;
  close(): void;
}
