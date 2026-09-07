import type {
  FactoryBudget,
  FactoryBudgetUsage,
  FactoryEvalGraderRequest,
  FactoryEvalGraderResponse,
  FactoryEvalSubjectRequest,
  FactoryEvalSubjectResponse,
  FactoryProcessIsolation,
  FactoryResourceLimits,
  Sha256Digest
} from "@agentlab/contracts";

import type { CommandSpec } from "./command.js";

export interface FactoryEvalExecutableBinding {
  readonly descriptorDigest: Sha256Digest;
  readonly executable: string;
  readonly executableDigest: Sha256Digest;
  readonly version: string;
}

export interface FactoryEvalHarnessExecutionOutput<Response> {
  readonly status: "succeeded" | "failed" | "timed-out" | "error";
  readonly response: Response | null;
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;
  readonly output: Uint8Array | null;
  readonly trace: Uint8Array | null;
  readonly graderEvidence: Uint8Array | null;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly latencyMilliseconds: number;
  readonly isolation: FactoryProcessIsolation;
  readonly errorCode: string | null;
}

export interface FactoryEvalSubjectExecutionInput {
  readonly request: FactoryEvalSubjectRequest;
  readonly requestJson: string;
  readonly binding: FactoryEvalExecutableBinding;
  readonly fixture: Uint8Array;
  readonly budget: FactoryBudget;
  readonly resourceLimits: FactoryResourceLimits;
  readonly deadlineAt: string;
  readonly maximumOutputBytes: number;
  readonly maximumTraceBytes: number;
}

export interface FactoryEvalGraderExecutionInput {
  readonly request: FactoryEvalGraderRequest;
  readonly requestJson: string;
  readonly binding: FactoryEvalExecutableBinding;
  readonly fixture: Uint8Array;
  readonly baselineOutput: Uint8Array;
  readonly baselineTrace: Uint8Array;
  readonly challengerOutput: Uint8Array;
  readonly challengerTrace: Uint8Array;
  readonly budget: FactoryBudget;
  readonly resourceLimits: FactoryResourceLimits;
  readonly deadlineAt: string;
  readonly maximumEvidenceBytes: number;
}

export interface FactoryEvalHarnessExecutor {
  executeSubject(
    input: FactoryEvalSubjectExecutionInput
  ): Promise<FactoryEvalHarnessExecutionOutput<FactoryEvalSubjectResponse>>;
  executeGrader(
    input: FactoryEvalGraderExecutionInput
  ): Promise<FactoryEvalHarnessExecutionOutput<FactoryEvalGraderResponse>>;
}

export interface FactoryEvalExecutableResolver {
  resolve(descriptorDigest: Sha256Digest): Promise<FactoryEvalExecutableBinding | null>;
}

export interface FactoryEvalSandbox {
  wrap(command: CommandSpec, workspace: string): Promise<CommandSpec>;
}

export interface FactoryEvalProcessRecovery {
  state(executionId: string): Promise<"active" | "inactive" | "uncertain">;
}

/** The launched process tree may still exist; callers must preserve the active journal checkpoint. */
export class FactoryEvalProcessCleanupUncertainError extends Error {}

export function emptyFactoryEvalUsage(): FactoryBudgetUsage {
  return {
    wallClockSeconds: 0,
    agentTurns: 0,
    toolCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    costMicrousd: 0,
    processes: 0,
    outputBytes: 0,
    workers: 1,
    repairAttempts: 0,
    changedFiles: 0,
    changedLines: 0
  };
}
