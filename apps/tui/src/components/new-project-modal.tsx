import { useEffect, useMemo, useRef, useState } from "react";

import type {
  CreateConversationInput,
  FolderSuggestion,
  ModelCapability,
  ProviderCapability
} from "@agentlab/contracts";
import type { WorkspacePreparation } from "@agentlab/runtime";
import type { InputRenderable } from "@opentui/core";
import { useKeyboard } from "@opentui/react";

import { palette } from "../theme.js";
import { ModalFrame } from "./modal-frame.js";

const CUSTOM_MODEL = "--custom--";
const COMPLETION_DELAY_MS = 75;
const COMPLETION_DEADLINE_MS = 175;
type CaptainField = "name" | "provider" | "model" | "customModel" | "reasoning";

interface NewProjectModalProps {
  readonly pending: boolean;
  readonly error: string | null;
  readonly onCancel: () => void;
  readonly onPrepare: (path: string) => Promise<WorkspacePreparation>;
  readonly onDiscoverProviders: (path: string) => Promise<readonly ProviderCapability[]>;
  readonly onCompleteFolders: (path: string) => Promise<readonly FolderSuggestion[]>;
  readonly onCreate: (input: CreateConversationInput) => void;
}

export function NewProjectModal(props: NewProjectModalProps) {
  const [folderPath, setFolderPath] = useState("");
  const [workspace, setWorkspace] = useState<WorkspacePreparation | null>(null);
  const [checking, setChecking] = useState(false);
  const [folderError, setFolderError] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<readonly FolderSuggestion[]>([]);
  const [suggestionIndex, setSuggestionIndex] = useState(0);
  const [popupOpen, setPopupOpen] = useState(false);
  const [completionSlow, setCompletionSlow] = useState(false);
  const [name, setName] = useState("");
  const [providers, setProviders] = useState<readonly ProviderCapability[]>([]);
  const [providersLoading, setProvidersLoading] = useState(false);
  const [providerError, setProviderError] = useState<string | null>(null);
  const [providerIndex, setProviderIndex] = useState(0);
  const [modelChoice, setModelChoice] = useState("");
  const [customModel, setCustomModel] = useState("");
  const [reasoning, setReasoning] = useState("");
  const [field, setField] = useState<CaptainField>("name");
  const [validationError, setValidationError] = useState<string | null>(null);
  const inspectionRequest = useRef(0);
  const completionRequest = useRef(0);
  const completionTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const completionDeadline = useRef<ReturnType<typeof setTimeout> | null>(null);
  const providerRequest = useRef(0);
  const hasPreparedWorkspace = useRef(false);
  const preferredProviderId = useRef<string | null>(null);
  const folderInput = useRef<InputRenderable | null>(null);
  const provider = providers[providerIndex] ?? null;
  const modelChoices = useMemo(() => modelOptions(provider), [provider]);
  const effectiveModel = selectedModel(provider, modelChoice);
  const reasoningChoices = [
    { id: "", label: reasoningDefaultLabel(effectiveModel) },
    ...(effectiveModel?.reasoningOptions ?? [])
  ];
  const fields: readonly CaptainField[] =
    modelChoice === CUSTOM_MODEL
      ? ["name", "provider", "model", "customModel", "reasoning"]
      : ["name", "provider", "model", "reasoning"];

  useEffect(
    () => () => {
      clearCompletionTimers(completionTimer, completionDeadline);
      inspectionRequest.current += 1;
      completionRequest.current += 1;
      providerRequest.current += 1;
    },
    []
  );

  const discoverProviders = (path: string): void => {
    const request = ++providerRequest.current;
    setProvidersLoading(true);
    setProviderError(null);
    void props.onDiscoverProviders(path).then(
      (result) => {
        if (request !== providerRequest.current) return;
        const preferredIndex =
          preferredProviderId.current === null
            ? -1
            : result.findIndex(({ id }) => id === preferredProviderId.current);
        const nextIndex =
          preferredIndex >= 0
            ? preferredIndex
            : Math.max(
                0,
                result.findIndex(({ available }) => available)
              );
        setProviders(result);
        setProviderIndex(nextIndex);
        preferredProviderId.current = result[nextIndex]?.id ?? null;
        if (preferredIndex < 0 && hasPreparedWorkspace.current) {
          setModelChoice("");
          setCustomModel("");
          setReasoning("");
        }
        setProvidersLoading(false);
      },
      (cause: unknown) => {
        if (request !== providerRequest.current) return;
        setProviderError(errorMessage(cause, "Provider discovery failed."));
        setProvidersLoading(false);
      }
    );
  };

  const inspectFolder = (path = folderPath): void => {
    if (path.trim() === "") {
      setFolderError("Enter a folder path.");
      return;
    }
    const request = ++inspectionRequest.current;
    setChecking(true);
    setFolderError(null);
    setPopupOpen(false);
    void props.onPrepare(path).then(
      (result) => {
        if (request !== inspectionRequest.current) return;
        setWorkspace(result);
        setFolderPath(result.workspacePath);
        if (!hasPreparedWorkspace.current) setName(result.suggestedName);
        hasPreparedWorkspace.current = true;
        setChecking(false);
        setField("name");
        discoverProviders(result.workspacePath);
      },
      (cause: unknown) => {
        if (request !== inspectionRequest.current) return;
        setFolderError(errorMessage(cause, "That folder could not be opened."));
        setChecking(false);
      }
    );
  };

  const scheduleCompletion = (path: string): void => {
    const request = ++completionRequest.current;
    clearCompletionTimers(completionTimer, completionDeadline);
    setSuggestions([]);
    setPopupOpen(false);
    setCompletionSlow(false);
    if (path === "") return;
    completionTimer.current = setTimeout(() => {
      completionDeadline.current = setTimeout(() => {
        if (request !== completionRequest.current) return;
        completionRequest.current += 1;
        setCompletionSlow(true);
        setSuggestions([]);
        setPopupOpen(false);
      }, COMPLETION_DEADLINE_MS);
      void props.onCompleteFolders(path).then(
        (result) => {
          if (request !== completionRequest.current) return;
          if (completionDeadline.current !== null) clearTimeout(completionDeadline.current);
          setSuggestions(result.slice(0, 6));
          setSuggestionIndex(0);
          setPopupOpen(result.length > 0);
        },
        () => {
          if (request !== completionRequest.current) return;
          setSuggestions([]);
          setPopupOpen(false);
        }
      );
    }, COMPLETION_DELAY_MS);
  };

  const acceptSuggestion = (suggestion = suggestions[suggestionIndex]): void => {
    if (suggestion === undefined) return;
    completionRequest.current += 1;
    clearCompletionTimers(completionTimer, completionDeadline);
    setFolderPath(suggestion.value);
    setSuggestions([]);
    setPopupOpen(false);
    setCompletionSlow(false);
    setFolderError(null);
    setTimeout(() => {
      folderInput.current?.focus();
    }, 0);
  };

  const changeFolder = (): void => {
    if (props.pending) return;
    inspectionRequest.current += 1;
    providerRequest.current += 1;
    setWorkspace(null);
    setChecking(false);
    setFolderError(null);
    setProviders([]);
    setProviderError(null);
    setProvidersLoading(false);
    setValidationError(null);
  };

  const submit = (): void => {
    if (props.pending || workspace === null) return;
    const title = name.trim();
    if (title === "") {
      invalidate("name", "Project name is required.");
      return;
    }
    if (provider?.available !== true) {
      invalidate("provider", "Choose an available captain provider.");
      return;
    }
    const model = modelChoice === CUSTOM_MODEL ? customModel.trim() : modelChoice || null;
    if (model === "") {
      invalidate("customModel", "Custom model ID is required.");
      return;
    }
    setValidationError(null);
    props.onCreate({
      title,
      workspacePath: workspace.workspacePath,
      provider: provider.id,
      model,
      reasoning: reasoning || null,
      prompt: null
    });
  };

  const invalidate = (invalidField: CaptainField, issue: string): void => {
    setField(invalidField);
    setValidationError(issue);
  };

  const chooseRelative = (delta: number): void => {
    if (field === "provider" && providers.length > 0) {
      setProviderIndex((current) => {
        const next = cycleIndex(current, delta, providers.length);
        preferredProviderId.current = providers[next]?.id ?? null;
        return next;
      });
      setModelChoice("");
      setCustomModel("");
      setReasoning("");
    } else if (field === "model") {
      const current = Math.max(
        0,
        modelChoices.findIndex(({ id }) => id === modelChoice)
      );
      setModelChoice(modelChoices[cycleIndex(current, delta, modelChoices.length)]?.id ?? "");
      setReasoning("");
    } else if (field === "reasoning") {
      const current = Math.max(
        0,
        reasoningChoices.findIndex(({ id }) => id === reasoning)
      );
      setReasoning(reasoningChoices[cycleIndex(current, delta, reasoningChoices.length)]?.id ?? "");
    }
  };

  useKeyboard((key) => {
    if (props.pending) {
      if (["escape", "return", "enter"].includes(key.name)) key.preventDefault();
      return;
    }
    if (workspace === null) {
      if (key.name === "escape") {
        key.preventDefault();
        if (popupOpen) setPopupOpen(false);
        else props.onCancel();
      } else if ((key.name === "up" || key.name === "down") && popupOpen) {
        key.preventDefault();
        setSuggestionIndex((current) =>
          cycleIndex(current, key.name === "up" ? -1 : 1, suggestions.length)
        );
      } else if (key.name === "tab" && popupOpen) {
        key.preventDefault();
        key.stopPropagation();
        acceptSuggestion();
      } else if (key.name === "return" || key.name === "enter") {
        key.preventDefault();
        key.stopPropagation();
        inspectFolder();
      }
      return;
    }
    if (key.name === "escape") {
      key.preventDefault();
      props.onCancel();
    } else if (key.meta && key.name === "left") {
      key.preventDefault();
      changeFolder();
    } else if (key.name === "tab") {
      key.preventDefault();
      key.stopPropagation();
      const offset = key.shift ? -1 : 1;
      const current = fields.indexOf(field);
      setField(fields[(current + offset + fields.length) % fields.length] ?? "name");
    } else if (key.ctrl && (key.name === "return" || key.name === "enter")) {
      key.preventDefault();
      key.stopPropagation();
      submit();
    } else if (["up", "down", "left", "right"].includes(key.name)) {
      chooseRelative(key.name === "up" || key.name === "left" ? -1 : 1);
    }
  });

  if (workspace === null) {
    return (
      <ModalFrame
        title="Add project · 1/2"
        height={16}
        footer="↑/↓ choose · Tab accept · Enter validate · Esc close"
      >
        <text fg={palette.text} attributes={1}>
          Choose the project folder
        </text>
        <input
          key="folder-path"
          ref={folderInput}
          focused
          value={folderPath}
          maxLength={4_096}
          placeholder="~/Projects/my app or ./relative"
          backgroundColor={palette.background}
          focusedBackgroundColor={palette.panelRaised}
          textColor={palette.text}
          onInput={(value) => {
            inspectionRequest.current += 1;
            setChecking(false);
            setFolderPath(value);
            setFolderError(null);
            scheduleCompletion(value);
          }}
          onKeyDown={(key) => {
            if ((key.name === "up" || key.name === "down") && popupOpen) {
              key.preventDefault();
              key.stopPropagation();
              setSuggestionIndex((current) =>
                cycleIndex(current, key.name === "up" ? -1 : 1, suggestions.length)
              );
            } else if (key.name === "tab" && popupOpen) {
              key.preventDefault();
              key.stopPropagation();
              acceptSuggestion();
            } else if (key.name === "escape" && popupOpen) {
              key.preventDefault();
              key.stopPropagation();
              setPopupOpen(false);
            }
          }}
          onSubmit={(value) => {
            inspectFolder(typeof value === "string" ? value : folderPath);
          }}
        />
        <text fg={palette.muted}>Absolute, relative, ~/ paths; spaces stay literal.</text>
        {popupOpen
          ? suggestions.map((suggestion, index) => (
              <text
                key={suggestion.value}
                fg={index === suggestionIndex ? palette.accent : palette.text}
                bg={index === suggestionIndex ? palette.panelRaised : palette.panel}
                wrapMode="none"
                truncate
                onMouseDown={() => {
                  acceptSuggestion(suggestion);
                }}
              >
                {index === suggestionIndex ? "› " : "  "}
                {suggestion.label}
              </text>
            ))
          : null}
        {checking ? <text fg={palette.warning}>Checking folder…</text> : null}
        {completionSlow ? (
          <text fg={palette.muted}>Suggestions paused; type or press Enter to continue.</text>
        ) : null}
        {folderError === null ? null : <text fg={palette.danger}>{folderError}</text>}
      </ModalFrame>
    );
  }

  const status = providerStatus(provider, providersLoading, providerError);
  return (
    <ModalFrame
      title="Add project · 2/2"
      height={16}
      footer={
        props.pending
          ? "Starting · fields are locked"
          : "Tab fields · ←/→ choose · Ctrl+Enter start · Alt+← folder · Esc close"
      }
    >
      <text fg={palette.muted} wrapMode="none" truncate onMouseDown={changeFolder}>
        Folder <span fg={palette.text}>{workspace.workspacePath}</span>
        {"  "}
        <span fg={palette.accent}>change</span>
      </text>
      <input
        key="project-name"
        focused={!props.pending && field === "name"}
        value={name}
        maxLength={80}
        placeholder="Project name"
        backgroundColor={palette.background}
        focusedBackgroundColor={palette.panelRaised}
        textColor={palette.text}
        onInput={(value) => {
          if (props.pending) return;
          setName(value);
          setValidationError(null);
        }}
        onKeyDown={(key) => {
          if (key.ctrl && (key.name === "return" || key.name === "enter")) {
            key.preventDefault();
            key.stopPropagation();
            submit();
          }
        }}
        onSubmit={submit}
      />
      <ChoiceLine
        label="Captain"
        value={provider?.label ?? "No provider detected"}
        active={field === "provider"}
        onActivate={() => {
          if (!props.pending) setField("provider");
        }}
      />
      <ChoiceLine
        label="Model"
        value={modelChoices.find(({ id }) => id === modelChoice)?.label ?? "Provider default"}
        active={field === "model"}
        onActivate={() => {
          if (!props.pending) setField("model");
        }}
      />
      {modelChoice === CUSTOM_MODEL ? (
        <input
          key="custom-model"
          focused={!props.pending && field === "customModel"}
          value={customModel}
          maxLength={4_096}
          placeholder="Custom model ID"
          backgroundColor={palette.background}
          focusedBackgroundColor={palette.panelRaised}
          textColor={palette.text}
          onInput={(value) => {
            if (!props.pending) {
              setCustomModel(value);
              setValidationError(null);
            }
          }}
          onKeyDown={(key) => {
            if (key.ctrl && (key.name === "return" || key.name === "enter")) {
              key.preventDefault();
              key.stopPropagation();
              submit();
            }
          }}
          onSubmit={submit}
        />
      ) : null}
      <ChoiceLine
        label="Reasoning"
        value={reasoningChoices.find(({ id }) => id === reasoning)?.label ?? "Provider default"}
        active={field === "reasoning"}
        onActivate={() => {
          if (!props.pending) setField("reasoning");
        }}
      />
      <text
        fg={
          providerError === null && provider?.available !== false ? palette.muted : palette.danger
        }
        wrapMode="none"
        truncate
        onMouseDown={() => {
          if (!props.pending && !providersLoading) discoverProviders(workspace.workspacePath);
        }}
      >
        {status}
        {!providersLoading &&
        (providerError !== null || providers.length === 0 || provider?.available === false)
          ? " · retry"
          : ""}
      </text>
      <text fg={palette.warning} wrapMode="word">
        Captain runs commands and edits this folder without approval prompts. Provider safeguards
        vary.
      </text>
      {validationError === null && props.error === null ? null : (
        <text fg={palette.danger}>{validationError ?? props.error}</text>
      )}
      {props.pending ? <text fg={palette.warning}>Starting project captain…</text> : null}
    </ModalFrame>
  );
}

