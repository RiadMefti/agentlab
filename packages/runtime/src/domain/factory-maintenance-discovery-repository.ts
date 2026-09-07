import type {
  FactoryMaintenanceDiscoveryEvent,
  FactoryMaintenanceDiscoveryRun,
  FactoryMaintenanceDiscoveryState,
  Sha256Digest
} from "@agentlab/contracts";

import type { CanonicalFactoryDocument } from "./factory-documents.js";

export interface FactoryMaintenanceDiscoverySnapshot {
  readonly run: FactoryMaintenanceDiscoveryRun;
  readonly runDigest: Sha256Digest;
  readonly state: FactoryMaintenanceDiscoveryState;
  readonly sequence: number;
  readonly lastEvent: FactoryMaintenanceDiscoveryEvent;
  readonly lastEventDigest: Sha256Digest;
  readonly events: readonly FactoryMaintenanceDiscoveryEvent[];
}

/** Append-only recovery journal for one read-only maintenance-discovery slot. */
export interface FactoryMaintenanceDiscoveryRepository {
  register(
    run: CanonicalFactoryDocument<FactoryMaintenanceDiscoveryRun>,
    event: CanonicalFactoryDocument<FactoryMaintenanceDiscoveryEvent>
  ): Promise<FactoryMaintenanceDiscoverySnapshot>;
  findBySlot(
    discoveryPolicyId: string,
    scheduledFor: string
  ): Promise<FactoryMaintenanceDiscoverySnapshot | null>;
  findOpen(): Promise<FactoryMaintenanceDiscoverySnapshot | null>;
  append(
    event: CanonicalFactoryDocument<FactoryMaintenanceDiscoveryEvent>
  ): Promise<FactoryMaintenanceDiscoverySnapshot | null>;
  close(): void;
}
