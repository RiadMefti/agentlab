import { factoryAgentRunRequestSchema, factoryTimestampSchema } from "@agentlab/contracts";

import type {
  FactoryAgentExecutionInput,
  FactoryAgentExecutionOutput,
  FactoryAgentExecutor,
  FactoryAgentExecutorCapability
} from "../../domain/factory-agent-executor.js";
import {
  commandFailureDetails,
  type CommandFailureKind,
  type CommandRunner,
  type RunResult
} from "../process/command-runner.js";
import { claudeFactoryAgentAdapter } from "./claude-factory-agent.js";
import { codexFactoryAgentAdapter } from "./codex-factory-agent.js";
import { emptyFactoryBudgetUsage, type FactoryAgentAdapter } from "./factory-agent-adapter.js";
import { elapsedSeconds } from "./factory-agent-output.js";
import { factoryAgentEnvironment } from "./factory-agent-environment.js";

const maximumPromptBytes = 1024 * 1024;

export interface LocalFactoryAgentExecutorOptions {
  readonly now: () => string;
  readonly adapters?: readonly FactoryAgentAdapter[];
  readonly hostEnvironment?: NodeJS.ProcessEnv;
}

/** Dispatches provider-native non-interactive harnesses behind one bounded execution port. */
export class LocalFactoryAgentExecutor implements FactoryAgentExecutor {
  readonly #runner: CommandRunner;
  readonly #now: () => string;
  readonly #hostEnvironment: NodeJS.ProcessEnv;
  readonly #adapters: ReadonlyMap<string, FactoryAgentAdapter>;

  public constructor(runner: CommandRunner, options: LocalFactoryAgentExecutorOptions) {
    this.#runner = runner;
    this.#now = options.now;
    this.#hostEnvironment = options.hostEnvironment ?? process.env;
    const adapters = options.adapters ?? [codexFactoryAgentAdapter, claudeFactoryAgentAdapter];
    if (new Set(adapters.map(({ id }) => id)).size !== adapters.length) {
      throw new Error("Factory agent adapters must have unique provider IDs.");
    }
    this.#adapters = new Map(adapters.map((adapter) => [adapter.id, adapter]));
  }

  public capabilities(): readonly FactoryAgentExecutorCapability[] {
    return [...this.#adapters.values()].map(({ capability }) => capability);
  }

  public async execute(input: FactoryAgentExecutionInput): Promise<FactoryAgentExecutionOutput> {
    const request = factoryAgentRunRequestSchema.parse(input.request);
    const adapter = this.#adapters.get(request.provider);
    if (adapter === undefined) {
      throw new Error(`Provider ${request.provider} has no autonomous factory adapter.`);
    }
    const promptBytes = Buffer.byteLength(input.prompt, "utf8");
    if (promptBytes !== request.promptArtifact.sizeBytes || promptBytes > maximumPromptBytes) {
      throw new Error("Factory prompt bytes do not match their bounded artifact reference.");
    }
    const invocation = adapter.build(request, input.executable, input.workspace, input.prompt);
    const startedAt = this.#timestamp();
    let result: RunResult;
    try {
      result = await this.#runner.run(invocation.command.executable, invocation.command.args, {
        cwd: input.workspace.root,
        timeoutMs: request.budget.wallClockSeconds * 1_000,
        maxInputBytes: maximumPromptBytes,
        maxBufferBytes: request.budget.maxOutputBytes,
        maxCombinedBufferBytes: request.budget.maxOutputBytes,
        cleanupProcessTree: true,
        stdin: invocation.stdin,
        environment: factoryAgentEnvironment(
          request.provider,
          this.#hostEnvironment,
          invocation.command.environment
        )
      });
    } catch (error: unknown) {
      return failedOutput(
        error,
        input.providerVersion,
        invocation.harnessVersion,
        startedAt,
        this.#timestamp()
      );
    }
    const finishedAt = this.#timestamp();
    try {
      return {
        ...adapter.parse({
          request,
          providerVersion: input.providerVersion,
          harnessVersion: invocation.harnessVersion,
          startedAt,
          finishedAt,
          stdout: result.stdout,
          stderr: result.stderr
        }),
        status: "succeeded",
        exitCode: 0,
        errorCode: null
      };
    } catch {
      return failedOutput(
        new Error("Provider output could not be validated."),
        input.providerVersion,
        invocation.harnessVersion,
        startedAt,
        finishedAt,
        result,
        "provider-output-invalid"
      );
    }
  }

  #timestamp(): string {
    return factoryTimestampSchema.parse(this.#now());
  }
}

function failedOutput(
  error: unknown,
  providerVersion: string,
  harnessVersion: string,
  startedAt: string,
  finishedAt: string,
  knownOutput?: RunResult,
  forcedErrorCode?: string
): FactoryAgentExecutionOutput {
  const details = commandFailureDetails(error);
  const stdout = knownOutput?.stdout ?? outputField(error, "stdout");
  const stderr = knownOutput?.stderr ?? outputField(error, "stderr");
  const usage = emptyFactoryBudgetUsage();
  return {
    status: details?.kind === "timeout" ? "timed-out" : "failed",
    exitCode: details?.exitCode ?? null,
    stdout,
    stderr,
    finalOutput: null,
    providerSessionId: null,
    providerVersion,
    harnessVersion,
    startedAt,
    finishedAt,
    usage: {
      ...usage,
      wallClockSeconds: elapsedSeconds(startedAt, finishedAt),
      processes: 1,
      outputBytes: Buffer.byteLength(stdout) + Buffer.byteLength(stderr)
    },
    usageComplete: false,
    errorCode: forcedErrorCode ?? failureCode(details?.kind ?? null)
  };
}

function outputField(error: unknown, field: "stdout" | "stderr"): string {
  if (typeof error !== "object" || error === null || !(field in error)) return "";
  const value = (error as Record<string, unknown>)[field];
  return typeof value === "string" ? value : "";
}

function failureCode(kind: CommandFailureKind | null): string {
  if (kind === "timeout") return "execution-timeout";
  if (kind === "output-limit") return "output-limit";
  if (kind === "exit") return "provider-exit";
  if (kind === "signal") return "provider-signal";
  if (kind === "spawn") return "provider-spawn";
  return "process-cleanup-failed";
}
