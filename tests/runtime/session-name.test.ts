import { describe, expect, it } from "vitest";

import { providerIdSchema } from "@agentlab/contracts";

import {
  assertCaptainSessionOwnership,
  buildCaptainSessionName,
  buildWorkerSessionName,
  parseSessionName,
  sessionLabel,
  workerSlugFromLabel
} from "../../packages/runtime/src/domain/agent-session-name.js";
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

  it("round-trips every provider declared by the shared contract", () => {
    for (const provider of providerIdSchema.options) {
      expect(
        parseSessionName(buildCaptainSessionName(TEST_CONVERSATION_ID, provider))
      ).toMatchObject({ provider });
      expect(
        parseSessionName(buildWorkerSessionName(TEST_CONVERSATION_ID, provider, "review"))
      ).toMatchObject({ provider });
    }
  });

  it("rejects ambiguous and unsafe names", () => {
    expect(parseSessionName("other-session")).toBeNull();
    expect(() => buildWorkerSessionName(TEST_CONVERSATION_ID, "codex", "../../bad")).toThrow(
      /Worker slug/u
    );
  });

  it("binds a persisted captain to its exact conversation, role, and provider", () => {
    expect(() => {
      assertCaptainSessionOwnership(
        buildCaptainSessionName(TEST_CONVERSATION_ID, "codex"),
        TEST_CONVERSATION_ID,
        "codex"
      );
    }).not.toThrow();

    expect(() => {
      assertCaptainSessionOwnership(
        buildCaptainSessionName("22222222-2222-4222-8222-222222222222", "codex"),
        TEST_CONVERSATION_ID,
        "codex"
      );
    }).toThrow(/does not match/u);
    expect(() => {
      assertCaptainSessionOwnership(
        buildCaptainSessionName(TEST_CONVERSATION_ID, "claude"),
        TEST_CONVERSATION_ID,
        "codex"
      );
    }).toThrow(/does not match/u);
    expect(() => {
      assertCaptainSessionOwnership(
        buildWorkerSessionName(TEST_CONVERSATION_ID, "codex", "not-a-captain"),
        TEST_CONVERSATION_ID,
        "codex"
      );
    }).toThrow(/does not match/u);
  });

  it("normalizes a friendly worker label into the managed session slug", () => {
    expect(workerSlugFromLabel(" Auth Tests ")).toBe("auth-tests");
    expect(() => workerSlugFromLabel("../../bad")).toThrow(/Worker name/u);
  });
});
