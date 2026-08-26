import type {
  AgentLauncher,
  CaptainCommandInput,
  WorkerCommandInput
} from "../../domain/agent-launcher.js";

function openCodeCaptainAgentName(conversationId: string): string {
  return `ao-captain-${conversationId}`;
}

function openCodeCaptainConfiguration(input: CaptainCommandInput): string {
  return JSON.stringify({
    agent: {
      [openCodeCaptainAgentName(input.conversationId)]: {
        description: "AgentLab captain",
        mode: "primary",
        prompt: input.supervisorInstructions
      }
    }
  });
}

export const codexAgentLauncher: AgentLauncher = {
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
    if (input.userPrompt !== null) args.push("--", input.userPrompt);
    return { executable: input.executable, args };
  },
  buildWorkerCommand(input) {
    return {
      executable: input.executable,
      args: [
        "--no-alt-screen",
        "--sandbox",
        "workspace-write",
        "--ask-for-approval",
        "on-request",
        "-C",
        input.workspace,
        "-c",
        "features.multi_agent=false",
        "--",
        input.userPrompt
      ]
    };
  }
};

export const claudeAgentLauncher: AgentLauncher = {
  id: "claude",
  label: "Claude",
  customModelPolicy: "allowed",
  buildCaptainCommand(input) {
    const args = ["--ax-screen-reader"];
    if (input.reasoning !== null) args.push("--effort", input.reasoning);
    args.push("--name", `captain-${input.conversationId.slice(0, 8)}`);
    if (input.model !== null) args.push("--model", input.model);
    args.push("--append-system-prompt", input.supervisorInstructions);
    if (input.userPrompt !== null) args.push("--", input.userPrompt);
    return { executable: input.executable, args };
  },
  buildWorkerCommand(input) {
    return {
      executable: input.executable,
      args: ["--ax-screen-reader", "--name", workerProcessName(input), "--", input.userPrompt]
    };
  }
};

export const opencodeAgentLauncher: AgentLauncher = {
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
    const args = [input.workspace, `--agent=${openCodeCaptainAgentName(input.conversationId)}`];
    if (input.model !== null) args.push(`--model=${input.model}`);
    if (input.userPrompt !== null) args.push(`--prompt=${input.userPrompt}`);
    return {
      executable: input.executable,
      args,
      environment: {
        // OpenCode's inline configuration creates a provider-native primary agent. Its prompt is
        // a system instruction, while --prompt remains a separate user message.
        OPENCODE_CONFIG_CONTENT: openCodeCaptainConfiguration(input)
      }
    };
  },
  buildWorkerCommand(input) {
    return {
      executable: input.executable,
      args: [input.workspace, `--prompt=${input.userPrompt}`]
    };
  }
};

/** All provider-specific command builders available to the neutral catalog. */
export const agentLaunchers = [
  codexAgentLauncher,
  claudeAgentLauncher,
  opencodeAgentLauncher
] as const;

function workerProcessName(input: WorkerCommandInput): string {
  return `worker-${input.conversationId.slice(0, 8)}-${input.workerSlug}`;
}
