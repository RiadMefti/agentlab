import { createPublicKey, verify as verifyBytes } from "node:crypto";

import {
  factoryDsseEnvelopeSchema,
  sha256DigestSchema,
  type FactoryDsseEnvelope,
  type Sha256Digest
} from "@agentlab/contracts";

import type {
  FactoryDsseVerifier,
  FactoryDsseVerificationResult,
  FactoryEvalAttestationKeySource
} from "../../domain/factory-eval-attestation-crypto.js";
import {
  assertFactoryEd25519Key,
  decodeCanonicalFactoryBase64,
  factoryDssePreAuthenticationEncoding,
  factoryEd25519PublicKeyId,
  maximumFactoryDssePayloadBytes
} from "./factory-dsse-primitives.js";

/** Ed25519 DSSE verifier; the envelope key ID is never treated as a trust root. */
export class NodeFactoryDsseVerifier implements FactoryDsseVerifier {
  readonly #expectedKeyId: Sha256Digest;

  public constructor(
    private readonly keys: FactoryEvalAttestationKeySource,
    expectedKeyId: Sha256Digest
  ) {
    this.#expectedKeyId = sha256DigestSchema.parse(expectedKeyId);
  }

  public async verify(envelopeInput: FactoryDsseEnvelope): Promise<FactoryDsseVerificationResult> {
    const envelope = factoryDsseEnvelopeSchema.parse(envelopeInput);
    const loaded = await this.keys.load();
    if (!(loaded instanceof Uint8Array)) {
      throw new Error("Factory eval public-key source returned invalid material.");
    }
    const material = Buffer.from(loaded);
    let payloadBytes: Buffer | null = null;
    let signatureBytes: Buffer | null = null;
    let encoded: Buffer | null = null;
    try {
      const publicKey = createPublicKey(material);
      assertFactoryEd25519Key(publicKey, "public");
      const keyId = factoryEd25519PublicKeyId(publicKey);
      if (keyId !== this.#expectedKeyId) {
        throw new Error("Factory eval public key does not match its configured key ID.");
      }
      const matching = envelope.signatures.filter(({ keyid }) => keyid === keyId);
      if (matching.length !== 1) {
        throw new Error("Factory eval DSSE envelope lacks one signature from the trusted key.");
      }
      payloadBytes = decodeCanonicalFactoryBase64(envelope.payload, "payload");
      signatureBytes = decodeCanonicalFactoryBase64(matching[0]?.sig ?? "", "signature");
      if (payloadBytes.byteLength < 2 || payloadBytes.byteLength > maximumFactoryDssePayloadBytes) {
        throw new Error("Factory eval DSSE payload size is outside its bounded range.");
      }
      if (signatureBytes.byteLength !== 64) {
        throw new Error("Factory eval DSSE signature is not an Ed25519 signature.");
      }
      encoded = factoryDssePreAuthenticationEncoding(envelope.payloadType, payloadBytes);
      if (!verifyBytes(null, encoded, publicKey, signatureBytes)) {
        throw new Error("Factory eval DSSE signature verification failed.");
      }
      const payload = payloadBytes.toString("utf8");
      if (!Buffer.from(payload, "utf8").equals(payloadBytes)) {
        throw new Error("Factory eval DSSE payload is not canonical UTF-8.");
      }
      return { keyId, payload };
    } catch (error: unknown) {
      throw new Error("Factory eval DSSE verification failed.", { cause: error });
    } finally {
      encoded?.fill(0);
      signatureBytes?.fill(0);
      payloadBytes?.fill(0);
      material.fill(0);
      loaded.fill(0);
    }
  }
}
