import { mkdirSync, statSync } from "node:fs";
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
  if (environment.AO_DATABASE_PATH !== undefined) {
    return resolve(cwd, environment.AO_DATABASE_PATH);
  }

  const homeDirectory = environment.HOME ?? homedir();
  const dataHome = environment.XDG_DATA_HOME ?? resolve(homeDirectory, ".local", "share");
  const preferred = resolve(dataHome, "agent-orchestrator", "orchestrator.sqlite");
  if (isFile(preferred)) return preferred;

  const configHome = environment.XDG_CONFIG_HOME ?? resolve(homeDirectory, ".config");
  const legacyCandidates = [
    resolve(configHome, "Orchestrator", "orchestrator.sqlite"),
    resolve(configHome, "orchestrator", "orchestrator.sqlite"),
    resolve(homeDirectory, "Library", "Application Support", "Orchestrator", "orchestrator.sqlite"),
    ...(environment.APPDATA === undefined
      ? []
      : [resolve(environment.APPDATA, "Orchestrator", "orchestrator.sqlite")]),
    resolve(cwd, "apps", "server", ".data", "orchestrator.sqlite")
  ];
  return legacyCandidates.find(isFile) ?? preferred;
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return false;
    throw error;
  }
}
