import { randomUUID } from "node:crypto";

import {
  factoryLedgerOperationRequestSchema,
  factoryLedgerOperationResponseSchema,
  type FactoryLedgerOperation,
  type Sha256Digest
} from "@agentlab/contracts";

import { encodeCanonicalDocument } from "./infrastructure/persistence/canonical-factory-documents.js";
import type { LedgerPeerOptions } from "./infrastructure/process/linux-ledger-peer-process.js";
import { requestLinuxLedgerPeer } from "./infrastructure/process/linux-ledger-peer-transport.js";

export interface LocalFactoryLedgerOperationsOptions {
  readonly transport: LedgerPeerOptions;
  readonly serverUid: number;
  readonly principalId: string;
  readonly principalKind: FactoryLedgerOperation["principal"]["kind"];
  readonly workerPolicyDigest: Sha256Digest;
  readonly peerPolicyDigest: Sha256Digest;
  readonly operationPolicyDigest: Sha256Digest;
}
interface TaskCoordinates {
  readonly taskId: string;
  readonly contractDigest: Sha256Digest;
}
interface JobCoordinates extends TaskCoordinates {
  readonly jobId: string;
  readonly jobDigest: Sha256Digest;
}

/** Explicit job consumption only; no enqueue, task mutation, authority or persistence capability. */
export function createLocalFactoryLedgerOperations(input: LocalFactoryLedgerOperationsOptions) {
  const options = { ...input, transport: { ...input.transport } };
  const exchange = async (operation: object) => {
    const request = factoryLedgerOperationRequestSchema.parse({
      schemaVersion: "agentlab.ledger-operation-request.v1",
      requestId: randomUUID(),
      peerPolicyDigest: options.peerPolicyDigest,
      operationPolicyDigest: options.operationPolicyDigest,
      ...operation
    });
    const bytes = await requestLinuxLedgerPeer(
      { ...options.transport, serverUid: options.serverUid },
      new TextEncoder().encode(JSON.stringify(request))
    );
    const response = factoryLedgerOperationResponseSchema.parse(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown
    );
    if (response.status === "denied" || response.requestId !== request.requestId)
      throw new Error("Ledger operation was denied or returned an unrelated response.");
    if (response.status === "empty") {
      if (request.operation !== "operation.next")
        throw new Error("Ledger returned an unexpected empty job response.");
      return response;
    }
    const { job, jobDigest, claim, claimDigest, receipt, receiptDigest, newlyClaimed } = response;
    if (
      encodeCanonicalDocument(job).digest !== jobDigest ||
      job.taskId !== request.taskId ||
      job.contractDigest !== request.contractDigest ||
      job.principal.uid !== process.getuid?.() ||
      job.principal.id !== options.principalId ||
      job.principal.kind !== options.principalKind ||
      job.workerPolicyDigest !== options.workerPolicyDigest ||
      (request.operation !== "operation.next" &&
        (job.jobId !== request.jobId || jobDigest !== request.jobDigest)) ||
      (claim === null) !== (claimDigest === null) ||
      (receipt === null) !== (receiptDigest === null)
    )
      throw new Error("Ledger job failed canonical task and principal checks.");
    if (
      claim !== null &&
      (encodeCanonicalDocument(claim).digest !== claimDigest ||
        claim.jobId !== job.jobId ||
        claim.jobDigest !== jobDigest ||
        claim.principalUid !== job.principal.uid ||
        claim.claimedAt < job.createdAt ||
        claim.claimedAt >= job.expiresAt)
    )
      throw new Error("Ledger claim failed immutable job binding.");
    if (
      receipt !== null &&
      (claim === null ||
        encodeCanonicalDocument(receipt).digest !== receiptDigest ||
        receipt.jobId !== job.jobId ||
        receipt.jobDigest !== jobDigest ||
        receipt.claimDigest !== claimDigest ||
        receipt.principalUid !== job.principal.uid ||
        receipt.reportedAt < claim.claimedAt ||
        receipt.reportedAt >= job.expiresAt)
    )
      throw new Error("Ledger receipt failed immutable claim binding.");
    if (
      newlyClaimed &&
      (request.operation !== "operation.claim" ||
        claim === null ||
        receipt !== null ||
        claim.invocationId !== request.invocationId)
    )
      throw new Error("Ledger did not return a fresh one-shot invocation claim.");
    return response;
  };
  return {
    next(task: TaskCoordinates) {
      return exchange({ ...task, operation: "operation.next" });
    },
    inspect(job: JobCoordinates) {
      return exchange({ ...job, operation: "operation.inspect" });
    },
    async claim(job: JobCoordinates, invocationId: string) {
      const response = await exchange({ ...job, invocationId, operation: "operation.claim" });
      if (response.status !== "job" || response.claim?.invocationId !== invocationId)
        throw new Error("Ledger returned another invocation claim.");
      // A replay is observable, never silently promoted into permission to execute again.
      return response;
    },
    async report(
      job: JobCoordinates,
      claimDigest: Sha256Digest,
      artifactReservationKey: string,
      artifactReservationDigest: Sha256Digest
    ) {
      const response = await exchange({
        ...job,
        claimDigest,
        artifactReservationKey,
        artifactReservationDigest,
        operation: "operation.report"
      });
      if (
        response.status !== "job" ||
        response.receipt?.claimDigest !== claimDigest ||
        response.receipt.artifactReservationDigest !== artifactReservationDigest
      )
        throw new Error("Ledger returned an unrelated operation result receipt.");
      return response;
    }
  };
}
