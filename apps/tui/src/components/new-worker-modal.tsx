import { useRef, useState } from "react";

import type { CreateWorkerInput, ProviderCapability } from "@orchestrator/contracts";
import type { TextareaRenderable } from "@opentui/core";
import { useKeyboard } from "@opentui/react";

import { palette } from "../theme.js";
import { ModalFrame } from "./modal-frame.js";

type Field = "name" | "provider" | "prompt";

export function NewWorkerModal({
  providers,
  pending,
  error,
  onCancel,
  onCreate
}: {
  readonly providers: readonly ProviderCapability[];
  readonly pending: boolean;
  readonly error: string | null;
  readonly onCancel: () => void;
  readonly onCreate: (input: CreateWorkerInput) => void;
}) {
  const initialProviderIndex = Math.max(
    0,
    providers.findIndex(({ available }) => available)
  );
  const [providerIndex, setProviderIndex] = useState(initialProviderIndex);
  const [label, setLabel] = useState("");
  const [field, setField] = useState<Field>("name");
  const promptRef = useRef<TextareaRenderable>(null);
  const provider = providers[providerIndex] ?? null;
  const fields: readonly Field[] = ["name", "provider", "prompt"];

  const submit = (): void => {
    const prompt = promptRef.current?.plainText.trim() ?? "";
    if (
      pending ||
      provider === null ||
      !provider.available ||
      label.trim() === "" ||
      prompt === ""
    ) {
      return;
    }
    onCreate({ provider: provider.id, label: label.trim(), prompt });
  };

  useKeyboard((key) => {
    if (key.name === "escape") {
      key.preventDefault();
      onCancel();
      return;
    }
    if (key.name === "tab") {
      key.preventDefault();
      key.stopPropagation();
      const delta = key.shift ? -1 : 1;
      const current = fields.indexOf(field);
      setField(fields[(current + delta + fields.length) % fields.length] ?? "name");
      return;
    }
    if (key.ctrl && (key.name === "return" || key.name === "enter")) {
      key.preventDefault();
      key.stopPropagation();
      submit();
      return;
    }
    if (
      field === "provider" &&
      providers.length > 0 &&
      ["up", "down", "left", "right"].includes(key.name)
    ) {
      key.preventDefault();
      const delta = key.name === "up" || key.name === "left" ? -1 : 1;
      setProviderIndex((current) => (current + delta + providers.length) % providers.length);
    }
  });

  return (
    <ModalFrame
      title="New worker"
      height={22}
      footer="Tab fields · ←/→ choose · Ctrl+Enter start · Esc cancel"
    >
      <box flexDirection="column" marginBottom={1}>
        <text fg={field === "name" ? palette.accent : palette.muted}>Name</text>
        <input
          focused={field === "name"}
          value={label}
          maxLength={32}
          placeholder="auth tests"
          backgroundColor={palette.background}
          focusedBackgroundColor={palette.panelRaised}
          textColor={palette.text}
          onInput={setLabel}
        />
      </box>
      <box
        flexDirection="column"
        marginBottom={1}
        onMouseDown={() => {
          setField("provider");
        }}
      >
        <text fg={field === "provider" ? palette.accent : palette.muted}>Agent</text>
        <text
          fg={palette.text}
          bg={field === "provider" ? palette.panelRaised : palette.background}
        >
          {field === "provider" ? "‹ " : "  "}
          {provider === null
            ? "No providers found"
            : `${provider.label}${provider.available ? "" : " — unavailable"}`}
          {field === "provider" ? " ›" : ""}
        </text>
      </box>
      <box flexGrow={1} flexDirection="column">
        <text fg={field === "prompt" ? palette.accent : palette.muted}>Task</text>
        <textarea
          ref={promptRef}
          focused={field === "prompt"}
          flexGrow={1}
          placeholder="What should this worker do?"
          backgroundColor={palette.background}
          focusedBackgroundColor={palette.panelRaised}
          textColor={palette.text}
          wrapMode="word"
        />
      </box>
      {provider !== null && !provider.available ? (
        <text fg={palette.danger}>{provider.reason ?? "Provider unavailable."}</text>
      ) : null}
      {error === null ? null : <text fg={palette.danger}>{error}</text>}
      {pending ? <text fg={palette.warning}>Starting worker…</text> : null}
    </ModalFrame>
  );
}
