import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";

import { prepareDatabaseTarget } from "./database-target.js";

export interface LocalAppConfig {
  readonly databasePath: string;
}

/** Resolves and validates the process environment used by the local TUI. */
export function loadLocalConfig(
  environment: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd()
): LocalAppConfig {
  const databasePath = resolveDatabasePath(environment);
  return { databasePath: prepareDatabaseTarget(databasePath, cwd) };
}

function resolveDatabasePath(environment: NodeJS.ProcessEnv): string {
  if (environment.AGENTLAB_DATABASE_PATH !== undefined) {
    return validateEnvironmentPath(
      "AGENTLAB_DATABASE_PATH",
      environment.AGENTLAB_DATABASE_PATH,
      false
    );
  }

  const homeDirectory = validateEnvironmentPath("HOME", environment.HOME ?? homedir(), true);
  const dataHome =
    environment.XDG_DATA_HOME === undefined
      ? resolve(homeDirectory, ".local", "share")
      : validateEnvironmentPath("XDG_DATA_HOME", environment.XDG_DATA_HOME, true);
  return resolve(dataHome, "agentlab", "agentlab.sqlite");
}

function validateEnvironmentPath(name: string, value: string, requireAbsolute: boolean): string {
  if (value.trim() === "") throw new Error(`${name} cannot be empty.`);
  if (value.includes("\0")) throw new Error(`${name} cannot contain null bytes.`);
  if (Buffer.byteLength(value) > 4_096) throw new Error(`${name} exceeds the 4096-byte limit.`);
  if (requireAbsolute && !isAbsolute(value)) throw new Error(`${name} must be an absolute path.`);
  return value;
}
