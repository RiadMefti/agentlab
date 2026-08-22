import { useEffect, useState, type SyntheticEvent } from "react";

import type {
  CreateConversationInput,
  ModelCapability,
  ProviderCapability,
  ProviderId
} from "@orchestrator/contracts";

const CUSTOM_MODEL_CHOICE = "--custom--";

interface NewConversationDialogProps {
  readonly providers: readonly ProviderCapability[];
  readonly pending: boolean;
  readonly error: string | null;
  readonly onCancel: () => void;
  readonly onCreate: (input: CreateConversationInput) => void;
}

interface DialogSelection {
  readonly providers: readonly ProviderCapability[];
  readonly providerId: ProviderId | null;
  readonly activeProviderId: ProviderId | null;
  readonly modelChoice: string;
  readonly customModel: string;
  readonly reasoning: string;
}

export function NewConversationDialog({
  providers,
  pending,
  error,
  onCancel,
  onCreate
}: NewConversationDialogProps) {
  const initialProvider = resolveProvider(providers, null);
  const [storedSelection, setStoredSelection] = useState<DialogSelection>(() => ({
    providers,
    providerId: null,
    activeProviderId: initialProvider?.id ?? null,
    modelChoice: "",
    customModel: "",
    reasoning: ""
  }));
  let selection = storedSelection;
  if (selection.providers !== providers) {
    selection = reconcileSelection(selection, providers);
    setStoredSelection(selection);
  }
  const provider = resolveProvider(providers, selection.providerId);
  const effectiveModelChoice = selection.modelChoice;
  const selectedModel =
    effectiveModelChoice === ""
      ? null
      : effectiveModelChoice === CUSTOM_MODEL_CHOICE
        ? selection.customModel.trim() || null
        : effectiveModelChoice;
  const effectiveModelId = selectedModel ?? provider?.defaultModel ?? null;
  const modelCapability = provider?.models.find(({ id }) => id === effectiveModelId) ?? null;
  const reasoning = modelCapability?.reasoningOptions.some(({ id }) => id === selection.reasoning)
    ? selection.reasoning
    : null;
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
    if (
      provider === null ||
      !provider.available ||
      prompt.trim() === "" ||
      (effectiveModelChoice === CUSTOM_MODEL_CHOICE && selectedModel === null)
    ) {
      return;
    }
    onCreate({
      provider: provider.id,
      model: selectedModel,
      reasoning,
      prompt: prompt.trim()
    });
  }

  const selectableModels = provider?.models.filter(({ id }) => id !== provider.defaultModel) ?? [];
  const reasoningOptions = modelCapability?.reasoningOptions ?? [];
  const selectableReasoning = reasoningOptions.filter(
    ({ id }) => id !== modelCapability?.defaultReasoning
  );

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
                    setStoredSelection((current) => ({
                      ...current,
                      providers,
                      providerId: selected.id,
                      activeProviderId: selected.id,
                      modelChoice: "",
                      customModel: "",
                      reasoning: ""
                    }));
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
              <select
                value={effectiveModelChoice}
                onChange={(event) => {
                  setStoredSelection((current) => ({
                    ...current,
                    providers,
                    modelChoice: event.target.value,
                    reasoning: ""
                  }));
                }}
              >
                <option value="">{modelDefaultLabel(provider)}</option>
                {selectableModels.map((model) => (
                  <option value={model.id} key={model.id}>
                    {model.label}
                  </option>
                ))}
                {provider?.customModelPolicy === "allowed" ? (
                  <option value={CUSTOM_MODEL_CHOICE}>Custom model…</option>
                ) : null}
              </select>
            </label>

            <label className="field">
              <span>Thinking</span>
              <select
                value={reasoning ?? ""}
                disabled={reasoningOptions.length === 0}
                onChange={(event) => {
                  setStoredSelection((current) => ({
                    ...current,
                    providers,
                    reasoning: event.target.value
                  }));
                }}
              >
                <option value="">{reasoningDefaultLabel(provider, modelCapability)}</option>
                {selectableReasoning.map((option) => (
                  <option value={option.id} key={option.id}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {effectiveModelChoice === CUSTOM_MODEL_CHOICE ? (
            <label className="field custom-model-field">
              <span>Custom model ID</span>
              <input
                required
                value={selection.customModel}
                placeholder="Provider model identifier"
                onChange={(event) => {
                  setStoredSelection((current) => ({
                    ...current,
                    providers,
                    customModel: event.target.value
                  }));
                }}
              />
            </label>
          ) : null}

          <ProviderNotice provider={provider} />
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
                prompt.trim() === "" ||
                (effectiveModelChoice === CUSTOM_MODEL_CHOICE && selectedModel === null)
              }
            >
              {pending ? "Starting…" : "Start"}
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

function reconcileSelection(
  selection: DialogSelection,
  providers: readonly ProviderCapability[]
): DialogSelection {
  const requestedProviderExists =
    selection.providerId === null || providers.some(({ id }) => id === selection.providerId);
  const provider = resolveProvider(providers, selection.providerId);
  const providerId = requestedProviderExists ? selection.providerId : (provider?.id ?? null);
  const providerChanged = selection.activeProviderId !== (provider?.id ?? null);
  if (providerChanged || !isModelChoiceValid(provider, selection.modelChoice)) {
    return {
      providers,
      providerId,
      activeProviderId: provider?.id ?? null,
      modelChoice: "",
      customModel: "",
      reasoning: ""
    };
  }

  const selectedModel =
    selection.modelChoice === ""
      ? provider?.defaultModel
      : selection.modelChoice === CUSTOM_MODEL_CHOICE
        ? selection.customModel.trim() || null
        : selection.modelChoice;
  const model = provider?.models.find(({ id }) => id === selectedModel) ?? null;
  return {
    ...selection,
    providers,
    providerId,
    activeProviderId: provider?.id ?? null,
    reasoning: model?.reasoningOptions.some(({ id }) => id === selection.reasoning)
      ? selection.reasoning
      : ""
  };
}

function isModelChoiceValid(provider: ProviderCapability | null, modelChoice: string): boolean {
  if (modelChoice === "") return true;
  if (provider === null) return false;
  if (modelChoice === CUSTOM_MODEL_CHOICE) return provider.customModelPolicy === "allowed";
  return provider.models.some(({ id }) => id === modelChoice);
}

function modelDefaultLabel(provider: ProviderCapability | null): string {
  const model = provider?.models.find(({ id }) => id === provider.defaultModel);
  if (model === undefined) return "Default";
  if (model.label.toLowerCase() === "default" || /\brecommended\b/iu.test(model.label)) {
    return model.label;
  }
  return `${model.label} · default`;
}

function reasoningDefaultLabel(
  provider: ProviderCapability | null,
  model: ModelCapability | null
): string {
  if (model === null) return "Default";
  if (model.reasoningOptions.length === 0) {
    return provider?.id === "opencode" ? "In OpenCode" : "Not available";
  }
  const option = model.reasoningOptions.find(({ id }) => id === model.defaultReasoning);
  return option === undefined ? "Default" : `${option.label} · default`;
}

function ProviderNotice({ provider }: { readonly provider: ProviderCapability | null }) {
  if (provider === null) return null;
  if (!provider.available) return <p className="form-error">{provider.reason}</p>;
  if (provider.source === "stale") {
    return <p className="form-note">Showing the last known model catalog. {provider.reason}</p>;
  }
  if (provider.source === "fallback") {
    return (
      <p className="form-note">
        Model discovery is unavailable; provider default remains available. {provider.reason}
      </p>
    );
  }
  if (provider.models.length === 0) {
    return <p className="form-note">This provider currently exposes only its default model.</p>;
  }
  return null;
}
