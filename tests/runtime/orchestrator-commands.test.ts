import { describe, expect, it, vi } from "vitest";

import {
  OrchestratorCommands,
  type ConversationOperations
} from "../../packages/runtime/src/application/orchestrator-commands.js";

function service(): ConversationOperations {
  return {
    listConversations: vi.fn().mockResolvedValue([]),
    inspectWorkspace: vi.fn(),
    listProviders: vi.fn().mockResolvedValue([]),
    createConversation: vi.fn(),
    deleteConversation: vi.fn().mockResolvedValue(undefined),
    listSessions: vi.fn().mockResolvedValue([]),
    createWorker: vi.fn(),
    deleteWorker: vi.fn().mockResolvedValue(undefined),
    requireAttachableSession: vi.fn().mockResolvedValue("/work/project")
  };
}

describe("OrchestratorCommands", () => {
  it("validates create-conversation input before invoking domain behavior", async () => {
    const conversations = service();
    const commands = new OrchestratorCommands(conversations);

    await expect(
      commands.createConversation({
        title: "Project",
        workspacePath: "/work/project",
        provider: "codex",
        prompt: "\0unsafe"
      })
    ).rejects.toThrow();
    expect(conversations.createConversation).not.toHaveBeenCalled();
  });

  it("validates selected folder paths before filesystem inspection", () => {
    const conversations = service();
    const commands = new OrchestratorCommands(conversations);

    expect(() => commands.inspectWorkspace("\0unsafe")).toThrow();
    expect(conversations.inspectWorkspace).not.toHaveBeenCalled();
  });

  it("normalizes optional model and reasoning selections", async () => {
    const conversations = service();
    vi.mocked(conversations.createConversation).mockResolvedValue({} as never);
    const commands = new OrchestratorCommands(conversations);

    await commands.createConversation({
      title: "Project",
      workspacePath: "/work/project",
      provider: "codex",
      prompt: "ship it"
    });

    expect(conversations.createConversation).toHaveBeenCalledWith({
      model: null,
      prompt: "ship it",
      provider: "codex",
      reasoning: null,
      title: "Project",
      workspacePath: "/work/project"
    });
  });

  it("rejects unmanaged terminal targets", async () => {
    const conversations = service();
    const commands = new OrchestratorCommands(conversations);
    const conversationId = "11111111-1111-4111-8111-111111111111";

    await expect(commands.requireAttachableSession(conversationId, "user-shell")).rejects.toThrow(
      "Invalid managed session name"
    );
    expect(conversations.requireAttachableSession).not.toHaveBeenCalled();
  });
});
