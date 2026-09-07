import type { GitObjectId } from "@agentlab/contracts";

/** Reads the concrete tracked-file inventory of one exact local Git revision. */
export interface FactoryMaintenanceEvidenceInventory {
  trackedPaths(repositoryRoot: string, baseRevision: GitObjectId): Promise<ReadonlySet<string>>;
}
