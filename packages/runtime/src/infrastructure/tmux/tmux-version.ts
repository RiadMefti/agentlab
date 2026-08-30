import { execFileSync } from "node:child_process";

export const minimumTmuxVersion = "3.2";

export interface ParsedTmuxVersion {
  readonly major: number;
  readonly minor: number;
}

/** Fails before durable runtime construction when tmux cannot honor atomic session environments. */
export function assertSupportedTmuxVersion(
  readVersion: () => string = readInstalledTmuxVersion
): ParsedTmuxVersion {
  let output: string;
  try {
    output = readVersion().trim();
  } catch (cause: unknown) {
    throw new Error(
      `AgentLab requires tmux ${minimumTmuxVersion} or newer, but tmux -V could not run.`,
      { cause }
    );
  }
  const match = /^tmux\s+(?:next-)?(\d+)\.(\d+)(?:[a-z]|[-.].*)?$/iu.exec(output);
  const major = match?.[1] === undefined ? Number.NaN : Number(match[1]);
  const minor = match?.[2] === undefined ? Number.NaN : Number(match[2]);
  if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor)) {
    throw new Error(`Unable to parse the installed tmux version: ${output || "empty output"}.`);
  }
  if (major < 3 || (major === 3 && minor < 2)) {
    throw new Error(
      `AgentLab requires tmux ${minimumTmuxVersion} or newer; found ${String(major)}.${String(minor)}.`
    );
  }
  return { major, minor };
}

function readInstalledTmuxVersion(): string {
  return execFileSync("tmux", ["-V"], {
    encoding: "utf8",
    maxBuffer: 32 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 3_000
  });
}
