import { constants, type BigIntStats } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, open, realpath, rm } from "node:fs/promises";
import { join, parse, resolve } from "node:path";

import {
  factoryEvalGraderResponseSchema,
  factoryEvalSubjectResponseSchema,
  factoryTimestampSchema,
  type FactoryBudget,
  type FactoryEvalGraderResponse,
  type FactoryEvalSubjectResponse
} from "@agentlab/contracts";

import type {
  FactoryEvalGraderExecutionInput,
  FactoryEvalHarnessExecutionOutput,
  FactoryEvalHarnessExecutor,
  FactoryEvalSandbox,
  FactoryEvalSubjectExecutionInput
} from "../../domain/factory-eval-harness.js";
import { FactoryEvalProcessCleanupUncertainError } from "../../domain/factory-eval-harness.js";
import { assertUsageWithinBudget } from "../../domain/factory-eval-production-integrity.js";
import type { FactoryProcessIsolator } from "../../domain/factory-process-isolation.js";
import { pinnedLocalExecutableDigest } from "../filesystem/pinned-local-executable.js";
import { commandFailureDetails, type CommandRunner } from "./command-runner.js";

const maximumControlOutputBytes = 4 * 1_024 * 1_024;
const maximumInputBytes = 4 * 1_024 * 1_024;

export interface LocalFactoryEvalHarnessExecutorOptions {
  readonly workspaceRoot: string;
  readonly now: () => string;
}

/** Runs strict subject/grader protocols in isolated offline sandboxes with no inherited secrets. */
export class LocalFactoryEvalHarnessExecutor implements FactoryEvalHarnessExecutor {
  readonly #workspaceRoot: string;

  public constructor(
    private readonly runner: CommandRunner,
    private readonly sandbox: FactoryEvalSandbox,
    private readonly processIsolator: FactoryProcessIsolator,
    private readonly options: LocalFactoryEvalHarnessExecutorOptions
  ) {
    const root = resolve(options.workspaceRoot);
    if (root === parse(root).root || root.includes("\0")) {
      throw new Error("Eval sandbox workspace root must be a dedicated safe path.");
    }
    this.#workspaceRoot = root;
  }

