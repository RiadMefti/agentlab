import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

export interface LocalAppConfig {
  readonly databasePath: string;
}

/** Resolves and validates the process environment used by the local TUI. */
export function loadLocalConfig(
  environment: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd()
): LocalAppConfig {
  const databasePath = resolveDatabasePath(environment, cwd);
  mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });

  return { databasePath };
}

function resolveDatabasePath(environment: NodeJS.ProcessEnv, cwd: string): string {
  if (environment.AGENTLAB_DATABASE_PATH !== undefined) {
    return resolve(cwd, environment.AGENTLAB_DATABASE_PATH);
  }

  const homeDirectory = environment.HOME ?? homedir();
  const dataHome = environment.XDG_DATA_HOME ?? resolve(homeDirectory, ".local", "share");
  return resolve(dataHome, "agentlab", "agentlab.sqlite");
}
