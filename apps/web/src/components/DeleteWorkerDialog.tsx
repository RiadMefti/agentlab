import { useEffect } from "react";

import type { AgentSession } from "@orchestrator/contracts";

interface DeleteWorkerDialogProps {
  readonly worker: AgentSession;
  readonly pending: boolean;
  readonly error: string | null;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}

export function DeleteWorkerDialog({
  worker,
  pending,
  error,
  onCancel,
  onConfirm
}: DeleteWorkerDialogProps) {
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
        aria-labelledby="delete-worker-title"
        aria-describedby="delete-worker-description"
        onMouseDown={(event) => {
          event.stopPropagation();
        }}
      >
        <header className="dialog-header">
          <h2 id="delete-worker-title">Delete {worker.label}?</h2>
        </header>
        <p id="delete-worker-description" className="confirmation-copy">
          This stops the agent and removes its session.
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
            {pending ? "Deleting…" : "Delete agent"}
          </button>
        </div>
      </section>
    </div>
  );
}
