// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { AgentSession, Conversation, ProviderCapability } from "@orchestrator/contracts";

import { AgentTabs } from "../../apps/web/src/components/AgentTabs.js";
import { AppearancePicker } from "../../apps/web/src/components/AppearancePicker.js";
import { ConversationReel } from "../../apps/web/src/components/ConversationReel.js";
import { DeleteWorkerDialog } from "../../apps/web/src/components/DeleteWorkerDialog.js";
import { NewConversationDialog } from "../../apps/web/src/components/NewConversationDialog.js";
import { NewWorkerDialog } from "../../apps/web/src/components/NewWorkerDialog.js";
import { ThemeProvider } from "../../apps/web/src/theme/react-theme.js";
import { ThemeStore } from "../../apps/web/src/theme/theme-store.js";
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
  source: "live",
  discoveredAt: "2026-08-21T12:00:00.000Z",
  defaultModel: "default-model",
  models: ["default-model", "gpt-test"].map((id) => ({
    id,
    label: id === "gpt-test" ? "GPT Test" : "Default Model",
    description: null,
    defaultReasoning: "high",
    reasoningOptions: ["low", "high", "xhigh"].map((level) => ({
      id: level,
      label: level === "xhigh" ? "Extra high" : `${level.charAt(0).toUpperCase()}${level.slice(1)}`
    }))
  })),
  customModelPolicy: "allowed"
};

