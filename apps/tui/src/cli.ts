export type CliAction =
  { readonly kind: "help" } | { readonly kind: "version" } | { readonly kind: "run" };

export function parseCliArguments(input: readonly string[]): CliAction {
  if (input.length === 0) return { kind: "run" };
  if (input.length === 1) {
    const value = input[0];
    if (value === "--help" || value === "-h") return { kind: "help" };
    if (value === "--version" || value === "-v") return { kind: "version" };
  }
  throw new Error("Usage: orchestrator");
}

export function assertSupportedTerminalRuntime(
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv
): void {
  if (platform === "linux" && environment.OPENTUI_LIBC === "musl") {
    throw new Error("This Linux executable requires glibc; musl is not supported.");
  }
}

export const helpText = `orchestrator

Open the local terminal UI, then choose or add a project folder.

Environment:
  AO_DATABASE_PATH   Override the local SQLite database path
  AO_CODEX_BIN       Override the Codex executable
  AO_CLAUDE_BIN      Override the Claude executable
  AO_OPENCODE_BIN    Override the OpenCode executable

Keys:
  Alt+1 / Alt+2 / Alt+3        Focus projects / terminal / agents
  Alt+N / Alt+W                New project / worker
  Delete                       Remove the selected project or worker
  Alt+C                        Copy terminal selection via OSC 52
  Alt+Q                        Quit
`;
