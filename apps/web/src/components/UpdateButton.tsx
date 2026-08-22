import { useEffect, useState } from "react";

import type { AvailableUpdate, DesktopUpdateApi } from "@orchestrator/contracts";

const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1_000;

interface UpdateButtonProps {
  readonly updates?: DesktopUpdateApi;
}

export function UpdateButton({ updates = window.orchestratorUpdates }: UpdateButtonProps = {}) {
  const [available, setAvailable] = useState<AvailableUpdate | null>(null);

  useEffect(() => {
    if (updates === undefined) return;
    let active = true;

    const check = async () => {
      try {
        const result = await updates.checkForUpdate();
        if (active) setAvailable(result);
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

  const label = `Download Orchestrator v${available.version} from GitHub`;
  return (
    <button
      className="update-action"
      type="button"
      aria-label={label}
      title={label}
      onClick={() => {
        void updates.openLatestRelease().catch(() => undefined);
      }}
    >
      update v{available.version}
    </button>
  );
}