function ChoiceLine({
  label,
  value,
  active,
  onActivate
}: {
  readonly label: string;
  readonly value: string;
  readonly active: boolean;
  readonly onActivate: () => void;
}) {
  return (
    <text
      fg={active ? palette.accent : palette.muted}
      bg={active ? palette.panelRaised : palette.panel}
      wrapMode="none"
      truncate
      onMouseDown={onActivate}
    >
      {label}
      {"  "}
      <span fg={palette.text}>{active ? `‹ ${value} ›` : value}</span>
    </text>
  );
}

function modelOptions(provider: ProviderCapability | null) {
  return [
    { id: "", label: defaultModelLabel(provider) },
    ...(provider?.models.map((model) => ({ id: model.id, label: model.label })) ?? []),
    ...(provider?.customModelPolicy === "allowed"
      ? [{ id: CUSTOM_MODEL, label: "Custom model ID" }]
      : [])
  ];
}

function providerStatus(
  provider: ProviderCapability | null,
  loading: boolean,
  error: string | null
): string {
  if (loading) return "Checking captain providers…";
  if (error !== null) return error;
  if (provider === null) return "No supported provider is available on this machine.";
  if (!provider.available) return `${provider.label}: ${provider.reason ?? "unavailable"}`;
  return `${provider.label}: ready${provider.reason === null ? "" : ` · ${provider.reason}`}`;
}

function clearCompletionTimers(
  debounce: { current: ReturnType<typeof setTimeout> | null },
  deadline: { current: ReturnType<typeof setTimeout> | null }
): void {
  if (debounce.current !== null) clearTimeout(debounce.current);
  if (deadline.current !== null) clearTimeout(deadline.current);
  debounce.current = null;
  deadline.current = null;
}

function cycleIndex(current: number, delta: number, length: number): number {
  return length === 0 ? 0 : (current + delta + length) % length;
}

function selectedModel(
  provider: ProviderCapability | null,
  choice: string
): ModelCapability | null {
  const id = choice === "" ? provider?.defaultModel : choice;
  return provider?.models.find((model) => model.id === id) ?? null;
}

function defaultModelLabel(provider: ProviderCapability | null): string {
  const model = provider?.models.find(({ id }) => id === provider.defaultModel);
  return model === undefined ? "Provider default" : `${model.label} · default`;
}

function reasoningDefaultLabel(model: ModelCapability | null): string {
  const option = model?.reasoningOptions.find(({ id }) => id === model.defaultReasoning);
  return option === undefined ? "Provider default" : `${option.label} · default`;
}

function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error ? cause.message : fallback;
}
