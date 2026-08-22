import { useEffect, useState } from "react";

import type { AvailableUpdate, DesktopUpdateApi } from "@orchestrator/contracts";

const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1_000;

interface UpdateButtonProps {
  readonly updates?: DesktopUpdateApi;
}

type UpdatePhase = "available" | "downloading" | "failed" | "ready" | "restarting";

export function UpdateButton({ updates = window.orchestratorUpdates }: UpdateButtonProps = {}) {
  const [available, setAvailable] = useState<AvailableUpdate | null>(null);
  const [phase, setPhase] = useState<UpdatePhase>("available");

  useEffect(() => {
    if (updates === undefined) return;
    let active = true;

    const check = async () => {
      try {
        const result = await updates.checkForUpdate();
        if (active) {
          setAvailable(result);
          setPhase("available");
        }
      } catch {
        if (active) setAvailable(null);
      }
    };

    void check();
    const interval = window.setInterval(() => {
      void check();
    }, CHECK_INTERVAL_MS);

    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [updates]);

  if (available === null || updates === undefined) return null;

  const manual = available.installation === "manual";
  const label = updateLabel(available.version, manual, phase);
  const text = updateText(available.version, phase);

  const runUpdate = async () => {
    if (manual) {
      await updates.openLatestRelease();
      return;
    }
    if (phase === "ready") {
      setPhase("restarting");
      try {
        await updates.restartToUpdate();
      } catch {
        setPhase("ready");
      }
      return;
    }
    if (phase === "downloading" || phase === "restarting") return;

    setPhase("downloading");
    try {
      await updates.downloadUpdate();
      setPhase("ready");
    } catch {
      setPhase("failed");
    }
  };

  return (
    <button
      className="update-action"
      type="button"
      aria-label={label}
      disabled={phase === "downloading" || phase === "restarting"}
      title={label}
      onClick={() => {
        void runUpdate().catch(() => undefined);
      }}
    >
      {text}
    </button>
  );
}

function updateLabel(version: string, manual: boolean, phase: UpdatePhase): string {
  if (manual) return `Download Orchestrator v${version} from GitHub`;
  if (phase === "downloading") return `Downloading Orchestrator v${version}`;
  if (phase === "ready") return `Restart to install Orchestrator v${version}`;
  if (phase === "restarting") return `Restarting into Orchestrator v${version}`;
  if (phase === "failed") return `Retry downloading Orchestrator v${version}`;
  return `Download Orchestrator v${version} in the app`;
}

function updateText(version: string, phase: UpdatePhase): string {
  if (phase === "downloading") return `downloading v${version}…`;
  if (phase === "ready") return "restart to update";
  if (phase === "restarting") return "restarting…";
  if (phase === "failed") return "retry update";
  return `update v${version}`;
}
