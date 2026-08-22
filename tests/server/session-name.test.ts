import { describe, expect, it } from "vitest";

import {
  buildCaptainSessionName,
  buildWorkerSessionName,
  parseSessionName,
  sessionLabel,
  workerSlugFromLabel
} from "../../apps/server/src/domain/agent-session-name.js";
import { TEST_CONVERSATION_ID } from "../helpers/fakes.js";

describe("agent session names", () => {
  it("round-trips captain and worker identities", () => {
    const captain = buildCaptainSessionName(TEST_CONVERSATION_ID, "claude");
    const worker = buildWorkerSessionName(TEST_CONVERSATION_ID, "opencode", "auth-tests");

    expect(parseSessionName(captain)).toEqual({
      conversationId: TEST_CONVERSATION_ID,
      role: "captain",
      provider: "claude",
      slug: null
    });
    const parsedWorker = parseSessionName(worker);
    expect(parsedWorker).toEqual({
      conversationId: TEST_CONVERSATION_ID,
      role: "worker",
      provider: "opencode",
      slug: "auth-tests"
    });
    expect(parsedWorker === null ? null : sessionLabel(parsedWorker)).toBe("Auth Tests");
  });

  it("rejects ambiguous and unsafe names", () => {
    expect(parseSessionName("other-session")).toBeNull();
    expect(() => buildWorkerSessionName(TEST_CONVERSATION_ID, "codex", "../../bad")).toThrow(
      /Worker slug/u
    );
  });

  it("normalizes a friendly worker label into the managed session slug", () => {
    expect(workerSlugFromLabel(" Auth Tests ")).toBe("auth-tests");
    expect(() => workerSlugFromLabel("../../bad")).toThrow(/Worker name/u);
  });
});
