import type { CaptainCommandInput, CaptainLauncher } from "../../domain/captain-launcher.js";

const MODEL_SUGGESTIONS: readonly string[] = [];

function promptFrom(input: CaptainCommandInput): string {
  return `<captain_instructions>\n${input.supervisorInstructions}\n</captain_instructions>\n\n<user_request>\n${input.userPrompt}\n</user_request>`;
}

export const codexCaptainLauncher: CaptainLauncher = {
  capability: {
    id: "codex",
    label: "Codex",
    defaultReasoning: "high",
    reasoningLevels: ["minimal", "low", "medium", "high", "xhigh"],
    modelSuggestions: [...MODEL_SUGGESTIONS],
    acceptsCustomModel: true
  },
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
      `model_reasoning_effort=${JSON.stringify(input.reasoning)}`,
      "-c",
      `developer_instructions=${JSON.stringify(input.supervisorInstructions)}`,
      "-c",
      "agents.enabled=false"
    ];
    if (input.model !== null) args.push("-m", input.model);
    args.push("--", input.userPrompt);
    return { executable: input.executable, args };
  }
};

export const claudeCaptainLauncher: CaptainLauncher = {
  capability: {
    id: "claude",
    label: "Claude",
    defaultReasoning: "high",
    reasoningLevels: ["low", "medium", "high", "xhigh", "max"],
    modelSuggestions: [...MODEL_SUGGESTIONS],
    acceptsCustomModel: true
  },
  buildCaptainCommand(input) {
    const args = [
      "--ax-screen-reader",
      "--effort",
      input.reasoning,
      "--name",
      `captain-${input.conversationId.slice(0, 8)}`
    ];
    if (input.model !== null) args.push("--model", input.model);
    args.push("--append-system-prompt", input.supervisorInstructions, "--", input.userPrompt);
    return { executable: input.executable, args };
  }
};

export const opencodeCaptainLauncher: CaptainLauncher = {
  capability: {
    id: "opencode",
    label: "OpenCode",
    defaultReasoning: "high",
    reasoningLevels: ["minimal", "low", "medium", "high", "xhigh", "max"],
    modelSuggestions: [...MODEL_SUGGESTIONS],
    acceptsCustomModel: true
  },
  buildCaptainCommand(input) {
    const args = ["run", "--interactive", "--dir", input.workspace, "--variant", input.reasoning];
    if (input.model !== null) args.push("--model", input.model);
    args.push("--", promptFrom(input));
    return { executable: input.executable, args };
  }
};

export const captainLaunchers = [
  codexCaptainLauncher,
  claudeCaptainLauncher,
  opencodeCaptainLauncher
] as const;
