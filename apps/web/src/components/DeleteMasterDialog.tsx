import { useEffect } from "react";

import type { Conversation } from "@orchestrator/contracts";

interface DeleteMasterDialogProps {
  readonly master: Conversation;
  readonly pending: boolean;
  readonly error: string | null;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}

export function DeleteMasterDialog({
  master,
  pending,
  error,
  onCancel,
  onConfirm
}: DeleteMasterDialogProps) {
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [onCancel]);

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={onCancel}>
      <section
        className="dialog confirmation-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="delete-master-title"
        aria-describedby="delete-master-description"
        onMouseDown={(event) => {
          event.stopPropagation();
        }}
      >
        <header className="dialog-header">
          <h2 id="delete-master-title">Delete {master.title}?</h2>
        </header>
        <p id="delete-master-description" className="confirmation-copy">
          This stops its captain and every agent, then removes the conversation.
        </p>
        {error === null ? null : <p className="form-error">{error}</p>}
        <div className="dialog-actions confirmation-actions">
          <button
            autoFocus
            type="button"
            className="quiet-action"
            disabled={pending}
            onClick={onCancel}
          >
            Cancel
          </button>
          <button type="button" className="danger-action" disabled={pending} onClick={onConfirm}>
            {pending ? "Deleting…" : "Delete master"}
          </button>
        </div>
      </section>
    </div>
  );
}
