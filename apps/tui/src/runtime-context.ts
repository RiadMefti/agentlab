import { createContext, useContext } from "react";

import type { LocalOrchestratorRuntime } from "@orchestrator/runtime";

export const RuntimeContext = createContext<LocalOrchestratorRuntime | null>(null);

export function useRuntime(): LocalOrchestratorRuntime {
  const runtime = useContext(RuntimeContext);
  if (runtime === null) throw new Error("Local orchestrator runtime is not available.");
  return runtime;
}
