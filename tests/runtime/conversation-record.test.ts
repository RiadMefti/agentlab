import { describe, expect, it } from "vitest";

import { buildCaptainSessionName } from "../../packages/runtime/src/domain/agent-session-name.js";
import { storedConversationSchema } from "../../packages/runtime/src/domain/conversation-record.js";
import { TEST_CONVERSATION_ID } from "../helpers/fakes.js";

const base = {
  id: TEST_CONVERSATION_ID,
  title: "Durable project",
  workspacePath: "/work/project",
  provider: "codex" as const,
  model: null,
  reasoning: null,
  captainSessionName: buildCaptainSessionName(TEST_CONVERSATION_ID, "codex"),
  createdAt: "2026-08-29T12:00:00.000Z",
  updatedAt: "2026-08-29T12:00:00.000Z",
  ownershipMode: "legacy-name" as const,
  ownershipNonce: null
};

describe("stored conversation invariants", () => {
  it("requires a workspace for creating and active records", () => {
    expect(
      storedConversationSchema.safeParse({
        ...base,
        lifecycleState: "active",
        workspacePath: null
      }).success
    ).toBe(false);
  });

  it("reserves null workspaces for the explicit legacy-unlinked state", () => {
    expect(
      storedConversationSchema.safeParse({
        ...base,
        lifecycleState: "legacy-unlinked"
      }).success
    ).toBe(false);
    expect(
      storedConversationSchema.safeParse({
        ...base,
        lifecycleState: "legacy-unlinked",
        workspacePath: null
      }).success
    ).toBe(true);
  });

  it("allows deleting to retain either historical workspace shape", () => {
    expect(
      storedConversationSchema.safeParse({
        ...base,
        lifecycleState: "deleting",
        workspacePath: null
      }).success
    ).toBe(true);
  });
});
