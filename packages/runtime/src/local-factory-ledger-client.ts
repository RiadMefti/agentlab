import { randomUUID } from "node:crypto";

import {
  factoryLedgerReadRequestSchema,
  factoryLedgerReadResponseSchema,
  type FactoryLedgerReadRequest,
  type FactoryLedgerReadResponse,
  type Sha256Digest
} from "@agentlab/contracts";

import { NodeFactoryDocumentCodec } from "./infrastructure/persistence/canonical-factory-documents.js";
import type { LedgerPeerOptions } from "./infrastructure/process/linux-ledger-peer-process.js";
import { requestLinuxLedgerPeer } from "./infrastructure/process/linux-ledger-peer-transport.js";

export interface LocalFactoryLedgerClientOptions {
  readonly transport: LedgerPeerOptions;
  readonly serverUid: number;
  readonly peerPolicyDigest: Sha256Digest;
}

/** No direct storage or generic RPC fallback; all requests authenticate the configured ledger UID. */
export function createLocalFactoryLedgerClient(options: LocalFactoryLedgerClientOptions): {
  readAuthority: () => Promise<Extract<FactoryLedgerReadResponse, { status: "authority" }>>;
  readTask: (
    taskId: string,
    contractDigest: Sha256Digest
  ) => Promise<Extract<FactoryLedgerReadResponse, { status: "task" }>["snapshot"]>;
} {
  const documents = new NodeFactoryDocumentCodec();
  const exchange = async (
    operation:
      | { operation: "authority.read" }
      | { operation: "task.read"; taskId: string; contractDigest: Sha256Digest }
  ): Promise<FactoryLedgerReadResponse> => {
    const request: FactoryLedgerReadRequest = factoryLedgerReadRequestSchema.parse({
      schemaVersion: "agentlab.ledger-read-request.v1",
      requestId: randomUUID(),
      peerPolicyDigest: options.peerPolicyDigest,
      ...operation
    });
    const bytes = await requestLinuxLedgerPeer(
      { ...options.transport, serverUid: options.serverUid },
      new TextEncoder().encode(JSON.stringify(request))
    );
    const decoded: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    const response = factoryLedgerReadResponseSchema.parse(decoded);
    if (response.requestId !== request.requestId || response.status === "denied")
      throw new Error("Ledger query was denied or returned an unrelated response.");
    return response;
  };
  return {
    async readAuthority() {
      const response = await exchange({ operation: "authority.read" });
      if (response.status !== "authority")
        throw new Error("Ledger returned the wrong response type.");
      return response;
    },
    async readTask(taskId, contractDigest) {
      const response = await exchange({ operation: "task.read", taskId, contractDigest });
      if (response.status !== "task") throw new Error("Ledger returned the wrong response type.");
      const snapshot = response.snapshot;
      if (
        snapshot.contract.taskId !== taskId ||
        snapshot.contractDigest !== contractDigest ||
        documents.taskContract(snapshot.contract).digest !== contractDigest ||
        documents.taskEvent(snapshot.lastEvent).digest !== snapshot.lastEventDigest ||
        snapshot.lastEvent.taskId !== taskId ||
        snapshot.lastEvent.contractDigest !== contractDigest ||
        snapshot.lastEvent.to !== snapshot.state ||
        snapshot.lastEvent.sequence !== snapshot.sequence
      ) {
        throw new Error("Ledger task snapshot does not match its immutable identity.");
      }
      return snapshot;
    }
  };
}
