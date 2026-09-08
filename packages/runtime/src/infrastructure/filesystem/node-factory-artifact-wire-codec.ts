import { createHash } from "node:crypto";

import type { Sha256Digest } from "@agentlab/contracts";

import type { FactoryArtifactWireCodec } from "../../domain/factory-ledger-artifacts.js";

export class NodeFactoryArtifactWireCodec implements FactoryArtifactWireCodec {
  public decodeBase64(encoded: string): Uint8Array {
    const bytes = Buffer.from(encoded, "base64");
    if (bytes.toString("base64") !== encoded)
      throw new Error("Artifact bytes require canonical base64.");
    return bytes;
  }
  public encodeBase64(bytes: Uint8Array): string {
    return Buffer.from(bytes).toString("base64");
  }
  public digest(bytes: Uint8Array): Sha256Digest {
    return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  }
}
