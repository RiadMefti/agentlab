import type { DesktopUpdateApi } from "@orchestrator/contracts";

declare global {
  interface Window {
    readonly orchestratorUpdates?: DesktopUpdateApi;
  }
}

export {};
