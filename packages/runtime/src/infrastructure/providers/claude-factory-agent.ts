import type { FactoryWorkspace } from "../../domain/factory-workspace.js";
import {
  emptyFactoryBudgetUsage,
  isFactoryPreparationRunRequest,
  parseFactoryProviderRunRequest,
  type FactoryAgentAdapter,
  type FactoryAgentCommand,
  type FactoryAgentParseInput,
  type FactoryProviderRunRequest
} from "./factory-agent-adapter.js";
import {
  assertFactoryExecutable,
  elapsedSeconds,
  nonnegativeIntegerOrNull,
  objectValue,
  parseProviderJsonLines
} from "./factory-agent-output.js";

export const claudeFactoryAgentAdapter: FactoryAgentAdapter = {
  id: "claude",
  capability: {
    provider: "claude",
    roles: ["reviewer"],
    preparationPhases: ["qualify", "specify", "plan"],
    maximumToolFilesystemAccess: "read-only",
    toolNetwork: "off",
    acceptsCommandAllowlist: false,
    acceptsSecrets: false
  },
  build(requestInput, executable, workspace, prompt) {
    const request = parseFactoryProviderRunRequest(requestInput);
    assertClaudeRequest(request, workspace);
    assertFactoryExecutable(executable);
    const args = [
      "--print",
      "--bare",
      "--output-format",
      "stream-json",
      "--verbose",
      "--no-session-persistence",
      "--safe-mode",
      "--restricted",
      "--strict-mcp-config",
      "--mcp-config",
      '{"mcpServers":{}}',
      "--no-chrome",
      "--disable-slash-commands",
      "--prompt-suggestions",
      "false",
      "--permission-mode",
      "dontAsk",
      "--tools",
      "Read,Glob,Grep"
    ];
    args.push("--session-id", request.executionId);
    args.push("--max-budget-usd", String(request.budget.maxCostMicrousd / 1_000_000));
    if (request.reasoning !== null) args.push("--effort", request.reasoning);
    if (request.model !== null) args.push("--model", request.model);
    return {
      command: { executable, args },
      stdin: prompt,
      harnessVersion: "claude-restricted-review-jsonl-v1"
    } satisfies FactoryAgentCommand;
  },
  parse(input) {
    return parseClaudeOutput(input);
  }
};

function assertClaudeRequest(
  request: FactoryProviderRunRequest,
  workspace: FactoryWorkspace
): void {
  if (
    request.provider !== "claude" ||
    (!isFactoryPreparationRunRequest(request) && request.role !== "reviewer")
  ) {
    throw new Error("Claude factory adapter supports read-only review and preparation only.");
  }
  if (
    request.taskId !== workspace.taskId ||
    request.attempt !== workspace.attempt ||
    request.repository.baseRevision !== workspace.baseRevision
  ) {
    throw new Error("Claude run does not match its exact factory workspace.");
  }
  if (
    request.capabilities.filesystem !== "read" ||
    request.capabilities.git !== "read" ||
    request.capabilities.remoteRepository !== "none" ||
    request.capabilities.process !== "none" ||
    request.capabilities.network.mode !== "off" ||
    request.capabilities.commandAllowlist.length > 0 ||
    request.capabilities.secretRefs.length > 0
  ) {
    throw new Error("Claude review adapter cannot enforce the requested capabilities.");
  }
}

function parseClaudeOutput(input: FactoryAgentParseInput) {
  const events = parseProviderJsonLines(input.stdout, "Claude");
  const result = [...events].reverse().find((event) => event.type === "result");
  if (result === undefined) throw new Error("Claude returned no terminal result event.");
  if (result.subtype !== "success" || result.is_error !== false) {
    throw new Error("Claude terminal result reported an error.");
  }
  const tokenUsage = claudeTokenUsage(result.modelUsage);
  const agentTurns = nonnegativeIntegerOrNull(result.num_turns);
  const cost = typeof result.total_cost_usd === "number" ? result.total_cost_usd : null;
  const costBasisTrusted = tokenUsage?.costBasisTrusted === true;
  const reportedCostMicrousd =
    cost === null ||
    !Number.isFinite(cost) ||
    cost < 0 ||
    cost * 1_000_000 > Number.MAX_SAFE_INTEGER ||
    !costBasisTrusted
      ? null
      : Math.ceil(cost * 1_000_000);
  const tools = claudeToolUsage(events, agentTurns);
  const usage = emptyFactoryBudgetUsage();
  return {
    providerVersion: input.providerVersion,
    harnessVersion: input.harnessVersion,
    providerSessionId: typeof result.session_id === "string" ? result.session_id : null,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    stdout: input.stdout,
    stderr: input.stderr,
    finalOutput: typeof result.result === "string" ? result.result : null,
    usage: {
      ...usage,
      wallClockSeconds: elapsedSeconds(input.startedAt, input.finishedAt),
      agentTurns: agentTurns ?? 0,
      toolCalls: tools.count,
      inputTokens: tokenUsage?.inputTokens ?? 0,
      outputTokens: tokenUsage?.outputTokens ?? 0,
      processes: 1,
      outputBytes: Buffer.byteLength(input.stdout) + Buffer.byteLength(input.stderr)
    },
    usageMeasurementsComplete: tokenUsage !== null && agentTurns !== null && tools.complete,
    reportedCostMicrousd
  };
}

interface ClaudeTokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costBasisTrusted: boolean;
}

function claudeTokenUsage(input: unknown): ClaudeTokenUsage | null {
  const models = objectValue(input);
  if (models === null || Object.keys(models).length === 0) return null;
  let inputTokens = 0;
  let outputTokens = 0;
  let costBasisTrusted = true;
  for (const value of Object.values(models)) {
    const usage = objectValue(value);
    const directInput = nonnegativeIntegerOrNull(usage?.inputTokens);
    const cacheRead = nonnegativeIntegerOrNull(usage?.cacheReadInputTokens);
    const cacheCreation = nonnegativeIntegerOrNull(usage?.cacheCreationInputTokens);
    const directOutput = nonnegativeIntegerOrNull(usage?.outputTokens);
    if (
      directInput === null ||
      cacheRead === null ||
      cacheCreation === null ||
      directOutput === null
    ) {
      return null;
    }
    inputTokens = safeCounterSum(inputTokens, directInput, cacheRead, cacheCreation);
    outputTokens = safeCounterSum(outputTokens, directOutput);
    if (usage?.costBasis === "unknown") costBasisTrusted = false;
  }
  return { inputTokens, outputTokens, costBasisTrusted };
}

function claudeToolUsage(
  events: readonly Record<string, unknown>[],
  agentTurns: number | null
): { readonly count: number; readonly complete: boolean } {
  let assistantEvents = 0;
  let count = 0;
  for (const event of events) {
    if (event.type !== "assistant") continue;
    assistantEvents += 1;
    const message = objectValue(event.message);
    if (!Array.isArray(message?.content)) return { count, complete: false };
    for (const value of message.content) {
      const block = objectValue(value);
      if (typeof block?.type !== "string") return { count, complete: false };
      if (block.type === "tool_use") count += 1;
    }
  }
  return { count, complete: agentTurns === 0 || assistantEvents > 0 };
}

function safeCounterSum(...values: readonly number[]): number {
  const sum = values.reduce((total, value) => total + value, 0);
  if (!Number.isSafeInteger(sum)) throw new Error("Claude usage counter overflowed.");
  return sum;
}

export { parseClaudeOutput };
