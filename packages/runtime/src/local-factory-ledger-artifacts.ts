import { randomUUID } from "node:crypto";

import {
  factoryArtifactReferenceSchema,
  factoryLedgerArtifactIntentSchema,
  factoryLedgerArtifactRequestSchema,
  factoryLedgerArtifactResponseSchema,
  factoryLedgerArtifactUploadSchema,
  maximumLedgerArtifactBytes,
  type FactoryLedgerArtifactUpload,
  type Sha256Digest
} from "@agentlab/contracts";

import { NodeFactoryArtifactWireCodec } from "./infrastructure/filesystem/node-factory-artifact-wire-codec.js";
import { encodeCanonicalDocument } from "./infrastructure/persistence/canonical-factory-documents.js";
import type { LedgerPeerOptions } from "./infrastructure/process/linux-ledger-peer-process.js";
import { requestLinuxLedgerPeer } from "./infrastructure/process/linux-ledger-peer-transport.js";

export interface LocalFactoryLedgerArtifactsOptions {
  readonly transport: LedgerPeerOptions;
  readonly serverUid: number;
  readonly principalId: string;
  readonly principalKind: "implementer" | "reviewer" | "gate-observer" | "reader";
  readonly peerPolicyDigest: Sha256Digest;
  readonly artifactPolicyDigest: Sha256Digest;
}

/** Bounded task-scoped bytes only; no storage path, evidence approval, or generic RPC capability. */
export function createLocalFactoryLedgerArtifacts(input: LocalFactoryLedgerArtifactsOptions) {
  const options = { ...input, transport: { ...input.transport } };
  const wire = new NodeFactoryArtifactWireCodec();
  const intentDigest = (upload: FactoryLedgerArtifactUpload): Sha256Digest =>
    encodeCanonicalDocument(
      factoryLedgerArtifactIntentSchema.parse({
        schemaVersion: "agentlab.ledger-artifact-intent.v1",
        principalUid: process.getuid?.(),
        principalId: options.principalId,
        principalKind: options.principalKind,
        peerPolicyDigest: options.peerPolicyDigest,
        artifactPolicyDigest: options.artifactPolicyDigest,
        upload
      })
    ).digest;
  const exchange = async (operation: object) => {
    const request = factoryLedgerArtifactRequestSchema.parse({
      schemaVersion: "agentlab.ledger-artifact-request.v1",
      requestId: randomUUID(),
      peerPolicyDigest: options.peerPolicyDigest,
      artifactPolicyDigest: options.artifactPolicyDigest,
      ...operation
    });
    const bytes = await requestLinuxLedgerPeer(
      { ...options.transport, serverUid: options.serverUid },
      new TextEncoder().encode(JSON.stringify(request))
    );
    const response = factoryLedgerArtifactResponseSchema.parse(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown
    );
    if (response.requestId !== request.requestId || response.status === "denied")
      throw new Error("Ledger artifact operation was denied or returned an unrelated response.");
    if (response.status === "reservation") {
      const { reservation } = response;
      if (
        encodeCanonicalDocument(reservation).digest !== response.reservationDigest ||
        encodeCanonicalDocument(reservation.intent).digest !== reservation.intentDigest ||
        reservation.intent.principalUid !== process.getuid?.() ||
        reservation.intent.principalId !== options.principalId ||
        reservation.reservedAt >= reservation.intent.upload.expiresAt
      )
        throw new Error("Artifact reservation failed immutable identity checks.");
    }
    return response;
  };
  return {
    intentDigest,
    describe(bytes: Uint8Array, mediaType: string) {
      if (!(bytes instanceof Uint8Array) || bytes.byteLength > maximumLedgerArtifactBytes)
        throw new Error("Artifact bytes exceed the transport limit.");
      return factoryArtifactReferenceSchema.parse({
        digest: wire.digest(bytes),
        sizeBytes: bytes.byteLength,
        mediaType
      });
    },
    async submit(inputUpload: FactoryLedgerArtifactUpload, bytes: Uint8Array) {
      const upload = factoryLedgerArtifactUploadSchema.parse(inputUpload);
      if (
        !(bytes instanceof Uint8Array) ||
        bytes.byteLength !== upload.artifact.sizeBytes ||
        wire.digest(bytes) !== upload.artifact.digest
      )
        throw new Error("Artifact bytes do not match the proposed upload identity.");
      const expectedDigest = intentDigest(upload);
      const response = await exchange({
        operation: "artifact.submit",
        upload,
        contentBase64: wire.encodeBase64(bytes)
      });
      if (
        response.status !== "reservation" ||
        !response.stored ||
        response.reservation.intentDigest !== expectedDigest
      )
        throw new Error("Ledger did not confirm storage of this exact artifact intent.");
      return response;
    },
    async read(taskId: string, contractDigest: Sha256Digest, artifactDigest: Sha256Digest) {
      const response = await exchange({
        operation: "artifact.read",
        taskId,
        contractDigest,
        artifactDigest
      });
      if (
        response.status !== "artifact" ||
        response.taskId !== taskId ||
        response.contractDigest !== contractDigest ||
        response.artifact.digest !== artifactDigest ||
        response.artifact.sizeBytes > maximumLedgerArtifactBytes
      )
        throw new Error("Ledger returned an artifact for another task or digest.");
      const bytes = wire.decodeBase64(response.contentBase64);
      if (bytes.byteLength !== response.artifact.sizeBytes || wire.digest(bytes) !== artifactDigest)
        throw new Error("Ledger artifact bytes failed integrity verification.");
      return { artifact: response.artifact, bytes };
    },
    async receipt(
      taskId: string,
      contractDigest: Sha256Digest,
      idempotencyKey: string,
      expectedIntentDigest: Sha256Digest
    ) {
      const response = await exchange({
        operation: "artifact.receipt",
        taskId,
        contractDigest,
        idempotencyKey,
        intentDigest: expectedIntentDigest
      });
      if (
        response.status !== "reservation" ||
        response.reservation.intentDigest !== expectedIntentDigest ||
        response.reservation.intent.upload.taskId !== taskId ||
        response.reservation.intent.upload.contractDigest !== contractDigest ||
        response.reservation.intent.upload.idempotencyKey !== idempotencyKey
      )
        throw new Error("Ledger returned a reservation for another artifact intent.");
      return response;
    }
  };
}
