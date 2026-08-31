import type { Sha256Digest } from "@agentlab/contracts";

export interface FactoryIntakeDeduplicationInput {
  readonly repositoryId: string;
  readonly requestKind: "feature" | "bug";
  readonly sourceRef: string;
}

/** Derives a stable request identity without trusting a caller-provided digest. */
export interface FactoryIntakeDeduplicator {
  key(input: FactoryIntakeDeduplicationInput): Sha256Digest;
}
