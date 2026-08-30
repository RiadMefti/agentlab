import type { Sha256Digest } from "@agentlab/contracts";

export interface StoredFactoryArtifact {
  readonly digest: Sha256Digest;
  readonly sizeBytes: number;
}

/** Content-addressed local evidence storage. Artifacts are immutable after publication. */
export interface FactoryArtifactStore {
  put(content: Uint8Array): Promise<StoredFactoryArtifact>;
  putText(content: string): Promise<StoredFactoryArtifact>;
  read(digest: Sha256Digest, maximumBytes: number): Promise<Uint8Array>;
  readText(digest: Sha256Digest, maximumBytes: number): Promise<string>;
}
