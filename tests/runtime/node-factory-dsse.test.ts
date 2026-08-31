import { createHash, generateKeyPairSync, type KeyObject } from "node:crypto";

import {
  factoryDsseEnvelopeSchema,
  factoryEvalAttestationPayloadType,
  sha256DigestSchema,
  type Sha256Digest
} from "@agentlab/contracts";
import { describe, expect, it } from "vitest";

import type { FactoryEvalAttestationKeySource } from "../../packages/runtime/src/domain/factory-eval-attestation-crypto.js";
import { NodeFactoryDsseSigner } from "../../packages/runtime/src/infrastructure/crypto/node-factory-dsse-signer.js";
import { NodeFactoryDsseVerifier } from "../../packages/runtime/src/infrastructure/crypto/node-factory-dsse-verifier.js";

const payload = '{"kind":"agentlab-eval","passed":true}';

describe("NodeFactoryDsseSigner and NodeFactoryDsseVerifier", () => {
  it("signs and verifies the exact DSSE PAE bytes with one pinned Ed25519 key", async () => {
    const key = ed25519Key();
    const privateSource = new TrackingKeySource(key.privatePem);
    const publicSource = new TrackingKeySource(key.publicPem);
    const signer = new NodeFactoryDsseSigner(privateSource, key.keyId);
    const verifier = new NodeFactoryDsseVerifier(publicSource, key.keyId);

    const signed = await signer.sign(factoryEvalAttestationPayloadType, payload);
    const verified = await verifier.verify(signed.envelope);

    expect(signed.keyId).toBe(key.keyId);
    expect(signed.envelope).toEqual(
      factoryDsseEnvelopeSchema.parse({
        payloadType: factoryEvalAttestationPayloadType,
        payload: Buffer.from(payload, "utf8").toString("base64"),
        signatures: [
          {
            keyid: key.keyId,
            sig: signed.envelope.signatures[0]?.sig
          }
        ]
      })
    );
    expect(verified).toEqual({ keyId: key.keyId, payload });
    expect(privateSource.loads).toHaveLength(1);
    expect(publicSource.loads).toHaveLength(1);
    expect(privateSource.loads[0]?.every((byte) => byte === 0)).toBe(true);
    expect(publicSource.loads[0]?.every((byte) => byte === 0)).toBe(true);
  });

  it("rejects payload tampering and a forged trusted-key hint", async () => {
    const trusted = ed25519Key();
    const attacker = ed25519Key();
    const trustedSigner = new NodeFactoryDsseSigner(
      new TrackingKeySource(trusted.privatePem),
      trusted.keyId
    );
    const attackerSigner = new NodeFactoryDsseSigner(
      new TrackingKeySource(attacker.privatePem),
      attacker.keyId
    );
    const verifier = new NodeFactoryDsseVerifier(
      new TrackingKeySource(trusted.publicPem),
      trusted.keyId
    );

    const signed = await trustedSigner.sign(factoryEvalAttestationPayloadType, payload);
    await expect(
      verifier.verify({
        ...signed.envelope,
        payload: Buffer.from('{"kind":"tampered"}', "utf8").toString("base64")
      })
    ).rejects.toThrow(/verification failed/u);

    const forged = await attackerSigner.sign(factoryEvalAttestationPayloadType, payload);
    const attackerSignature = forged.envelope.signatures[0];
    if (attackerSignature === undefined) throw new Error("Fixture requires one signature.");
    await expect(
      verifier.verify({
        ...forged.envelope,
        signatures: [{ ...attackerSignature, keyid: trusted.keyId }]
      })
    ).rejects.toThrow(/verification failed/u);
  });

  it("rejects a key that does not match the configured trust root and erases loaded bytes", async () => {
    const trusted = ed25519Key();
    const other = ed25519Key();
    const source = new TrackingKeySource(other.privatePem);
    const signer = new NodeFactoryDsseSigner(source, trusted.keyId);

    await expect(signer.sign(factoryEvalAttestationPayloadType, payload)).rejects.toThrow(
      /signing failed/u
    );
    expect(source.loads).toHaveLength(1);
    expect(source.loads[0]?.every((byte) => byte === 0)).toBe(true);

    const verifierSource = new TrackingKeySource(other.publicPem);
    const verifier = new NodeFactoryDsseVerifier(verifierSource, trusted.keyId);
    const validOther = await new NodeFactoryDsseSigner(
      new TrackingKeySource(other.privatePem),
      other.keyId
    ).sign(factoryEvalAttestationPayloadType, payload);
    await expect(verifier.verify(validOther.envelope)).rejects.toThrow(/verification failed/u);
    expect(verifierSource.loads[0]?.every((byte) => byte === 0)).toBe(true);
  });

  it("fails closed on unsupported payloads, envelope widening, and non-Ed25519 keys", async () => {
    const key = ed25519Key();
    const signer = new NodeFactoryDsseSigner(new TrackingKeySource(key.privatePem), key.keyId);
    const signed = await signer.sign(factoryEvalAttestationPayloadType, payload);
    const signature = signed.envelope.signatures[0];
    if (signature === undefined) throw new Error("Fixture requires one signature.");

    await expect(signer.sign("application/json", payload)).rejects.toThrow(/unsupported/u);
    await expect(
      signer.sign(factoryEvalAttestationPayloadType, "x".repeat(64 * 1_024 + 1))
    ).rejects.toThrow(/oversized/u);
    await expect(
      new NodeFactoryDsseVerifier(new TrackingKeySource(key.publicPem), key.keyId).verify({
        ...signed.envelope,
        signatures: [signature, { ...signature, keyid: otherDigest(key.keyId) }]
      })
    ).rejects.toThrow();

    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const rsaPrivate = Buffer.from(rsa.privateKey.export({ format: "pem", type: "pkcs8" }));
    await expect(
      new NodeFactoryDsseSigner(new TrackingKeySource(rsaPrivate), key.keyId).sign(
        factoryEvalAttestationPayloadType,
        payload
      )
    ).rejects.toThrow(/signing failed/u);
  });
});

class TrackingKeySource implements FactoryEvalAttestationKeySource {
  public readonly loads: Uint8Array[] = [];

  public constructor(private readonly source: Uint8Array) {}

  public load(): Promise<Uint8Array> {
    const loaded = Uint8Array.from(this.source);
    this.loads.push(loaded);
    return Promise.resolve(loaded);
  }
}

function ed25519Key(): {
  readonly privatePem: Uint8Array;
  readonly publicPem: Uint8Array;
  readonly keyId: Sha256Digest;
} {
  const pair = generateKeyPairSync("ed25519");
  return {
    privatePem: Buffer.from(pair.privateKey.export({ format: "pem", type: "pkcs8" })),
    publicPem: Buffer.from(pair.publicKey.export({ format: "pem", type: "spki" })),
    keyId: keyId(pair.publicKey)
  };
}

function keyId(publicKey: KeyObject): Sha256Digest {
  const der = publicKey.export({ format: "der", type: "spki" });
  return sha256DigestSchema.parse(`sha256:${createHash("sha256").update(der).digest("hex")}`);
}

function otherDigest(digest: Sha256Digest): Sha256Digest {
  return digest.endsWith("0") ? `${digest.slice(0, -1)}1` : `${digest.slice(0, -1)}0`;
}