  public executeSubject(
    input: FactoryEvalSubjectExecutionInput
  ): Promise<FactoryEvalHarnessExecutionOutput<FactoryEvalSubjectResponse>> {
    return this.#execute({
      mode: "subject",
      input,
      files: [{ name: "fixture", content: input.fixture }],
      responseSchema: factoryEvalSubjectResponseSchema,
      outputLimits: { output: input.maximumOutputBytes, trace: input.maximumTraceBytes }
    });
  }

  public executeGrader(
    input: FactoryEvalGraderExecutionInput
  ): Promise<FactoryEvalHarnessExecutionOutput<FactoryEvalGraderResponse>> {
    return this.#execute({
      mode: "grade",
      input,
      files: [
        { name: "fixture", content: input.fixture },
        { name: "baseline-output", content: input.baselineOutput },
        { name: "baseline-trace", content: input.baselineTrace },
        { name: "challenger-output", content: input.challengerOutput },
        { name: "challenger-trace", content: input.challengerTrace }
      ],
      responseSchema: factoryEvalGraderResponseSchema,
      outputLimits: { "grader-evidence": input.maximumEvidenceBytes }
    });
  }

  async #execute<Response>(
    operation: EvalOperation<Response>
  ): Promise<FactoryEvalHarnessExecutionOutput<Response>> {
    const requestBytes = Buffer.byteLength(operation.input.requestJson, "utf8");
    if (requestBytes < 2 || requestBytes > maximumInputBytes) {
      throw new Error("Eval harness request exceeds its strict control-input bound.");
    }
    const workspace = await this.#createWorkspace();
    let failure: unknown = null;
    try {
      await Promise.all(
        operation.files.map((file) => writeExclusive(join(workspace, file.name), file.content))
      );
      const sandboxed = await this.sandbox.wrap(
        { executable: operation.input.binding.executable, args: [operation.mode] },
        workspace
      );
      const isolated = await this.processIsolator.isolate({
        command: sandboxed,
        isolationId: operation.input.request.executionId,
        limits: operation.input.resourceLimits
      });
      const startedAt = this.#timestamp();
      const deadlineTimeout = Date.parse(operation.input.deadlineAt) - Date.parse(startedAt);
      if (!Number.isSafeInteger(deadlineTimeout) || deadlineTimeout < 1) {
        throw new Error("Eval harness deadline expired before process launch.");
      }
      let result;
      try {
        const controlOutputLimit = Math.min(
          maximumControlOutputBytes,
          operation.input.budget.maxOutputBytes
        );
        result = await this.runner.run(isolated.command.executable, isolated.command.args, {
          cwd: workspace,
          timeoutMs: Math.min(operation.input.budget.wallClockSeconds * 1_000, deadlineTimeout),
          maxInputBytes: maximumInputBytes,
          maxBufferBytes: controlOutputLimit,
          maxCombinedBufferBytes: controlOutputLimit,
          cleanupProcessTree: true,
          stdin: operation.input.requestJson,
          environment: {
            CI: "true",
            LC_ALL: "C",
            PATH: "/usr/bin:/bin",
            ...isolated.controllerEnvironment
          }
        });
      } catch (error: unknown) {
        const details = commandFailureDetails(error);
        if (details === null) {
          throw new FactoryEvalProcessCleanupUncertainError(
            "Eval harness process cleanup could not be confirmed.",
            { cause: error }
          );
        }
        const finishedAt = this.#timestamp();
        return {
          status:
            details.kind === "timeout" ? "timed-out" : details.kind === "exit" ? "failed" : "error",
          response: null,
          stdout: Buffer.from(outputField(error, "stdout"), "utf8"),
          stderr: Buffer.from(outputField(error, "stderr"), "utf8"),
          output: null,
          trace: null,
          graderEvidence: null,
          startedAt,
          finishedAt,
          latencyMilliseconds: elapsedMilliseconds(startedAt, finishedAt),
          isolation: isolated.isolation,
          errorCode: details.kind === "timeout" ? "execution-timeout" : `execution-${details.kind}`
        };
      }
      const finishedAt = this.#timestamp();
      if (finishedAt > operation.input.deadlineAt) {
        throw new Error("Eval harness completed after its immutable job deadline.");
      }
      await this.#assertExecutableStable(operation.input.binding);
      const response = operation.responseSchema.parse(parseJson(result.stdout));
      const latencyMilliseconds = elapsedMilliseconds(startedAt, finishedAt);
      const files = await readOutputs(workspace, operation.outputLimits, responseStatus(response));
      assertReportedUsage(
        responseUsage(response),
        operation.input.budget,
        latencyMilliseconds,
        Buffer.byteLength(result.stdout) +
          Buffer.byteLength(result.stderr) +
          Object.values(files).reduce((sum, value) => sum + (value?.byteLength ?? 0), 0)
      );
      return {
        status: responseStatus(response) === "succeeded" ? "succeeded" : "failed",
        response,
        stdout: Buffer.from(result.stdout, "utf8"),
        stderr: Buffer.from(result.stderr, "utf8"),
        output: files.output ?? null,
        trace: files.trace ?? null,
        graderEvidence: files["grader-evidence"] ?? null,
        startedAt,
        finishedAt,
        latencyMilliseconds,
        isolation: isolated.isolation,
        errorCode: responseReason(response)
      };
    } catch (error: unknown) {
      failure = error;
      throw error;
    } finally {
      if (!(failure instanceof FactoryEvalProcessCleanupUncertainError)) {
        await removeWorkspace(workspace);
      }
    }
  }

  async #createWorkspace(): Promise<string> {
    await mkdir(this.#workspaceRoot, { mode: 0o700, recursive: true });
    await chmod(this.#workspaceRoot, 0o700);
    const root = await realpath(this.#workspaceRoot);
    if (root !== this.#workspaceRoot) throw new Error("Eval workspace root is not canonical.");
    return mkdtemp(join(root, "invocation-"));
  }

  async #assertExecutableStable(
    binding: FactoryEvalSubjectExecutionInput["binding"]
  ): Promise<void> {
    const digest = await pinnedLocalExecutableDigest(binding.executable, "Factory eval executable");
    if (digest !== binding.executableDigest) {
      throw new Error("Factory eval executable changed during execution.");
    }
  }

  #timestamp(): string {
    return factoryTimestampSchema.parse(this.options.now());
  }
}

