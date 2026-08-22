import { describe, expect, it } from "vitest";

import { buildSupervisorInstructions } from "../../apps/server/src/application/supervisor-prompt.js";
import { TEST_CONVERSATION_ID } from "../helpers/fakes.js";

describe("supervisor instructions", () => {
  const context = {
    conversationId: TEST_CONVERSATION_ID,
    workspace: "/work/project",
    providerExecutables: {
      codex: "/opt/codex",
      claude: "/opt/claude"
    }
  } as const;

  it("makes orchestration and real sessions non-negotiable", () => {
    const instructions = buildSupervisorInstructions(context);

    expect(instructions).toContain("Your only job is orchestration");
    expect(instructions).toContain("Never implement");
    expect(instructions).toContain("real CLI processes in tmux");
    expect(instructions).toContain("not built-in subagents");
    expect(instructions).toContain("tmux respawn-pane -k");
    expect(instructions).toContain(`ao__${TEST_CONVERSATION_ID}__worker__<provider>__<slug>`);
    expect(instructions).toContain("/opt/claude");
  });
});
