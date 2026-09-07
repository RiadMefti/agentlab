import { createPrivateKey, createPublicKey, sign as signBytes } from "node:crypto";

import {
  factoryDsseEnvelopeSchema,
  sha256DigestSchema,
  type Sha256Digest
} from "@agentlab/contracts";

import type {
  FactoryDsseSigner,
  FactoryDsseSigningResult,
  FactoryEvalAttestationKeySource
} from "../../domain/factory-eval-attestation-crypto.js";
import {
  assertFactoryDssePayload,
  assertFactoryEd25519Key,
  factoryDssePreAuthenticationEncoding,
  factoryEd25519PublicKeyId
} from "./factory-dsse-primitives.js";

/** Ed25519 DSSE signer reachable only from the isolated attestor composition. */
export class NodeFactoryDsseSigner implements FactoryDsseSigner {
  readonly #expectedKeyId: Sha256Digest;

  public constructor(
    private readonly keys: FactoryEvalAttestationKeySource,
    expectedKeyId: Sha256Digest
  ) {
    this.#expectedKeyId = sha256DigestSchema.parse(expectedKeyId);
  }

  public async sign(payloadType: string, payload: string): Promise<FactoryDsseSigningResult> {
    assertFactoryDssePayload(payloadType, payload);
    const loaded = await this.keys.load();
    if (!(loaded instanceof Uint8Array)) {
      throw new Error("Factory eval private-key source returned invalid material.");
    }
    const material = Buffer.from(loaded);
    let payloadBytes: Buffer | null = null;
    let signature: Buffer | null = null;
    let encoded: Buffer | null = null;
    try {
      const privateKey = createPrivateKey(material);
      assertFactoryEd25519Key(privateKey, "private");
      const keyId = factoryEd25519PublicKeyId(createPublicKey(privateKey));
      if (keyId !== this.#expectedKeyId) {
        throw new Error("Factory eval private key does not match its configured key ID.");
      }
      payloadBytes = Buffer.from(payload, "utf8");
      encoded = factoryDssePreAuthenticationEncoding(payloadType, payloadBytes);
      signature = signBytes(null, encoded, { key: privateKey });
      if (signature.byteLength !== 64) {
        throw new Error("Factory eval Ed25519 signer returned a non-canonical signature.");
      }
      const envelope = factoryDsseEnvelopeSchema.parse({
        payloadType,
        payload: payloadBytes.toString("base64"),
        signatures: [{ keyid: keyId, sig: signature.toString("base64") }]
      });
      return { keyId, envelope };
    } catch (error: unknown) {
      throw new Error("Factory eval DSSE signing failed.", { cause: error });
    } finally {
      encoded?.fill(0);
      signature?.fill(0);
      payloadBytes?.fill(0);
      material.fill(0);
      loaded.fill(0);
    }
  }
}
