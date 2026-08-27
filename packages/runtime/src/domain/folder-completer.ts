import type { FolderCompletionInput, FolderSuggestion } from "@agentlab/contracts";

/** Provider-neutral port for bounded, best-effort local folder completion. */
export interface FolderCompleter {
  complete(input: FolderCompletionInput): Promise<readonly FolderSuggestion[]>;
}
