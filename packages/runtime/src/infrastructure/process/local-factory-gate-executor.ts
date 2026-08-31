import { factoryResourceLimitsSchema, factoryTimestampSchema } from "@agentlab/contracts";
import { z } from "zod";

import type {
  FactoryGateDefinition,
  FactoryGateExecutionInput,
  FactoryGateExecutionOutput,
  FactoryGateExecutor,
  FactoryGateSandbox
} from "../../domain/factory-gate.js";
import type { FactoryProcessIsolator } from "../../domain/factory-process-isolation.js";
import { commandFailureDetails, type CommandRunner } from "./command-runner.js";

const gateDefinitionSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[a-z0-9][a-z0-9._/-]*$/u),
    evidenceKind: z.enum(["test", "build", "security", "provenance"]),
    command: z
      .object({
        executable: z.string().min(1).max(4_096).refine(noNull),
        args: z.array(z.string().max(4_096).refine(noNull)).max(128)
      })
      .strict(),
    timeoutMs: z.number().int().min(1).max(3_600_000),
    maximumOutputBytes: z.number().int().min(1).max(1_073_741_824)
  })
  .strict();

export interface LocalFactoryGateExecutorOptions {
  readonly now: () => string;
}

/** Executes only administrator-installed gate definitions through a mandatory sandbox. */
export class LocalFactoryGateExecutor implements FactoryGateExecutor {
  readonly #definitions: ReadonlyMap<string, FactoryGateDefinition>;

  public constructor(
    definitions: readonly FactoryGateDefinition[],
    private readonly sandbox: FactoryGateSandbox,
    private readonly processIsolator: FactoryProcessIsolator,
    private readonly runner: CommandRunner,
    private readonly options: LocalFactoryGateExecutorOptions
  ) {
    const parsed = definitions.map((definition) => gateDefinitionSchema.parse(definition));
    if (new Set(parsed.map(({ id }) => id)).size !== parsed.length) {
      throw new Error("Factory gate definitions must have unique IDs.");
    }
    this.#definitions = new Map(parsed.map((definition) => [definition.id, definition]));
  }

  public availableGateIds(): readonly string[] {
    return [...this.#definitions.keys()].sort();
  }

  public async execute(input: FactoryGateExecutionInput): Promise<FactoryGateExecutionOutput> {
    const definition = this.#definitions.get(input.gateId);
    if (definition === undefined) throw new Error(`Factory gate ${input.gateId} is not installed.`);
    const sandboxedCommand = await this.sandbox.wrap(definition.command, input.workspace);
    const isolated = await this.processIsolator.isolate({
      command: sandboxedCommand,
      isolationId: z.uuid().parse(input.isolationId),
      limits: factoryResourceLimitsSchema.parse(input.resourceLimits)
    });
    const command = isolated.command;
    const startedAt = this.#timestamp();
    try {
      const output = await this.runner.run(command.executable, command.args, {
        cwd: input.workspace.root,
        timeoutMs: definition.timeoutMs,
        maxBufferBytes: definition.maximumOutputBytes,
        maxCombinedBufferBytes: definition.maximumOutputBytes,
        cleanupProcessTree: true,
        environment: {
          PATH: "/usr/bin:/bin",
          LC_ALL: "C",
          ...isolated.controllerEnvironment
        }
      });
      const finishedAt = this.#timestamp();
      return {
        gateId: definition.id,
        evidenceKind: definition.evidenceKind,
        command,
        result: "pass",
        exitCode: 0,
        startedAt,
        finishedAt,
        wallClockSeconds: elapsedSeconds(startedAt, finishedAt),
        outputBytes: Buffer.byteLength(output.stdout) + Buffer.byteLength(output.stderr),
        isolation: isolated.isolation,
        ...output
      };
    } catch (error: unknown) {
      const details = commandFailureDetails(error);
      if (details === null) {
        throw new Error("Factory gate process cleanup could not be confirmed.", { cause: error });
      }
      const finishedAt = this.#timestamp();
      return {
        gateId: definition.id,
        evidenceKind: definition.evidenceKind,
        command,
        result:
          details.kind === "timeout" ? "timed-out" : details.kind === "exit" ? "fail" : "error",
        exitCode: details.exitCode,
        startedAt,
        finishedAt,
        wallClockSeconds: elapsedSeconds(startedAt, finishedAt),
        isolation: isolated.isolation,
        ...failureOutput(error)
      };
    }
  }

  #timestamp(): string {
    return factoryTimestampSchema.parse(this.options.now());
  }
}

function elapsedSeconds(startedAt: string, finishedAt: string): number {
  const milliseconds = Date.parse(finishedAt) - Date.parse(startedAt);
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return 0;
  return Math.ceil(milliseconds / 1_000);
}

function noNull(value: string): boolean {
  return !value.includes("\0");
}

function outputField(error: unknown, field: "stdout" | "stderr"): string {
  if (typeof error !== "object" || error === null || !(field in error)) return "";
  const value = (error as Record<string, unknown>)[field];
  return typeof value === "string" ? value : "";
}

function failureOutput(error: unknown): {
  readonly stdout: string;
  readonly stderr: string;
  readonly outputBytes: number;
} {
  const stdout = outputField(error, "stdout");
  const stderr = outputField(error, "stderr");
  return {
    stdout,
    stderr,
    outputBytes: Buffer.byteLength(stdout) + Buffer.byteLength(stderr)
  };
}
