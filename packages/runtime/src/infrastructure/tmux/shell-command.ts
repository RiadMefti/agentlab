import type { CommandSpec } from "../../domain/command.js";

const SAFE_SHELL_TOKEN = /^[A-Za-z0-9_@%+=:,./-]+$/u;
const ENVIRONMENT_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/u;

export function quotePosix(value: string): string {
  if (value === "") return "''";
  if (SAFE_SHELL_TOKEN.test(value)) return value;
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

/** Quotes a trusted command spec for tmux's unavoidable shell command slot. */
export function renderShellCommand(command: CommandSpec): string {
  const environment = Object.entries(command.environment ?? {}).map(([key, value]) => {
    if (!ENVIRONMENT_KEY.test(key)) {
      throw new Error(`Invalid environment key: ${key}`);
    }
    return `${key}=${quotePosix(value)}`;
  });
  return [...environment, quotePosix(command.executable), ...command.args.map(quotePosix)].join(
    " "
  );
}