describe("lean interface components", () => {
  it("switches directly between captain and worker tabs", () => {
    const onSelect = vi.fn();
    render(
      <AgentTabs
        sessions={[captain, worker]}
        selectedName={captain.name}
        canCreate={true}
        onSelect={onSelect}
        onCreate={vi.fn()}
        onDelete={vi.fn()}
      />
    );

    expect(screen.getByRole("button", { name: "Captain" })).toHaveAttribute("aria-current", "page");
    fireEvent.click(screen.getByRole("button", { name: "Auth Tests" }));
    expect(onSelect).toHaveBeenCalledWith(worker.name);
  });

  it("keeps worker lifecycle controls quiet and never offers to delete the Captain", () => {
    const onCreate = vi.fn();
    const onDelete = vi.fn();
    const view = render(
      <AgentTabs
        sessions={[captain, worker]}
        selectedName={worker.name}
        canCreate={true}
        onSelect={vi.fn()}
        onCreate={onCreate}
        onDelete={onDelete}
      />
    );
    const tabs = within(view.container);

    fireEvent.click(tabs.getByRole("button", { name: "New agent" }));
    fireEvent.click(tabs.getByRole("button", { name: "Delete Auth Tests" }));
    expect(onCreate).toHaveBeenCalledOnce();
    expect(onDelete).toHaveBeenCalledWith(worker);

    view.rerender(
      <AgentTabs
        sessions={[captain, worker]}
        selectedName={captain.name}
        canCreate={true}
        onSelect={vi.fn()}
        onCreate={onCreate}
        onDelete={onDelete}
      />
    );
    expect(tabs.queryByRole("button", { name: /Delete/u })).not.toBeInTheDocument();
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

  it("offers only the accessible built-in appearance choices and persists a selection", () => {
    const storage = {
      value: "system",
      read() {
        return this.value;
      },
      write(appearance: "system" | "light" | "dark") {
        this.value = appearance;
      }
    };
    const store = new ThemeStore(storage, {
      getTheme: () => "light",
      subscribe: () => () => undefined
    });
    render(
      <ThemeProvider store={store}>
        <AppearancePicker />
      </ThemeProvider>
    );

    const picker = screen.getByRole("combobox", { name: "Appearance" });
    expect(picker).toHaveValue("system");
    expect(
      within(picker)
        .getAllByRole("option")
        .map((option) => option.textContent)
    ).toEqual(["System", "Light", "Dark"]);

    fireEvent.change(picker, { target: { value: "dark" } });
    expect(picker).toHaveValue("dark");
    expect(storage.value).toBe("dark");
  });

  it("submits provider defaults as nullable selections", () => {
    const onCreate = vi.fn();
    const view = render(
      <NewConversationDialog
        providers={[provider]}
        pending={false}
        error={null}
        onCancel={vi.fn()}
        onCreate={onCreate}
      />
    );
    const dialog = within(view.container);

    expect(
      within(dialog.getByLabelText("Model"))
        .getAllByRole("option")
        .map((option) => option.textContent)
    ).toEqual(["Default Model · default", "GPT Test", "Custom model…"]);
    expect(
      within(dialog.getByLabelText("Thinking"))
        .getAllByRole("option")
        .map((option) => option.textContent)
    ).toEqual(["High · default", "Low", "Extra high"]);

    fireEvent.change(dialog.getByLabelText("Task"), { target: { value: "Use defaults" } });
    fireEvent.click(dialog.getByRole("button", { name: "Start" }));

    expect(onCreate).toHaveBeenCalledWith({
      prompt: "Use defaults",
      provider: "codex",
      model: null,
      reasoning: null
    });
  });

  it("disables thinking when the selected model has no launch-time control", () => {
    const noThinkingProvider: ProviderCapability = {
      ...provider,
      id: "opencode",
      label: "OpenCode",
      defaultModel: null,
      models: [
        {
          id: "opencode/model",
          label: "OpenCode Model",
          description: null,
          defaultReasoning: null,
          reasoningOptions: []
        }
      ],
      customModelPolicy: "catalog-only"
    };
    const view = render(
      <NewConversationDialog
        providers={[noThinkingProvider]}
        pending={false}
        error={null}
        onCancel={vi.fn()}
        onCreate={vi.fn()}
      />
    );
    const dialog = within(view.container);

    fireEvent.change(dialog.getByLabelText("Model"), { target: { value: "opencode/model" } });

    expect(dialog.getByLabelText("Thinking")).toBeDisabled();
    expect(dialog.getByRole("option", { name: "In OpenCode" })).toBeInTheDocument();
  });

  it("explains fallback discovery and gates custom model entry behind policy", () => {
    const onCreate = vi.fn();
    const view = render(
      <NewConversationDialog
        providers={[
          {
            ...provider,
            source: "fallback",
            reason: "Model discovery failed: timed out",
            discoveredAt: null,
            defaultModel: null,
            models: []
          }
        ]}
        pending={false}
        error={null}
        onCancel={vi.fn()}
        onCreate={onCreate}
      />
    );
    const dialog = within(view.container);

    expect(dialog.getByText(/provider default remains available/u)).toBeInTheDocument();
    expect(dialog.queryByLabelText("Custom model ID")).not.toBeInTheDocument();
    fireEvent.change(dialog.getByLabelText("Model"), { target: { value: "--custom--" } });
    fireEvent.change(dialog.getByLabelText("Custom model ID"), {
      target: { value: "custom-safe-model" }
    });
    fireEvent.change(dialog.getByLabelText("Task"), { target: { value: "Use custom" } });
    fireEvent.click(dialog.getByRole("button", { name: "Start" }));

    expect(onCreate).toHaveBeenCalledWith({
      prompt: "Use custom",
      provider: "codex",
      model: "custom-safe-model",
      reasoning: null
    });
  });

  it("preserves valid selections across a refetch and clears removed model state", () => {
    const onCreate = vi.fn();
    const onCancel = vi.fn();
    const view = render(
      <NewConversationDialog
        providers={[provider]}
        pending={false}
        error={null}
        onCancel={onCancel}
        onCreate={onCreate}
      />
    );
    const dialog = within(view.container);
    fireEvent.change(dialog.getByLabelText("Task"), { target: { value: "Use refreshed data" } });
    fireEvent.change(dialog.getByLabelText("Model"), { target: { value: "gpt-test" } });
    fireEvent.change(dialog.getByLabelText("Thinking"), { target: { value: "xhigh" } });

    view.rerender(
      <NewConversationDialog
        providers={[
          {
            ...provider,
            source: "cache",
            models: provider.models.map((model) => ({ ...model }))
          }
        ]}
        pending={false}
        error={null}
        onCancel={onCancel}
        onCreate={onCreate}
      />
    );
    expect(dialog.getByLabelText("Model")).toHaveValue("gpt-test");
    expect(dialog.getByLabelText("Thinking")).toHaveValue("xhigh");

    view.rerender(
      <NewConversationDialog
        providers={[
          {
            ...provider,
            models: provider.models.filter(({ id }) => id === provider.defaultModel)
          }
        ]}
        pending={false}
        error={null}
        onCancel={onCancel}
        onCreate={onCreate}
      />
    );
    expect(dialog.getByLabelText("Model")).toHaveValue("");
    expect(dialog.getByLabelText("Thinking")).toHaveValue("");
    fireEvent.click(dialog.getByRole("button", { name: "Start" }));
    expect(onCreate).toHaveBeenCalledWith({
      prompt: "Use refreshed data",
      provider: "codex",
      model: null,
      reasoning: null
    });
  });

  it("clears selections when an implicit provider disappears during refetch", () => {
    const onCreate = vi.fn();
    const onCancel = vi.fn();
    const view = render(
      <NewConversationDialog
        providers={[provider]}
        pending={false}
        error={null}
        onCancel={onCancel}
        onCreate={onCreate}
      />
    );
    const dialog = within(view.container);
    fireEvent.change(dialog.getByLabelText("Task"), { target: { value: "Use new provider" } });
    fireEvent.change(dialog.getByLabelText("Model"), { target: { value: "gpt-test" } });
    fireEvent.change(dialog.getByLabelText("Thinking"), { target: { value: "xhigh" } });

    const claudeProvider: ProviderCapability = {
      ...provider,
      id: "claude",
      label: "Claude",
      defaultModel: "claude-default",
      models: [
        {
          id: "claude-default",
          label: "Claude Default",
          description: null,
          defaultReasoning: null,
          reasoningOptions: [{ id: "high", label: "High" }]
        }
      ]
    };
    view.rerender(
      <NewConversationDialog
        providers={[claudeProvider]}
        pending={false}
        error={null}
        onCancel={onCancel}
        onCreate={onCreate}
      />
    );

    expect(dialog.getByLabelText("Captain")).toHaveValue("claude");
    expect(dialog.getByLabelText("Model")).toHaveValue("");
    expect(dialog.getByLabelText("Thinking")).toHaveValue("");
    fireEvent.click(dialog.getByRole("button", { name: "Start" }));
    expect(onCreate).toHaveBeenCalledWith({
      prompt: "Use new provider",
      provider: "claude",
      model: null,
      reasoning: null
    });
  });

  it("clears a custom model when refetched policy becomes catalog-only", () => {
    const onCreate = vi.fn();
    const onCancel = vi.fn();
    const view = render(
      <NewConversationDialog
        providers={[provider]}
        pending={false}
        error={null}
        onCancel={onCancel}
        onCreate={onCreate}
      />
    );
    const dialog = within(view.container);
    fireEvent.change(dialog.getByLabelText("Model"), { target: { value: "--custom--" } });
    fireEvent.change(dialog.getByLabelText("Custom model ID"), {
      target: { value: "custom-safe-model" }
    });

    view.rerender(
      <NewConversationDialog
        providers={[{ ...provider, customModelPolicy: "catalog-only" }]}
        pending={false}
        error={null}
        onCancel={onCancel}
        onCreate={onCreate}
      />
    );

    expect(dialog.getByLabelText("Model")).toHaveValue("");
    expect(dialog.queryByLabelText("Custom model ID")).not.toBeInTheDocument();
  });

  it("creates a named worker with provider defaults", () => {
    const onCreate = vi.fn();
    const view = render(
      <NewWorkerDialog
        providers={[provider]}
        pending={false}
        error={null}
        onCancel={vi.fn()}
        onCreate={onCreate}
      />
    );
    const dialog = within(view.container);

    fireEvent.change(dialog.getByLabelText("Name"), { target: { value: "Auth Tests" } });
    fireEvent.change(dialog.getByLabelText("Task"), {
      target: { value: "Add authentication coverage" }
    });
    fireEvent.click(dialog.getByRole("button", { name: "Start agent" }));

    expect(onCreate).toHaveBeenCalledWith({
      label: "Auth Tests",
      prompt: "Add authentication coverage",
      provider: "codex"
    });
  });

  it("requires confirmation before deleting a worker", () => {
    const onConfirm = vi.fn();
    const view = render(
      <DeleteWorkerDialog
        worker={worker}
        pending={false}
        error={null}
        onCancel={vi.fn()}
        onConfirm={onConfirm}
      />
    );
    const dialog = within(view.container);

    expect(dialog.getByText(/stops the agent and removes its session/u)).toBeInTheDocument();
    expect(dialog.getByRole("button", { name: "Cancel" })).toHaveFocus();
    fireEvent.click(dialog.getByRole("button", { name: "Delete agent" }));
    expect(onConfirm).toHaveBeenCalledOnce();
  });
});
