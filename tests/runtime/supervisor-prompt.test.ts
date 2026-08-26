import { describe, expect, it } from "vitest";

import { buildSupervisorInstructions } from "../../packages/runtime/src/application/supervisor-prompt.js";
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

  it("gives the captain a safe, conversation-scoped worker cleanup contract", () => {
    const instructions = buildSupervisorInstructions(context);
    const workerPrefix = `ao__${TEST_CONVERSATION_ID}__worker__`;

    expect(instructions).toContain("A worker session is a temporary lease for one assignment");
    expect(instructions).toContain(
      "Never infer completion from silence, elapsed time, or low activity"
    );
    expect(instructions).toContain(
      "Never interrupt an assignment that is still relevant and running"
    );
    expect(instructions).toContain(
      "A stopped or failed worker and a worker blocked on user or external input"
    );
    expect(instructions).toContain(
      "Cancellation, supersession, or abandonment also makes a worker eligible"
    );
    expect(instructions).toContain("capture a terminal outcome");
    expect(instructions).toContain(`exact worker names that you launched under ${workerPrefix}`);
    expect(instructions).toContain(
      "tmux if-shell -F -t =<name>: '#{==:#{session_attached},0}' 'kill-session -t =<name>' ''"
    );
    expect(instructions).toContain("Never target the captain, another project");
    expect(instructions).toContain("Never use kill-server or kill-session -a");
    expect(instructions).toContain("Never remove a worker while a user is attached");
    expect(instructions).toContain("leave it pending and retry on the next orchestration turn");
    expect(instructions).toContain("cleanup retries are idempotent");
    expect(instructions).toContain("The captain session must remain alive after cleanup");
  });

  it("keeps the captain turn open only for captain-owned supervisory processes", () => {
    const instructions = buildSupervisorInstructions(context);

    expect(instructions).toContain("only to supervisory or verification commands");
    expect(instructions).toContain(
      "never authorizes delegated code work outside a managed worker session"
    );
    expect(instructions).toContain("delegated work must still run in workers");
    expect(instructions).toContain("A captain-owned supervisory or verification process");
    expect(instructions).toContain("keep the same turn open");
    expect(instructions).toContain("state the action still required");
    expect(instructions).toContain("remind the user at a low frequency what action remains");
    expect(instructions).toContain(
      "continuing to monitor workers, reconcile terminal outcomes, and perform eligible cleanup"
    );
    expect(instructions).toContain(
      "Do not issue a final response while such a process is still relevant and running"
    );
    expect(instructions).toContain(
      "Do not assume that later output or process exit will start a new captain turn"
    );
    expect(instructions).toContain("collect and incorporate the process output and exit status");
  });
});
