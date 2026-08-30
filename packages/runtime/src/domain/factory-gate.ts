import type { EvidenceKind } from "@agentlab/contracts";

import type { CommandSpec } from "./command.js";
import type { FactoryWorkspace } from "./factory-workspace.js";

export interface FactoryGateDefinition {
  readonly id: string;
  readonly evidenceKind: Extract<EvidenceKind, "test" | "build" | "security" | "provenance">;
  readonly command: CommandSpec;
  readonly timeoutMs: number;
  readonly maximumOutputBytes: number;
}

export interface FactoryGateExecutionInput {
  readonly gateId: string;
  readonly workspace: FactoryWorkspace;
}

export interface FactoryGateExecutionOutput {
  readonly gateId: string;
  readonly evidenceKind: FactoryGateDefinition["evidenceKind"];
  readonly command: CommandSpec;
  readonly result: "pass" | "fail" | "error" | "timed-out";
  readonly exitCode: number | null;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly wallClockSeconds: number;
  readonly outputBytes: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface FactoryGateExecutor {
  availableGateIds(): readonly string[];
  execute(input: FactoryGateExecutionInput): Promise<FactoryGateExecutionOutput>;
}

export interface FactoryGateSandbox {
  wrap(command: CommandSpec, workspace: FactoryWorkspace): Promise<CommandSpec>;
}
