import { resolve } from "node:path";

export interface DesktopPathContext {
  readonly appPath: string;
  readonly isPackaged: boolean;
  readonly userDataPath: string;
}

export function withDesktopDefaults(
  environment: NodeJS.ProcessEnv,
  paths: DesktopPathContext
): NodeJS.ProcessEnv {
  const defaultDatabasePath = paths.isPackaged
    ? resolve(paths.userDataPath, "orchestrator.sqlite")
    : resolve(paths.appPath, "apps/server/.data/orchestrator.sqlite");

  return {
    ...environment,
    AO_DATABASE_PATH: environment.AO_DATABASE_PATH ?? defaultDatabasePath,
    AO_PORT: environment.AO_PORT ?? "0"
  };
}
