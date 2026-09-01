import type {
  FactoryControlEvent,
  FactoryIncidentContainment,
  Sha256Digest
} from "@agentlab/contracts";

import type { CanonicalFactoryDocument } from "./factory-documents.js";
import type { FactoryAuthorityState } from "./factory-task-repository.js";

export interface FactoryIncidentContainmentSnapshot {
  readonly containment: FactoryIncidentContainment;
  readonly containmentDigest: Sha256Digest;
}

/** Complete material for one broker-first, scheduler-second, disable-only transaction. */
export interface FactoryIncidentDisableCommand {
  readonly expectedAuthority: FactoryAuthorityState;
  readonly brokerDisableEvent: CanonicalFactoryDocument<FactoryControlEvent> | null;
  readonly schedulerDisableEvent: CanonicalFactoryDocument<FactoryControlEvent> | null;
  readonly containment: CanonicalFactoryDocument<FactoryIncidentContainment>;
}

/** Append-only incident journal with no operation capable of enabling factory authority. */
export interface FactoryIncidentContainmentRepository {
  disableAtomically(
    command: FactoryIncidentDisableCommand
  ): Promise<FactoryIncidentContainmentSnapshot | null>;
  findByHealthReportDigest(
    healthReportDigest: Sha256Digest
  ): Promise<FactoryIncidentContainmentSnapshot | null>;
  close(): void;
}
