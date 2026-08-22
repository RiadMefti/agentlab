import { describe, expect, it } from "vitest";

import type { CaptainCommandInput } from "../../apps/server/src/domain/captain-launcher.js";
import {
  claudeCaptainLauncher,
  codexCaptainLauncher,
  opencodeCaptainLauncher
} from "../../apps/server/src/infrastructure/providers/captain-launchers.js";
import { TEST_CONVERSATION_ID } from "../helpers/fakes.js";

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
      'model_reasoning_effort="high"',
      "-c",
      'developer_instructions="Only orchestrate"',
      "-c",
      "agents.enabled=false",
      "-m",
      "custom/model",
      "--",
      "Implement the task"
    ]);
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

  it("builds OpenCode arguments with model and thinking variant", () => {
    const command = opencodeCaptainLauncher.buildCaptainCommand(input);
    expect(command.args).toEqual([
      "run",
      "--interactive",
      "--dir",
      "/work/project",
      "--variant",
      "high",
      "--model",
      "custom/model",
      "--",
      "<captain_instructions>\nOnly orchestrate\n</captain_instructions>\n\n<user_request>\nImplement the task\n</user_request>"
    ]);
  });

  it("lets the provider choose its default model", () => {
    const command = codexCaptainLauncher.buildCaptainCommand({ ...input, model: null });
    expect(command.args).not.toContain("-m");
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
    expect(command.args).toContain("agents.enabled=false");
  });
});
