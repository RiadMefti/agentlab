import type { GitObjectId } from "@agentlab/contracts";

/** Reads the current commit of a canonical local repository without accepting caller assertions. */
export interface FactoryRepositoryRevisionReader {
  currentRevision(repositoryRoot: string): Promise<GitObjectId>;
}
