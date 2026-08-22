import type { CaptainCommandInput, CaptainLauncher } from "../../domain/captain-launcher.js";

function promptFrom(input: CaptainCommandInput): string {
  return `<captain_instructions>\n${input.supervisorInstructions}\n</captain_instructions>\n\n<user_request>\n${input.userPrompt}\n</user_request>`;
}

export const codexCaptainLauncher: CaptainLauncher = {
  id: "codex",
  label: "Codex",
  customModelPolicy: "allowed",
  buildCaptainCommand(input) {
    const args = [
      "--no-alt-screen",
      "--sandbox",
      "workspace-write",
      "--ask-for-approval",
      "on-request",
      "-C",
      input.workspace,
      "-c",
      `developer_instructions=${JSON.stringify(input.supervisorInstructions)}`,
      "-c",
      "features.multi_agent=false"
    ];
    if (input.reasoning !== null) {
      args.push("-c", `model_reasoning_effort=${JSON.stringify(input.reasoning)}`);
    }
    if (input.model !== null) args.push("-m", input.model);
    args.push("--", input.userPrompt);
    return { executable: input.executable, args };
  }
};

export const claudeCaptainLauncher: CaptainLauncher = {
  id: "claude",
  label: "Claude",
  customModelPolicy: "allowed",
  buildCaptainCommand(input) {
    const args = ["--ax-screen-reader"];
    if (input.reasoning !== null) args.push("--effort", input.reasoning);
    args.push("--name", `captain-${input.conversationId.slice(0, 8)}`);
    if (input.model !== null) args.push("--model", input.model);
    args.push("--append-system-prompt", input.supervisorInstructions, "--", input.userPrompt);
    return { executable: input.executable, args };
  }
};

export const opencodeCaptainLauncher: CaptainLauncher = {
  id: "opencode",
  label: "OpenCode",
  customModelPolicy: "catalog-only",
  buildCaptainCommand(input) {
    // OpenCode 1.18.21 parses `run --interactive` but does not use it; `run` still exits when
    // the first response becomes idle. The supported root command is the persistent TUI.
    // It has no startup variant option, so fail closed if validation is ever bypassed.
    if (input.reasoning !== null) {
      throw new Error(
        "OpenCode does not support selecting a variant when starting its persistent TUI."
      );
    }
    const args = [input.workspace];
    if (input.model !== null) args.push("--model", input.model);
    args.push("--prompt", promptFrom(input));
    return { executable: input.executable, args };
  }
};

export const captainLaunchers = [
  codexCaptainLauncher,
  claudeCaptainLauncher,
  opencodeCaptainLauncher
] as const;
