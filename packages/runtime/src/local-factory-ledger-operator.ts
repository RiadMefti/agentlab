import { randomUUID } from "node:crypto";

import {
  factoryLedgerAuthorityCommandSchema,
  factoryLedgerAuthorityRequestSchema,
  factoryLedgerAuthorityResponseSchema,
  type FactoryLedgerAuthorityCommand,
  type FactoryLedgerAuthorityResponse,
  type Sha256Digest
} from "@agentlab/contracts";

import {
  encodeCanonicalDocument,
  NodeFactoryDocumentCodec
} from "./infrastructure/persistence/canonical-factory-documents.js";
import type { LedgerPeerOptions } from "./infrastructure/process/linux-ledger-peer-process.js";
import { requestLinuxLedgerPeer } from "./infrastructure/process/linux-ledger-peer-transport.js";

export interface LocalFactoryLedgerOperatorOptions {
  readonly transport: LedgerPeerOptions;
  readonly serverUid: number;
  readonly operatorId: string;
  readonly peerPolicyDigest: Sha256Digest;
  readonly authorityPolicyDigest: Sha256Digest;
}

/** Separate operator entry point. It owns neither storage nor credentials nor model execution. */
export function createLocalFactoryLedgerOperator(input: LocalFactoryLedgerOperatorOptions) {
  const options = { ...input, transport: { ...input.transport } };
  const documents = new NodeFactoryDocumentCodec();
  const exchange = async (operation: object): Promise<FactoryLedgerAuthorityResponse> => {
    const request = factoryLedgerAuthorityRequestSchema.parse({
      schemaVersion: "agentlab.ledger-authority-request.v1",
      requestId: randomUUID(),
      peerPolicyDigest: options.peerPolicyDigest,
      authorityPolicyDigest: options.authorityPolicyDigest,
      ...operation
    });
    const bytes = await requestLinuxLedgerPeer(
      { ...options.transport, serverUid: options.serverUid },
      new TextEncoder().encode(JSON.stringify(request))
    );
    const response = factoryLedgerAuthorityResponseSchema.parse(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown
    );
    if (response.status === "denied" || response.requestId !== request.requestId)
      throw new Error("Ledger operator command was denied or returned an unrelated response.");
    if (response.status === "receipt") {
      const { receipt } = response;
      if (
        encodeCanonicalDocument(receipt).digest !== response.receiptDigest ||
        encodeCanonicalDocument(receipt.intent).digest !== receipt.intentDigest ||
        receipt.intent.principalUid !== process.getuid?.() ||
        receipt.intent.principalId !== options.operatorId ||
        (receipt.head.event !== null &&
          documents.controlEvent(receipt.head.event).digest !== receipt.head.eventDigest)
      )
        throw new Error("Ledger authority receipt failed its identity checks.");
    }
    return response;
  };
  const intentDigest = (inputCommand: FactoryLedgerAuthorityCommand): Sha256Digest =>
    encodeCanonicalDocument({
      schemaVersion: "agentlab.ledger-authority-intent.v1",
      principalUid: process.getuid?.(),
      principalId: options.operatorId,
      peerPolicyDigest: options.peerPolicyDigest,
      authorityPolicyDigest: options.authorityPolicyDigest,
      command: factoryLedgerAuthorityCommandSchema.parse(inputCommand)
    }).digest;
  return {
    intentDigest,
    async inspect() {
      const response = await exchange({ operation: "authority.inspect" });
      if (response.status !== "inspection")
        throw new Error("Ledger returned the wrong operator response.");
      for (const [control, head] of [
        ["scheduler", response.scheduler],
        ["pr-broker", response.prBroker],
        ["merge-broker", response.mergeBroker]
      ] as const) {
        if (
          head.event !== null &&
          (head.event.control !== control ||
            documents.controlEvent(head.event).digest !== head.eventDigest)
        )
          throw new Error("Ledger authority inspection failed its identity checks.");
      }
      return response;
    },
    async change(command: FactoryLedgerAuthorityCommand) {
      const expectedDigest = intentDigest(command);
      const response = await exchange({ operation: "authority.change", command });
      if (response.status !== "receipt" || response.receipt.intentDigest !== expectedDigest)
        throw new Error("Ledger returned a receipt for another authority command.");
      return response;
    },
    async receipt(idempotencyKey: string, expectedIntentDigest: Sha256Digest) {
      const response = await exchange({
        operation: "authority.receipt",
        idempotencyKey,
        intentDigest: expectedIntentDigest
      });
      if (
        response.status !== "receipt" ||
        response.receipt.intentDigest !== expectedIntentDigest ||
        response.receipt.intent.command.idempotencyKey !== idempotencyKey
      )
        throw new Error("Ledger returned a receipt for another authority command.");
      return response;
    }
  };
}
