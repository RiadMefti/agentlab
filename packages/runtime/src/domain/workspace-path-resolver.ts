export interface ResolvedWorkspacePath {
  readonly path: string;
  readonly suggestedName: string;
}

/** Resolves user-selected folders without coupling application behavior to Node's filesystem. */
export interface WorkspacePathResolver {
  resolve(input: string): Promise<ResolvedWorkspacePath>;
}
