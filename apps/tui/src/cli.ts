import { isAbsolute, resolve } from "node:path";

export type CliAction =
  | { readonly kind: "help" }
  | { readonly kind: "version" }
  | { readonly kind: "run" }
  | { readonly kind: "factory-broker-preflight"; readonly configPath: string };

export function parseCliArguments(input: readonly string[]): CliAction {
  if (input.length === 0) return { kind: "run" };
  if (input.length === 1) {
    const value = input[0];
    if (value === "--help" || value === "-h") return { kind: "help" };
    if (value === "--version" || value === "-v") return { kind: "version" };
  }
  if (
    input.length === 4 &&
    input[0] === "factory" &&
    input[1] === "broker-preflight" &&
    input[2] === "--config"
  ) {
    const configPath = input[3];
    if (
      configPath !== undefined &&
      isAbsolute(configPath) &&
      !configPath.includes("\0") &&
      Buffer.byteLength(configPath) <= 4_096 &&
      resolve(configPath) === configPath
    ) {
      return { kind: "factory-broker-preflight", configPath };
    }
  }
  throw new Error("Usage: agentlab [factory broker-preflight --config <absolute-path>]");
}

export function assertSupportedTerminalRuntime(
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv
): void {
  if (platform === "linux" && environment.OPENTUI_LIBC === "musl") {
    throw new Error("This Linux executable requires glibc; musl is not supported.");
  }
}

export const helpText = `agentlab

Open the local terminal UI, then choose or add a project folder.

Factory authority:
  agentlab factory broker-preflight --config <absolute-path>
      Read configuration and report broker/governance readiness without changing GitHub.

Environment:
  AGENTLAB_DATABASE_PATH   Override the local SQLite database path
  AGENTLAB_CODEX_BIN       Override the Codex executable
  AGENTLAB_CLAUDE_BIN      Override the Claude executable
  AGENTLAB_OPENCODE_BIN    Override the OpenCode executable
  AGENTLAB_DISABLE_MOUSE   Set to 1 to keep mouse input local to AgentLab

Keys:
  Alt+1 / Alt+2 / Alt+3        Focus projects / terminal / agents
  Alt+N / Alt+W                New project / worker
  Delete                       Remove the selected project or worker
  Alt+C                        Copy terminal selection via OSC 52
  Alt+Q                        Quit
`;
