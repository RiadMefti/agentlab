import type { FactoryEvalAttestationRecord, Sha256Digest } from "@agentlab/contracts";

import type { CanonicalFactoryDocument } from "./factory-documents.js";

export interface FactoryEvalAttestationSnapshot {
  readonly attestation: FactoryEvalAttestationRecord;
  readonly attestationDigest: Sha256Digest;
}

/** One append-only verified attestation may bind one immutable eval run. */
export interface FactoryEvalAttestationRepository {
  record(
    attestation: CanonicalFactoryDocument<FactoryEvalAttestationRecord>
  ): Promise<FactoryEvalAttestationSnapshot>;
  findByRunDigest(runDigest: Sha256Digest): Promise<FactoryEvalAttestationSnapshot | null>;
  findByAttestationDigest(
    attestationDigest: Sha256Digest
  ): Promise<FactoryEvalAttestationSnapshot | null>;
  close(): void;
}
