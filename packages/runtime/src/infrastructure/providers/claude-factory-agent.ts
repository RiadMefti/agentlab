import { factoryAgentRunRequestSchema, type FactoryAgentRunRequest } from "@agentlab/contracts";

import type { FactoryWorkspace } from "../../domain/factory-workspace.js";
import {
  emptyFactoryBudgetUsage,
  type FactoryAgentAdapter,
  type FactoryAgentCommand,
  type FactoryAgentParseInput
} from "./factory-agent-adapter.js";
import {
  assertFactoryExecutable,
  elapsedSeconds,
  nonnegativeInteger,
  objectValue,
  parseProviderJsonLines
} from "./factory-agent-output.js";

export const claudeFactoryAgentAdapter: FactoryAgentAdapter = {
  id: "claude",
  capability: {
    provider: "claude",
    roles: ["reviewer"],
    maximumToolFilesystemAccess: "read-only",
    toolNetwork: "off",
    acceptsCommandAllowlist: false,
    acceptsSecrets: false
  },
  build(requestInput, executable, workspace, prompt) {
    const request = factoryAgentRunRequestSchema.parse(requestInput);
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

function assertClaudeRequest(request: FactoryAgentRunRequest, workspace: FactoryWorkspace): void {
  if (request.provider !== "claude" || request.role !== "reviewer") {
    throw new Error("Claude factory adapter currently supports read-only review only.");
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
  if (result.is_error === true) throw new Error("Claude terminal result reported an error.");
  const usageValue = objectValue(result.usage);
  const inputTokens = nonnegativeInteger(usageValue?.input_tokens);
  const outputTokens = nonnegativeInteger(usageValue?.output_tokens);
  const cost = typeof result.total_cost_usd === "number" ? result.total_cost_usd : null;
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
      agentTurns: 1,
      inputTokens,
      outputTokens,
      costMicrousd:
        cost === null || !Number.isFinite(cost) || cost < 0 ? 0 : Math.round(cost * 1_000_000),
      processes: 1,
      outputBytes: Buffer.byteLength(input.stdout) + Buffer.byteLength(input.stderr)
    },
    usageComplete: cost !== null && inputTokens > 0 && outputTokens > 0
  };
}

export { parseClaudeOutput };
