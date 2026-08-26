import { createContext, useContext } from "react";

import type { LocalAgentLabRuntime } from "@agentlab/runtime";

export const RuntimeContext = createContext<LocalAgentLabRuntime | null>(null);

export function useRuntime(): LocalAgentLabRuntime {
  const runtime = useContext(RuntimeContext);
  if (runtime === null) throw new Error("Local agentlab runtime is not available.");
  return runtime;
}
