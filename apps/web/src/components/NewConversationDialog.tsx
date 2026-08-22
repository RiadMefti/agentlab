import { useEffect, useState, type SyntheticEvent } from "react";

import type {
  CreateConversationInput,
  ProviderCapability,
  ProviderId,
  ReasoningLevel
} from "@orchestrator/contracts";

interface NewConversationDialogProps {
  readonly providers: readonly ProviderCapability[];
  readonly pending: boolean;
  readonly error: string | null;
  readonly onCancel: () => void;
  readonly onCreate: (input: CreateConversationInput) => void;
}

export function NewConversationDialog({
  providers,
  pending,
  error,
  onCancel,
  onCreate
}: NewConversationDialogProps) {
  const firstAvailable = providers.find(({ available }) => available) ?? providers[0] ?? null;
  const [providerId, setProviderId] = useState<ProviderId | null>(null);
  const provider = providers.find(({ id }) => id === providerId) ?? firstAvailable;
  const [selectedReasoning, setSelectedReasoning] = useState<ReasoningLevel | null>(null);
  const reasoning =
    provider !== null &&
    selectedReasoning !== null &&
    provider.reasoningLevels.includes(selectedReasoning)
      ? selectedReasoning
      : (provider?.defaultReasoning ?? "high");
  const [model, setModel] = useState("");
  const [prompt, setPrompt] = useState("");

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [onCancel]);

  function submit(event: SyntheticEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (provider === null || !provider.available || prompt.trim() === "") return;
    onCreate({
      provider: provider.id,
      reasoning,
      prompt: prompt.trim(),
      ...(model.trim() === "" ? {} : { model: model.trim() })
    });
  }

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={onCancel}>
      <section
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-conversation-title"
        onMouseDown={(event) => {
          event.stopPropagation();
        }}
      >
        <header className="dialog-header">
          <h2 id="new-conversation-title">New conversation</h2>
          <button type="button" className="quiet-action" onClick={onCancel}>
            Close
          </button>
        </header>
        <form onSubmit={submit}>
          <label className="field task-field">
            <span>Task</span>
            <textarea
              autoFocus
              required
              value={prompt}
              placeholder="What should the captain coordinate?"
              onChange={(event) => {
                setPrompt(event.target.value);
              }}
            />
          </label>

          <div className="configuration-row">
            <label className="field">
              <span>Captain</span>
              <select
                value={provider?.id ?? ""}
                onChange={(event) => {
                  const selected = providers.find(({ id }) => id === event.target.value);
                  if (selected !== undefined) {
                    setProviderId(selected.id);
                    setSelectedReasoning(selected.defaultReasoning);
                    setModel("");
                  }
                }}
              >
                {providers.map((option) => (
                  <option value={option.id} key={option.id} disabled={!option.available}>
                    {option.label}
                    {option.available ? "" : " — unavailable"}
                  </option>
                ))}
              </select>
            </label>

            <label className="field">
              <span>Model</span>
              <input
                value={model}
                placeholder="Provider default"
                list="model-suggestions"
                onChange={(event) => {
                  setModel(event.target.value);
                }}
              />
              <datalist id="model-suggestions">
                {(provider?.modelSuggestions ?? []).map((suggestion) => (
                  <option value={suggestion} key={suggestion} />
                ))}
              </datalist>
            </label>

            <label className="field">
              <span>Thinking</span>
              <select
                value={reasoning}
                onChange={(event) => {
                  setSelectedReasoning(event.target.value as ReasoningLevel);
                }}
              >
                {(provider?.reasoningLevels ?? []).map((level) => (
                  <option value={level} key={level}>
                    {level}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {provider !== null && !provider.available ? (
            <p className="form-error">{provider.reason}</p>
          ) : null}
          {providers.length === 0 && error === null ? (
            <p className="form-note">Looking for installed agents…</p>
          ) : null}
          {error === null ? null : <p className="form-error">{error}</p>}

          <div className="dialog-actions">
            <button
              type="submit"
              className="primary-action"
              disabled={pending || provider === null || !provider.available || prompt.trim() === ""}
            >
              {pending ? "Starting…" : "Start"}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
