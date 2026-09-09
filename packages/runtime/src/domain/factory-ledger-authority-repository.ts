import type {
  FactoryControlEvent,
  FactoryControlName,
  FactoryLedgerAuthorityHead,
  FactoryLedgerAuthorityIntent,
  FactoryLedgerAuthorityReceipt
} from "@agentlab/contracts";

import type { CanonicalFactoryDocument } from "./factory-documents.js";

/** One transaction records either the CAS conflict or both the control event and its receipt. */
export interface FactoryLedgerAuthorityRepository {
  authorityHead(control: FactoryControlName): Promise<FactoryLedgerAuthorityHead>;
  findAuthorityReceipt(
    principalUid: number,
    idempotencyKey: string
  ): Promise<CanonicalFactoryDocument<FactoryLedgerAuthorityReceipt> | null>;
  changeAuthority(
    intent: CanonicalFactoryDocument<FactoryLedgerAuthorityIntent>,
    proposedEvent: CanonicalFactoryDocument<FactoryControlEvent>,
    now: () => string
  ): Promise<CanonicalFactoryDocument<FactoryLedgerAuthorityReceipt>>;
}
