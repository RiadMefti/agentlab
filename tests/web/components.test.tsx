// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { AgentSession, Conversation, ProviderCapability } from "@orchestrator/contracts";

import { AgentTabs } from "../../apps/web/src/components/AgentTabs.js";
import { ConversationReel } from "../../apps/web/src/components/ConversationReel.js";
import { NewConversationDialog } from "../../apps/web/src/components/NewConversationDialog.js";
import { TEST_CONVERSATION_ID } from "../helpers/fakes.js";

const captain: AgentSession = {
  name: `ao__${TEST_CONVERSATION_ID}__captain__codex`,
  conversationId: TEST_CONVERSATION_ID,
  role: "captain",
  provider: "codex",
  label: "Captain",
  status: "running",
  attached: false,
  startedAt: "2026-08-21T12:00:00.000Z"
};

const worker: AgentSession = {
  ...captain,
  name: `ao__${TEST_CONVERSATION_ID}__worker__claude__auth-tests`,
  role: "worker",
  provider: "claude",
  label: "Auth Tests"
};

const provider: ProviderCapability = {
  id: "codex",
  label: "Codex",
  available: true,
  version: "test",
  reason: null,
  defaultReasoning: "high",
  reasoningLevels: ["low", "high", "xhigh"],
  modelSuggestions: ["gpt-test"],
  acceptsCustomModel: true
};

describe("lean interface components", () => {
  it("switches directly between captain and worker tabs", () => {
    const onSelect = vi.fn();
    render(
      <AgentTabs sessions={[captain, worker]} selectedName={captain.name} onSelect={onSelect} />
    );

    expect(screen.getByRole("button", { name: "Captain" })).toHaveAttribute("aria-current", "page");
    fireEvent.click(screen.getByRole("button", { name: "Auth Tests" }));
    expect(onSelect).toHaveBeenCalledWith(worker.name);
  });

  it("selects a saved conversation from the Reel", () => {
    const conversation: Conversation = {
      id: TEST_CONVERSATION_ID,
      title: "Refresh race",
      provider: "codex",
      model: null,
      reasoning: "high",
      captainSessionName: captain.name,
      createdAt: "2026-08-21T12:00:00.000Z",
      updatedAt: "2026-08-21T12:00:00.000Z"
    };
    const onSelect = vi.fn();
    render(
      <ConversationReel conversations={[conversation]} selectedId={null} onSelect={onSelect} />
    );

    fireEvent.click(screen.getByRole("button", { name: /Refresh race/u }));
    expect(onSelect).toHaveBeenCalledWith(TEST_CONVERSATION_ID);
  });

  it("submits provider, model, thinking, and task together", () => {
    const onCreate = vi.fn();
    render(
      <NewConversationDialog
        providers={[provider]}
        pending={false}
        error={null}
        onCancel={vi.fn()}
        onCreate={onCreate}
      />
    );

    fireEvent.change(screen.getByLabelText("Task"), {
      target: { value: "Coordinate the refresh fix" }
    });
    fireEvent.change(screen.getByLabelText("Model"), {
      target: { value: "gpt-test" }
    });
    fireEvent.change(screen.getByLabelText("Thinking"), {
      target: { value: "xhigh" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Start" }));

    expect(onCreate).toHaveBeenCalledWith({
      prompt: "Coordinate the refresh fix",
      provider: "codex",
      model: "gpt-test",
      reasoning: "xhigh"
    });
  });
});
