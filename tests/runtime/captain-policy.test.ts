import { describe, expect, it } from "vitest";

import { TmuxCaptainPolicyRenderer } from "../../packages/runtime/src/infrastructure/tmux/captain-policy.js";
import { TEST_CONVERSATION_ID } from "../helpers/fakes.js";

const TEST_NONCE = "22222222-2222-4222-8222-222222222222";

describe("TmuxCaptainPolicyRenderer", () => {
  it("keeps orchestration and exact managed-session rules explicit", () => {
    const policy = render("/work/project", "/opt/claude");

    expect(policy.instructions).toContain("Your only job is orchestration");
    expect(policy.instructions).toContain("Never implement");
    expect(policy.instructions).toContain("real CLI processes in tmux");
    expect(policy.instructions).toContain("not built-in subagents");
    expect(policy.instructions).toContain("tmux respawn-pane -k");
    expect(policy.instructions).toContain(
      `agentlab__${TEST_CONVERSATION_ID}__worker__<provider>__<slug>`
    );
    expect(policy.instructions).toContain(
      '-e AGENTLAB_SESSION_OWNERSHIP="$AGENTLAB_SESSION_OWNERSHIP"'
    );
  });

  it("places raw paths and ownership only in fixed environment values", () => {
    const workspace = "/work/$(touch should-not-run) ' quoted";
    const executable = "/opt/bin/claude`unsafe` ' path";
    const policy = render(workspace, executable);

    expect(policy.instructions).not.toContain(workspace);
    expect(policy.instructions).not.toContain(executable);
    expect(policy.instructions).not.toContain(TEST_NONCE);
    expect(policy.instructions).toContain('"$AGENTLAB_WORKSPACE"');
    expect(policy.instructions).toContain('"$AGENTLAB_CLAUDE_BIN"');
    expect(policy.environment).toMatchObject({
      AGENTLAB_WORKSPACE: workspace,
      AGENTLAB_CLAUDE_BIN: executable,
      AGENTLAB_SESSION_OWNERSHIP: TEST_NONCE
    });
  });

  it("retains the captain-owned process and worker cleanup lifecycle contract", () => {
    const { instructions } = render("/work/project", "/opt/claude");

    expect(instructions).toContain("only to supervisory or verification commands");
    expect(instructions).toContain("keep the same turn open");
    expect(instructions).toContain("Do not issue a final response");
    expect(instructions).toContain("A worker session is a temporary lease");
    expect(instructions).toContain("Never infer completion from silence");
    expect(instructions).toContain("Never use kill-server or kill-session -a");
    expect(instructions).toContain('same value in "$AGENTLAB_SESSION_OWNERSHIP"');
    expect(instructions).toContain("The captain session must remain alive after cleanup");
  });
});

function render(workspace: string, claudeExecutable: string) {
  return new TmuxCaptainPolicyRenderer().render({
    conversationId: TEST_CONVERSATION_ID,
    workspace,
    ownershipNonce: TEST_NONCE,
    providerExecutables: { claude: claudeExecutable }
  });
}