interface CommonEvalInput {
  readonly request: { readonly executionId: string };
  readonly requestJson: string;
  readonly binding: FactoryEvalSubjectExecutionInput["binding"];
  readonly budget: FactoryBudget;
  readonly resourceLimits: FactoryEvalSubjectExecutionInput["resourceLimits"];
  readonly deadlineAt: string;
}

interface EvalOperation<Response> {
  readonly mode: "subject" | "grade";
  readonly input: CommonEvalInput;
  readonly files: readonly { readonly name: string; readonly content: Uint8Array }[];
  readonly responseSchema: { parse(input: unknown): Response };
  readonly outputLimits: Readonly<Record<string, number>>;
}

async function writeExclusive(path: string, content: Uint8Array): Promise<void> {
  const handle = await open(
    path,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600
  );
  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function readOutputs(
  workspace: string,
  limits: Readonly<Record<string, number>>,
  status: string
): Promise<Record<string, Uint8Array | undefined>> {
  if (status !== "succeeded") return {};
  const output: Record<string, Uint8Array | undefined> = {};
  for (const [name, limit] of Object.entries(limits)) {
    output[name] = await readStableFile(join(workspace, name), limit);
  }
  return output;
}

async function readStableFile(path: string, maximumBytes: number): Promise<Uint8Array> {
  const before = await lstat(path, { bigint: true });
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1n ||
    before.size > BigInt(maximumBytes) ||
    (before.mode & 0o077n) !== 0n ||
    (await realpath(path)) !== path
  ) {
    throw new Error("Eval harness output is not a bounded private regular file.");
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat({ bigint: true });
    if (!sameFile(before, opened)) throw new Error("Eval harness output changed while opened.");
    const content = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (!sameFile(opened, after) || BigInt(content.byteLength) !== after.size) {
      throw new Error("Eval harness output changed while read.");
    }
    return content;
  } finally {
    await handle.close();
  }
}

async function removeWorkspace(workspace: string): Promise<void> {
  const canonical = await realpath(workspace);
  if (canonical !== workspace || !workspace.includes("/invocation-")) {
    throw new Error("Eval sandbox workspace cleanup target is not exact.");
  }
  await rm(workspace, { recursive: true, force: false, maxRetries: 2, retryDelay: 10 });
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch (error: unknown) {
    throw new Error("Eval harness control output is not valid JSON.", { cause: error });
  }
}

function assertReportedUsage(
  usage: FactoryEvalSubjectResponse["usage"],
  budget: FactoryBudget,
  latencyMilliseconds: number,
  observedOutputBytes: number
): void {
  assertUsageWithinBudget(usage, budget, "Eval harness invocation");
  if (
    usage.processes < 1 ||
    usage.wallClockSeconds < Math.ceil(latencyMilliseconds / 1_000) ||
    usage.outputBytes < observedOutputBytes
  ) {
    throw new Error("Eval harness usage does not cover observed process consumption.");
  }
}

function responseStatus(response: unknown): string {
  return (response as { readonly status: string }).status;
}

function responseUsage(response: unknown): FactoryEvalSubjectResponse["usage"] {
  return (response as { readonly usage: FactoryEvalSubjectResponse["usage"] }).usage;
}

function responseReason(response: unknown): string | null {
  return (response as { readonly reasonCode: string | null }).reasonCode;
}

function elapsedMilliseconds(startedAt: string, finishedAt: string): number {
  const value = Date.parse(finishedAt) - Date.parse(startedAt);
  if (!Number.isSafeInteger(value) || value < 1 || value > 86_400_000) {
    throw new Error("Eval harness elapsed time is invalid.");
  }
  return value;
}

function outputField(error: unknown, field: "stdout" | "stderr"): string {
  if (typeof error !== "object" || error === null || !(field in error)) return "";
  const value = (error as Record<string, unknown>)[field];
  return typeof value === "string" ? value : "";
}

function sameFile(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}
