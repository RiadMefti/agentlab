import { useMemo, useRef, useState } from "react";

import type {
  CreateConversationInput,
  ModelCapability,
  ProviderCapability
} from "@orchestrator/contracts";
import { useKeyboard } from "@opentui/react";
import type { WorkspaceInspection } from "@orchestrator/runtime";

import { palette } from "../theme.js";
import { ModalFrame } from "./modal-frame.js";

const CUSTOM_MODEL = "--custom--";
type CaptainField = "name" | "provider" | "model" | "customModel" | "reasoning";

export function NewProjectModal({
  pending,
  error,
  onCancel,
  onInspect,
  onCreate
}: {
  readonly pending: boolean;
  readonly error: string | null;
  readonly onCancel: () => void;
  readonly onInspect: (path: string) => Promise<WorkspaceInspection>;
  readonly onCreate: (input: CreateConversationInput) => void;
}) {
  const [folderPath, setFolderPath] = useState("");
  const [inspection, setInspection] = useState<WorkspaceInspection | null>(null);
  const [checking, setChecking] = useState(false);
  const [inspectionError, setInspectionError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [providerIndex, setProviderIndex] = useState(0);
  const [modelChoice, setModelChoice] = useState("");
  const [customModel, setCustomModel] = useState("");
  const [reasoning, setReasoning] = useState("");
  const [field, setField] = useState<CaptainField>("name");
  const inspectionRequest = useRef(0);
  const providers = inspection?.providers ?? [];
  const provider = providers[providerIndex] ?? null;
  const modelChoices = useMemo(
    () => [
      { id: "", label: defaultModelLabel(provider) },
      ...(provider?.models.map((model) => ({ id: model.id, label: model.label })) ?? []),
      ...(provider?.customModelPolicy === "allowed"
        ? [{ id: CUSTOM_MODEL, label: "Custom model ID" }]
        : [])
    ],
    [provider]
  );
  const effectiveModel = selectedModel(provider, modelChoice);
  const reasoningChoices = [
    { id: "", label: reasoningDefaultLabel(effectiveModel) },
    ...(effectiveModel?.reasoningOptions ?? [])
  ];
  const fields: readonly CaptainField[] =
    modelChoice === CUSTOM_MODEL
      ? ["name", "provider", "model", "customModel", "reasoning"]
      : ["name", "provider", "model", "reasoning"];

  const inspectFolder = (path = folderPath): void => {
    const nextPath = path.trim();
    if (checking || nextPath === "") return;
    const request = ++inspectionRequest.current;
    setChecking(true);
    setInspectionError(null);
    void onInspect(nextPath)
      .then((result) => {
        if (request !== inspectionRequest.current) return;
        setInspection(result);
        setFolderPath(result.workspacePath);
        setName(result.suggestedName);
        setProviderIndex(
          Math.max(
            0,
            result.providers.findIndex(({ available }) => available)
          )
        );
        setModelChoice("");
        setCustomModel("");
        setReasoning("");
        setField("name");
      })
      .catch((cause: unknown) => {
        if (request === inspectionRequest.current) {
          setInspectionError(
            cause instanceof Error ? cause.message : "That folder could not be opened."
          );
        }
      })
      .finally(() => {
        if (request === inspectionRequest.current) setChecking(false);
      });
  };

  const changeFolder = (): void => {
    inspectionRequest.current += 1;
    setInspection(null);
    setInspectionError(null);
    setChecking(false);
  };

  const submit = (): void => {
    const projectName = name.trim();
    const model = modelChoice === CUSTOM_MODEL ? customModel.trim() : modelChoice || null;
    if (
      pending ||
      inspection === null ||
      provider === null ||
      !provider.available ||
      projectName === "" ||
      model === ""
    ) {
      return;
    }
    onCreate({
      title: projectName,
      workspacePath: inspection.workspacePath,
      provider: provider.id,
      model,
      reasoning: reasoning || null,
      prompt: null
    });
  };

  useKeyboard((key) => {
    if (key.name === "escape") {
      key.preventDefault();
      onCancel();
      return;
    }
    if (inspection === null) {
      if (key.name === "return" || key.name === "enter") {
        key.preventDefault();
        key.stopPropagation();
        inspectFolder();
      }
      return;
    }
    if (key.meta && key.name === "left") {
      key.preventDefault();
      changeFolder();
      return;
    }
    if (key.name === "tab") {
      key.preventDefault();
      key.stopPropagation();
      const offset = key.shift ? -1 : 1;
      const current = fields.indexOf(field);
      setField(fields[(current + offset + fields.length) % fields.length] ?? fields[0] ?? "name");
      return;
    }
    if (key.ctrl && (key.name === "return" || key.name === "enter")) {
      key.preventDefault();
      key.stopPropagation();
      submit();
      return;
    }
    if (!["up", "down", "left", "right"].includes(key.name)) return;
    const delta = key.name === "up" || key.name === "left" ? -1 : 1;
    if (field === "provider" && providers.length > 0) {
      key.preventDefault();
      setProviderIndex((current) => cycleIndex(current, delta, providers.length));
      setModelChoice("");
      setCustomModel("");
      setReasoning("");
    } else if (field === "model") {
      key.preventDefault();
      const current = Math.max(
        0,
        modelChoices.findIndex(({ id }) => id === modelChoice)
      );
      setModelChoice(modelChoices[cycleIndex(current, delta, modelChoices.length)]?.id ?? "");
      setReasoning("");
    } else if (field === "reasoning") {
      key.preventDefault();
      const current = Math.max(
        0,
        reasoningChoices.findIndex(({ id }) => id === reasoning)
      );
      setReasoning(reasoningChoices[cycleIndex(current, delta, reasoningChoices.length)]?.id ?? "");
    }
  });

  if (inspection === null) {
    return (
      <ModalFrame title="Add project" height={17} footer="Enter continue · Esc cancel">
        <box flexDirection="column" marginBottom={1}>
          <text fg={palette.text} attributes={1}>
            Choose the project folder
          </text>
          <text fg={palette.muted}>Paste any existing folder path on this machine.</text>
        </box>
        <text fg={palette.accent}>Folder path</text>
        <input
          focused
          value={folderPath}
          maxLength={4_096}
          placeholder="~/Projects/my-app or /any/folder"
          backgroundColor={palette.background}
          focusedBackgroundColor={palette.panelRaised}
          textColor={palette.text}
          onInput={(value) => {
            inspectionRequest.current += 1;
            setFolderPath(value);
            setInspectionError(null);
          }}
          onSubmit={() => {
            inspectFolder();
          }}
        />
        <box flexDirection="column" marginTop={1}>
          <text fg={palette.muted}>Supports absolute paths, relative paths, and ~/ shortcuts.</text>
          {checking ? <text fg={palette.warning}>Checking folder and providers…</text> : null}
          {inspectionError === null ? null : (
            <text fg={palette.danger} wrapMode="word">
              {inspectionError}
            </text>
          )}
        </box>
      </ModalFrame>
    );
  }

  return (
    <ModalFrame
      title="Add project"
      height={27}
      footer="Tab fields · ←/→ choose · Ctrl+Enter create · Alt+← change folder · Esc cancel"
    >
      <box flexDirection="column" marginBottom={1} onMouseDown={changeFolder}>
        <text fg={palette.muted}>Folder</text>
        <text fg={palette.text} wrapMode="none" truncate>
          {inspection.workspacePath}
        </text>
      </box>
      <box flexDirection="column" marginBottom={1}>
        <text fg={field === "name" ? palette.accent : palette.muted}>Project name</text>
        <input
          focused={field === "name"}
          value={name}
          maxLength={80}
          placeholder="My project"
          backgroundColor={palette.background}
          focusedBackgroundColor={palette.panelRaised}
          textColor={palette.text}
          onInput={setName}
        />
      </box>
      <ChoiceField
        label="Captain"
        value={
          provider === null
            ? "No providers found"
            : `${provider.label}${provider.available ? "" : " — unavailable"}`
        }
        active={field === "provider"}
        onActivate={() => {
          setField("provider");
        }}
      />
      <ChoiceField
        label="Model"
        value={modelChoices.find(({ id }) => id === modelChoice)?.label ?? "Default"}
        active={field === "model"}
        onActivate={() => {
          setField("model");
        }}
      />
      {modelChoice === CUSTOM_MODEL ? (
        <box flexDirection="column" marginBottom={1}>
          <text fg={field === "customModel" ? palette.accent : palette.muted}>Custom model ID</text>
          <input
            focused={field === "customModel"}
            value={customModel}
            maxLength={4_096}
            placeholder="provider model identifier"
            backgroundColor={palette.background}
            focusedBackgroundColor={palette.panelRaised}
            textColor={palette.text}
            onInput={setCustomModel}
          />
        </box>
      ) : null}
      <ChoiceField
        label="Reasoning"
        value={reasoningChoices.find(({ id }) => id === reasoning)?.label ?? "Default"}
        active={field === "reasoning"}
        onActivate={() => {
          setField("reasoning");
        }}
      />
      {provider !== null && !provider.available ? (
        <text fg={palette.danger}>{provider.reason ?? "Provider unavailable."}</text>
      ) : null}
      {error === null ? null : <text fg={palette.danger}>{error}</text>}
      {pending ? <text fg={palette.warning}>Starting project captain…</text> : null}
    </ModalFrame>
  );
}

function ChoiceField({
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
    <box flexDirection="column" marginBottom={1} onMouseDown={onActivate}>
      <text fg={active ? palette.accent : palette.muted}>{label}</text>
      <text fg={palette.text} bg={active ? palette.panelRaised : palette.background}>
        {active ? "‹ " : "  "}
        {value}
        {active ? " ›" : ""}
      </text>
    </box>
  );
}

function cycleIndex(current: number, delta: number, length: number): number {
  if (length === 0) return 0;
  return (current + delta + length) % length;
}

function selectedModel(
  provider: ProviderCapability | null,
  modelChoice: string
): ModelCapability | null {
  const id = modelChoice === "" ? provider?.defaultModel : modelChoice;
  return provider?.models.find((model) => model.id === id) ?? null;
}

function defaultModelLabel(provider: ProviderCapability | null): string {
  const model = provider?.models.find(({ id }) => id === provider.defaultModel);
  return model === undefined ? "Default" : `${model.label} · default`;
}

function reasoningDefaultLabel(model: ModelCapability | null): string {
  const option = model?.reasoningOptions.find(({ id }) => id === model.defaultReasoning);
  return option === undefined ? "Default" : `${option.label} · default`;
}
