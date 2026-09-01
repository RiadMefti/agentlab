import type {
  FactoryEvalProductionEvent,
  FactoryEvalProductionJob,
  Sha256Digest
} from "@agentlab/contracts";

import type { CanonicalFactoryDocument } from "./factory-documents.js";

export interface FactoryEvalProductionEventSnapshot {
  readonly event: FactoryEvalProductionEvent;
  readonly eventDigest: Sha256Digest;
}

export interface FactoryEvalProductionSnapshot {
  readonly job: FactoryEvalProductionJob;
  readonly jobDigest: Sha256Digest;
  readonly events: readonly FactoryEvalProductionEventSnapshot[];
}

/** Immutable eval-production job and append-only crash journal. */
export interface FactoryEvalProductionRepository {
  register(
    job: CanonicalFactoryDocument<FactoryEvalProductionJob>,
    event: CanonicalFactoryDocument<FactoryEvalProductionEvent>
  ): Promise<FactoryEvalProductionSnapshot>;
  append(
    event: CanonicalFactoryDocument<FactoryEvalProductionEvent>
  ): Promise<FactoryEvalProductionSnapshot>;
  findByJobId(jobId: string): Promise<FactoryEvalProductionSnapshot | null>;
  close(): void;
}
