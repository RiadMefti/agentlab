import type { FactoryProcessIsolation, FactoryResourceLimits } from "@agentlab/contracts";

import type { CommandSpec } from "./command.js";

export interface IsolateFactoryProcessInput {
  readonly command: CommandSpec;
  readonly isolationId: string;
  readonly limits: FactoryResourceLimits;
}

export interface IsolatedFactoryProcess {
  readonly command: CommandSpec;
  readonly controllerEnvironment: Readonly<Record<string, string>>;
  readonly isolation: FactoryProcessIsolation;
}

/** Applies an OS-enforced whole-process-tree resource boundary before a command may start. */
export interface FactoryProcessIsolator {
  isolate(input: IsolateFactoryProcessInput): Promise<IsolatedFactoryProcess>;
}

export function narrowFactoryResourceLimits(
  profile: FactoryResourceLimits,
  maximumProcesses: number
): FactoryResourceLimits {
  return {
    ...profile,
    maxProcesses: Math.min(profile.maxProcesses, maximumProcesses)
  };
}
