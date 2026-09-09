import type {
  FactoryArtifactReference,
  FactoryLedgerArtifactExecution,
  FactoryLedgerArtifactIntent,
  FactoryLedgerArtifactReservation,
  Sha256Digest
} from "@agentlab/contracts";

import type { CanonicalFactoryDocument } from "./factory-documents.js";
import type {
  FactoryExecutionJournalRun,
  FactoryExecutionJournalSnapshot
} from "./factory-execution-repository.js";
import type { FactoryTaskSnapshot } from "./factory-task-repository.js";

export interface FactoryArtifactWireCodec {
  decodeBase64(encoded: string): Uint8Array;
  encodeBase64(bytes: Uint8Array): string;
  digest(bytes: Uint8Array): Sha256Digest;
}

export interface FactoryLedgerArtifactContexts {
  task(taskId: string): Promise<FactoryTaskSnapshot | null>;
  execution(
    taskId: string,
    coordinate: FactoryLedgerArtifactExecution
  ): Promise<FactoryExecutionJournalSnapshot<FactoryExecutionJournalRun> | null>;
}

/** Reservations consume quota even when delivery is interrupted; clients cannot release them. */
export interface FactoryLedgerArtifactRepository {
  reserve(
    intent: CanonicalFactoryDocument<FactoryLedgerArtifactIntent>,
    limits: {
      maximumTaskBytes: number;
      maximumTaskArtifacts: number;
      maximumTotalBytes: number;
      maximumTotalArtifacts: number;
    },
    now: () => string
  ): Promise<CanonicalFactoryDocument<FactoryLedgerArtifactReservation>>;
  find(
    principalUid: number,
    idempotencyKey: string
  ): Promise<CanonicalFactoryDocument<FactoryLedgerArtifactReservation> | null>;
  artifactReference(
    taskId: string,
    contractDigest: Sha256Digest,
    artifactDigest: Sha256Digest
  ): Promise<FactoryArtifactReference | null>;
}
