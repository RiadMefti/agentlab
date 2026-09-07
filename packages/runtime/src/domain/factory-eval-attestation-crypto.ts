import type { FactoryDsseEnvelope, Sha256Digest } from "@agentlab/contracts";

export interface FactoryEvalAttestationKeySource {
  /** Returns fresh mutable key bytes that the caller must erase after one operation. */
  load(): Promise<Uint8Array>;
}

export interface FactoryDsseSigningResult {
  readonly keyId: Sha256Digest;
  readonly envelope: FactoryDsseEnvelope;
}

/** Signs exact payload bytes under DSSE PAE; key custody stays behind this port. */
export interface FactoryDsseSigner {
  sign(payloadType: string, payload: string): Promise<FactoryDsseSigningResult>;
}

export interface FactoryDsseVerificationResult {
  readonly keyId: Sha256Digest;
  readonly payload: string;
}

/** Verifies against one configured trust root; envelope keyid is only a selection hint. */
export interface FactoryDsseVerifier {
  verify(envelope: FactoryDsseEnvelope): Promise<FactoryDsseVerificationResult>;
}
