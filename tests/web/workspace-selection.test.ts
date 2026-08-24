import { describe, expect, it } from "vitest";

import type { AgentSession, Conversation } from "@orchestrator/contracts";

import {
  initialWorkspaceSelection,
  removeConversation,
  resolveSession,
  selectConversation,
  selectSession
} from "../../apps/web/src/workspace-selection.js";
import { TEST_CONVERSATION_ID } from "../helpers/fakes.js";

const secondConversationId = "7a23b1ce-672d-4f7a-a566-e94f4cd142a5";

function conversation(id: string, provider: "codex" | "claude"): Conversation {
  return {
    id,
    title: `${provider} work`,
    provider,
    model: null,
    reasoning: null,
    captainSessionName: `ao__${id}__captain__${provider}`,
    createdAt: "2026-08-21T12:00:00.000Z",
    updatedAt: "2026-08-21T12:00:00.000Z"
  };
}

function session(
  owner: Conversation,
  role: "captain" | "worker",
  name = owner.captainSessionName
): AgentSession {
  return {
    name,
    conversationId: owner.id,
    role,
    provider: owner.provider,
    label: role === "captain" ? "Captain" : "Tests",
    status: "running",
    attached: false,
    startedAt: "2026-08-21T12:00:00.000Z"
  };
}

describe("workspace selection", () => {
  it("remembers one selected agent per conversation across switches", () => {
    const first = conversation(TEST_CONVERSATION_ID, "codex");
    const second = conversation(secondConversationId, "claude");
    const workerName = `ao__${first.id}__worker__codex__tests`;

    const firstSelected = selectConversation(initialWorkspaceSelection, first);
    const workerSelected = selectSession(firstSelected, first.id, workerName);
    const secondSelected = selectConversation(workerSelected, second);
    const returned = selectConversation(secondSelected, first);

    expect(returned).toEqual({
      conversationId: first.id,
      sessionNames: {
        [first.id]: workerName,
        [second.id]: second.captainSessionName
      }
    });
  });

  it("falls back to the captain when a remembered worker no longer exists", () => {
    const owner = conversation(TEST_CONVERSATION_ID, "codex");
    const captain = session(owner, "captain");

    expect(resolveSession([captain], "missing-worker")).toBe(captain);
  });

  it("forgets deleted conversation state and selects the next captain", () => {
    const first = conversation(TEST_CONVERSATION_ID, "codex");
    const second = conversation(secondConversationId, "claude");
    const selected = selectConversation(
      selectConversation(initialWorkspaceSelection, first),
      second
    );

    expect(removeConversation(selected, second.id, first)).toEqual({
      conversationId: first.id,
      sessionNames: { [first.id]: first.captainSessionName }
    });
  });
});
