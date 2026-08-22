import { describe, expect, it } from "vitest";

import type { CaptainCommandInput } from "../../apps/server/src/domain/captain-launcher.js";
import {
  claudeCaptainLauncher,
  codexCaptainLauncher,
  opencodeCaptainLauncher
} from "../../apps/server/src/infrastructure/providers/captain-launchers.js";
import { TEST_CONVERSATION_ID } from "../helpers/fakes.js";
import { LONG_BEDROCK_MODEL_ID } from "../helpers/model-ids.js";

const input: CaptainCommandInput = {
  executable: "/opt/provider",
  conversationId: TEST_CONVERSATION_ID,
  workspace: "/work/project",
  model: "custom/model",
  reasoning: "high",
  supervisorInstructions: "Only orchestrate",
  userPrompt: "Implement the task"
};

describe("captain launchers", () => {
  it("builds Codex arguments without a shell boundary", () => {
    const command = codexCaptainLauncher.buildCaptainCommand(input);
    expect(command.executable).toBe("/opt/provider");
    expect(command.args).toEqual([
      "--no-alt-screen",
      "--sandbox",
      "workspace-write",
      "--ask-for-approval",
      "on-request",
      "-C",
      "/work/project",
      "-c",
      'developer_instructions="Only orchestrate"',
      "-c",
      "features.multi_agent=false",
      "-c",
      'model_reasoning_effort="high"',
      "-m",
      "custom/model",
      "--",
      "Implement the task"
    ]);
  });

  it("passes a long Bedrock deployment identifier as one literal launcher argument", () => {
    const command = codexCaptainLauncher.buildCaptainCommand({
      ...input,
      model: LONG_BEDROCK_MODEL_ID,
      reasoning: null
    });
    const modelFlag = command.args.indexOf("-m");

    expect(modelFlag).toBeGreaterThanOrEqual(0);
    expect(command.args[modelFlag + 1]).toBe(LONG_BEDROCK_MODEL_ID);
  });

  it("builds Claude arguments with effort and a named session", () => {
    const command = claudeCaptainLauncher.buildCaptainCommand(input);
    expect(command.args).toContain("--ax-screen-reader");
    expect(command.args).toContain("--effort");
    expect(command.args).toContain("high");
    expect(command.args).toContain("captain-11111111");
    expect(command.args).toContain("--append-system-prompt");
    expect(command.args).toContain("Only orchestrate");
    expect(command.args.slice(-2)).toEqual(["--", "Implement the task"]);
  });

  it("starts OpenCode's persistent root TUI with a model and prompt", () => {
    const command = opencodeCaptainLauncher.buildCaptainCommand({ ...input, reasoning: null });
    expect(command.args).toEqual([
      "/work/project",
      "--model",
      "custom/model",
      "--prompt",
      "<captain_instructions>\nOnly orchestrate\n</captain_instructions>\n\n<user_request>\nImplement the task\n</user_request>"
    ]);
    expect(command.args).not.toContain("run");
    expect(command.args).not.toContain("--interactive");
  });

  it("fails closed for unsupported OpenCode startup variants", () => {
    expect(() => opencodeCaptainLauncher.buildCaptainCommand(input)).toThrow(
      "OpenCode does not support selecting a variant"
    );
  });

  it("lets the provider choose its default model and reasoning", () => {
    const command = codexCaptainLauncher.buildCaptainCommand({
      ...input,
      model: null,
      reasoning: null
    });
    expect(command.args).not.toContain("-m");
    expect(command.args.some((argument) => argument.startsWith("model_reasoning_effort="))).toBe(
      false
    );

    const claude = claudeCaptainLauncher.buildCaptainCommand({ ...input, reasoning: null });
    expect(claude.args).not.toContain("--effort");

    const opencode = opencodeCaptainLauncher.buildCaptainCommand({ ...input, reasoning: null });
    expect(opencode.args).not.toContain("--variant");
  });

  it("terminates options before a dash-prefixed task", () => {
    const command = codexCaptainLauncher.buildCaptainCommand({
      ...input,
      userPrompt: "--dangerously-bypass-approvals-and-sandbox"
    });
    expect(command.args.slice(-2)).toEqual(["--", "--dangerously-bypass-approvals-and-sandbox"]);
  });

  it("injects Codex orchestration as native developer instructions", () => {
    const command = codexCaptainLauncher.buildCaptainCommand({
      ...input,
      supervisorInstructions: 'Orchestrate "only"\nand never implement.'
    });
    expect(command.args).toContain(
      'developer_instructions="Orchestrate \\"only\\"\\nand never implement."'
    );
    expect(command.args).toContain("features.multi_agent=false");
  });
});
