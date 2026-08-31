import type { FactoryCanaryTaskReservation, Sha256Digest } from "@agentlab/contracts";

import type { CanonicalFactoryDocument } from "./factory-documents.js";

export interface FactoryCanaryReservationSnapshot {
  readonly reservation: FactoryCanaryTaskReservation;
  readonly reservationDigest: Sha256Digest;
}

export interface FactoryCanaryReservationWriteResult extends FactoryCanaryReservationSnapshot {
  readonly status: "reserved" | "existing";
}

/** Immutable reservations are the only bridge from a cohort to a concrete scheduled task. */
export interface FactoryCanaryReservationRepository {
  reserve(
    reservation: CanonicalFactoryDocument<FactoryCanaryTaskReservation>
  ): Promise<FactoryCanaryReservationWriteResult>;
  findByTaskId(taskId: string): Promise<FactoryCanaryReservationSnapshot | null>;
  findByReservationDigest(
    reservationDigest: Sha256Digest
  ): Promise<FactoryCanaryReservationSnapshot | null>;
  listByCohortDigest(
    cohortDigest: Sha256Digest
  ): Promise<readonly FactoryCanaryReservationSnapshot[]>;
  close(): void;
}
