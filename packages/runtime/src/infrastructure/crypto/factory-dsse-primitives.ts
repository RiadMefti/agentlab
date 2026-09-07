import { createHash, type KeyObject } from "node:crypto";

import {
  factoryEvalAttestationPayloadType,
  sha256DigestSchema,
  type Sha256Digest
} from "@agentlab/contracts";

export const maximumFactoryDssePayloadBytes = 64 * 1_024;

export function assertFactoryDssePayload(payloadType: string, payload: string): void {
  if (payloadType !== factoryEvalAttestationPayloadType) {
    throw new Error("Factory eval DSSE payload type is unsupported.");
  }
  const bytes = Buffer.byteLength(payload, "utf8");
  if (bytes < 2 || bytes > maximumFactoryDssePayloadBytes || payload.includes("\0")) {
    throw new Error("Factory eval DSSE payload is invalid or oversized.");
  }
}

export function assertFactoryEd25519Key(key: KeyObject, type: "private" | "public"): void {
  if (key.type !== type || key.asymmetricKeyType !== "ed25519") {
    throw new Error(`Factory eval attestation requires an Ed25519 ${type} key.`);
  }
}

export function factoryEd25519PublicKeyId(publicKey: KeyObject): Sha256Digest {
  const encoded = publicKey.export({ type: "spki", format: "der" });
  return sha256DigestSchema.parse(`sha256:${createHash("sha256").update(encoded).digest("hex")}`);
}

export function factoryDssePreAuthenticationEncoding(payloadType: string, payload: Buffer): Buffer {
  const type = Buffer.from(payloadType, "utf8");
  return Buffer.concat([
    Buffer.from(`DSSEv1 ${String(type.byteLength)} `, "ascii"),
    type,
    Buffer.from(` ${String(payload.byteLength)} `, "ascii"),
    payload
  ]);
}

export function decodeCanonicalFactoryBase64(value: string, label: string): Buffer {
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) {
    decoded.fill(0);
    throw new Error(`Factory eval DSSE ${label} is not canonical base64.`);
  }
  return decoded;
}
