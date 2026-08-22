import { mkdirSync, realpathSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";

const DEFAULT_PORT = 4321;

export interface AppConfig {
  readonly host: "127.0.0.1";
  readonly port: number;
  readonly databasePath: string;
  readonly workspace: string;
}

export function loadConfig(
  environment: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd()
): AppConfig {
  const port = parsePort(environment.AO_PORT);
  const workspace = realpathSync(resolve(cwd, environment.AO_WORKSPACE ?? "."));
  if (!statSync(workspace).isDirectory()) {
    throw new Error("AO_WORKSPACE must resolve to a directory.");
  }
  const databasePath = resolve(cwd, environment.AO_DATABASE_PATH ?? ".data/orchestrator.sqlite");
  mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });

  return {
    host: "127.0.0.1",
    port,
    databasePath,
    workspace
  };
}

function parsePort(value: string | undefined): number {
  if (value === undefined) return DEFAULT_PORT;
  const port = Number(value);
  if (!Number.isInteger(port) || (port !== 0 && port < 1_024) || port > 65_535) {
    throw new Error("AO_PORT must be 0 or an integer between 1024 and 65535.");
  }
  return port;
}
