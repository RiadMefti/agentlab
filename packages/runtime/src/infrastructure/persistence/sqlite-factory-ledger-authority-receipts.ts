import type { DatabaseSync } from "node:sqlite";

import {
  factoryLedgerAuthorityIntentSchema,
  factoryLedgerAuthorityReceiptSchema,
  factoryTimestampSchema,
  type FactoryControlEvent,
  type FactoryControlName,
  type FactoryLedgerAuthorityHead,
  type FactoryLedgerAuthorityIntent,
  type FactoryLedgerAuthorityReceipt
} from "@agentlab/contracts";
import { z } from "zod";

import type { CanonicalFactoryDocument } from "../../domain/factory-documents.js";
import { ConflictError } from "../../domain/errors.js";
import {
  encodeCanonicalDocument,
  NodeFactoryDocumentCodec
} from "./canonical-factory-documents.js";

export function readLedgerAuthorityReceipt(
  database: DatabaseSync,
  principalUid: number,
  idempotencyKey: string,
  findEvent: (
    control: FactoryControlName,
    digest: string
  ) => CanonicalFactoryDocument<FactoryControlEvent> | null
): CanonicalFactoryDocument<FactoryLedgerAuthorityReceipt> | null {
  z.number().int().min(1).max(0xffff_fffe).parse(principalUid);
  z.uuid().parse(idempotencyKey);
  const row = database
    .prepare(
      `SELECT intent_digest, receipt_digest, receipt_json, recorded_at
    FROM factory_ledger_authority_receipts WHERE principal_uid = ? AND idempotency_key = ?`
    )
    .get(principalUid, idempotencyKey);
  if (row === undefined) return null;
  if (typeof row.receipt_json !== "string")
    throw new Error("Invalid ledger authority receipt storage.");
  const receipt = encodeCanonicalDocument(
    factoryLedgerAuthorityReceiptSchema.parse(JSON.parse(row.receipt_json) as unknown)
  );
  const { intent, head } = receipt.value;
  const intentDigest = encodeCanonicalDocument(intent).digest;
  const event =
    head.eventDigest === null ? null : findEvent(intent.command.control, head.eventDigest);
  if (
    receipt.json !== row.receipt_json ||
    receipt.digest !== row.receipt_digest ||
    receipt.value.recordedAt !== row.recorded_at ||
    intentDigest !== row.intent_digest ||
    intentDigest !== receipt.value.intentDigest ||
    intent.principalUid !== principalUid ||
    intent.command.idempotencyKey !== idempotencyKey ||
    (head.event !== null &&
      event?.json !== new NodeFactoryDocumentCodec().controlEvent(head.event).json)
  ) {
    throw new Error("Ledger authority receipt failed immutable identity verification.");
  }
  return receipt;
}

/** Called only inside the owning repository's BEGIN IMMEDIATE transaction. */
export function recordLedgerAuthorityReceipt(input: {
  database: DatabaseSync;
  intent: CanonicalFactoryDocument<FactoryLedgerAuthorityIntent>;
  event: CanonicalFactoryDocument<FactoryControlEvent>;
  now: () => string;
  head: () => FactoryLedgerAuthorityHead;
  findEvent: (
    control: FactoryControlName,
    digest: string
  ) => CanonicalFactoryDocument<FactoryControlEvent> | null;
  insertEvent: () => void;
}): CanonicalFactoryDocument<FactoryLedgerAuthorityReceipt> {
  const intent = encodeCanonicalDocument(
    factoryLedgerAuthorityIntentSchema.parse(input.intent.value)
  );
  if (intent.digest !== input.intent.digest || intent.json !== input.intent.json)
    throw new Error("Ledger authority intent differs from its canonical identity.");
  const { command } = intent.value;
  const prior = readLedgerAuthorityReceipt(
    input.database,
    intent.value.principalUid,
    command.idempotencyKey,
    input.findEvent
  );
  if (prior !== null) {
    if (prior.value.intentDigest !== intent.digest)
      throw new ConflictError("Ledger authority idempotency key already binds another intent.");
    return prior;
  }
  const current = input.head();
  const applied =
    current.enabled === command.expectedEnabled &&
    current.eventDigest === command.expectedEventDigest;
  const receipt = encodeCanonicalDocument(
    factoryLedgerAuthorityReceiptSchema.parse({
      schemaVersion: "agentlab.ledger-authority-receipt.v1",
      intent: intent.value,
      intentDigest: intent.digest,
      outcome: applied ? "applied" : "conflict",
      head: applied
        ? {
            enabled: input.event.value.enabled,
            event: input.event.value,
            eventDigest: input.event.digest
          }
        : current,
      recordedAt: input.event.value.occurredAt
    })
  );
  const commitTime = factoryTimestampSchema.parse(input.now());
  if (
    receipt.value.recordedAt >= command.expiresAt ||
    commitTime >= command.expiresAt ||
    commitTime < receipt.value.recordedAt
  )
    throw new ConflictError(
      "Ledger authority command expired or the clock regressed before commit."
    );
  if (applied) input.insertEvent();
  input.database
    .prepare(
      `INSERT INTO factory_ledger_authority_receipts
    (principal_uid, idempotency_key, intent_digest, receipt_digest, receipt_json, recorded_at)
    VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(
      intent.value.principalUid,
      command.idempotencyKey,
      intent.digest,
      receipt.digest,
      receipt.json,
      receipt.value.recordedAt
    );
  return receipt;
}
