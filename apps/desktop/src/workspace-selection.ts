export type WorkspaceSelector = () => Promise<string | null>;

export async function ensureDesktopWorkspace(
  environment: NodeJS.ProcessEnv,
  isPackaged: boolean,
  selectWorkspace: WorkspaceSelector
): Promise<NodeJS.ProcessEnv | null> {
  if (!isPackaged || environment.AO_WORKSPACE !== undefined) return environment;

  const workspace = await selectWorkspace();
  if (workspace === null) return null;
  return { ...environment, AO_WORKSPACE: workspace };
}
