import { describe, expect, it, vi } from "vitest";

import {
  AgentLabCommands,
  type ConversationOperations
} from "../../packages/runtime/src/application/agentlab-commands.js";

function service(): ConversationOperations {
  return {
    listConversations: vi.fn().mockResolvedValue([]),
    inspectWorkspace: vi.fn(),
    prepareWorkspace: vi.fn(),
    discoverWorkspaceProviders: vi.fn().mockResolvedValue([]),
    listProviders: vi.fn().mockResolvedValue([]),
    createConversation: vi.fn(),
    deleteConversation: vi.fn().mockResolvedValue(undefined),
    listSessions: vi.fn().mockResolvedValue([]),
    createWorker: vi.fn(),
    deleteWorker: vi.fn().mockResolvedValue(undefined),
    requireAttachableSession: vi.fn().mockResolvedValue("/work/project")
  };
}

const folders = { complete: vi.fn().mockResolvedValue([]) };

describe("AgentLabCommands", () => {
  it("validates create-conversation input before invoking domain behavior", async () => {
    const conversations = service();
    const commands = new AgentLabCommands(conversations, folders);

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
    const commands = new AgentLabCommands(conversations, folders);

    expect(() => commands.inspectWorkspace("\0unsafe")).toThrow();
    expect(conversations.inspectWorkspace).not.toHaveBeenCalled();
    expect(() => commands.prepareWorkspace("\0unsafe")).toThrow();
    expect(() => commands.discoverWorkspaceProviders("\0unsafe")).toThrow();
  });

  it("validates bounded folder completion input and output", async () => {
    const conversations = service();
    const complete = vi
      .fn()
      .mockResolvedValue([{ value: "project folder/", label: "project folder/", symlink: false }]);
    const commands = new AgentLabCommands(conversations, { complete });

    await expect(commands.completeFolders({ path: "project ", limit: 6 })).resolves.toHaveLength(1);
    expect(complete).toHaveBeenCalledWith({ path: "project ", limit: 6 });
    await expect(commands.completeFolders({ path: "\0", limit: 6 })).rejects.toThrow();
    await expect(commands.completeFolders({ path: "x", limit: 7 })).rejects.toThrow();
  });

  it("normalizes optional model and reasoning selections", async () => {
    const conversations = service();
    vi.mocked(conversations.createConversation).mockResolvedValue({} as never);
    const commands = new AgentLabCommands(conversations, folders);

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
    const commands = new AgentLabCommands(conversations, folders);
    const conversationId = "11111111-1111-4111-8111-111111111111";

    await expect(commands.requireAttachableSession(conversationId, "user-shell")).rejects.toThrow(
      "Invalid managed session name"
    );
    expect(conversations.requireAttachableSession).not.toHaveBeenCalled();
  });
});
