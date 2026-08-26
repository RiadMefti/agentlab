import { useKeyboard } from "@opentui/react";

import { palette } from "../theme.js";
import { ModalFrame } from "./modal-frame.js";

export function ConfirmDeleteModal({
  title,
  message,
  pending,
  error,
  onCancel,
  onConfirm
}: {
  readonly title: string;
  readonly message: string;
  readonly pending: boolean;
  readonly error: string | null;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}) {
  useKeyboard((key) => {
    if (key.name === "escape" || key.name === "n") {
      key.preventDefault();
      if (!pending) onCancel();
    } else if (key.name === "y" || key.name === "return" || key.name === "enter") {
      key.preventDefault();
      if (!pending) onConfirm();
    }
  });

  return (
    <ModalFrame title={title} height={11} width={62} footer="Y/Enter confirm · N/Esc cancel">
      <box flexGrow={1} flexDirection="column" justifyContent="center" paddingX={1}>
        <text fg={palette.text}>{message}</text>
        {error === null ? null : <text fg={palette.danger}>{error}</text>}
        {pending ? <text fg={palette.warning}>Deleting…</text> : null}
      </box>
    </ModalFrame>
  );
}
