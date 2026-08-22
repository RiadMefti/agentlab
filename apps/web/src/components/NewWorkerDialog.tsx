import { useEffect, useState, type SyntheticEvent } from "react";

import type { CreateWorkerInput, ProviderCapability, ProviderId } from "@orchestrator/contracts";

interface NewWorkerDialogProps {
  readonly providers: readonly ProviderCapability[];
  readonly pending: boolean;
  readonly error: string | null;
  readonly onCancel: () => void;
  readonly onCreate: (input: CreateWorkerInput) => void;
}

export function NewWorkerDialog({
  providers,
  pending,
  error,
  onCancel,
  onCreate
}: NewWorkerDialogProps) {
  const [providerId, setProviderId] = useState<ProviderId | null>(null);
  const [label, setLabel] = useState("");
  const [prompt, setPrompt] = useState("");
  const provider = resolveProvider(providers, providerId);

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
    if (provider === null || !provider.available || label.trim() === "" || prompt.trim() === "") {
      return;
    }
    onCreate({ provider: provider.id, label: label.trim(), prompt: prompt.trim() });
  }

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={onCancel}>
      <section
        className="dialog worker-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-worker-title"
        onMouseDown={(event) => {
          event.stopPropagation();
        }}
      >
        <header className="dialog-header">
          <h2 id="new-worker-title">New agent</h2>
          <button type="button" className="quiet-action" onClick={onCancel}>
            Close
          </button>
        </header>
        <form onSubmit={submit}>
          <div className="worker-configuration">
            <label className="field">
              <span>Name</span>
              <input
                autoFocus
                required
                maxLength={32}
                pattern="[A-Za-z0-9]+(?:[ -][A-Za-z0-9]+)*"
                value={label}
                placeholder="auth tests"
                onChange={(event) => {
                  setLabel(event.target.value);
                }}
              />
            </label>

            <label className="field">
              <span>Agent</span>
              <select
                value={provider?.id ?? ""}
                onChange={(event) => {
                  const selected = providers.find(({ id }) => id === event.target.value);
                  if (selected !== undefined) setProviderId(selected.id);
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
          </div>

          <label className="field worker-task-field">
            <span>Task</span>
            <textarea
              required
              value={prompt}
              placeholder="What should this agent work on?"
              onChange={(event) => {
                setPrompt(event.target.value);
              }}
            />
          </label>

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
              disabled={
                pending ||
                provider === null ||
                !provider.available ||
                label.trim() === "" ||
                prompt.trim() === ""
              }
            >
              {pending ? "Starting…" : "Start agent"}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}

function resolveProvider(
  providers: readonly ProviderCapability[],
  providerId: ProviderId | null
): ProviderCapability | null {
  return (
    providers.find(({ id }) => id === providerId) ??
    providers.find(({ available }) => available) ??
    providers[0] ??
    null
  );
}
