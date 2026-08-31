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
  nonnegativeInteger,
  objectValue,
  parseProviderJsonLines
} from "./factory-agent-output.js";

export const codexFactoryAgentAdapter: FactoryAgentAdapter = {
  id: "codex",
  capability: {
    provider: "codex",
    roles: ["implementer", "repairer", "reviewer"],
    preparationPhases: ["qualify", "specify", "plan"],
    maximumToolFilesystemAccess: "workspace-write",
    toolNetwork: "off",
    acceptsCommandAllowlist: false,
    acceptsSecrets: false
  },
  build(requestInput, executable, workspace, prompt) {
    const request = parseFactoryProviderRunRequest(requestInput);
    assertCodexRequest(request, workspace);
    assertFactoryExecutable(executable);
    const sandbox =
      isFactoryPreparationRunRequest(request) || request.role === "reviewer"
        ? "read-only"
        : "workspace-write";
    const args = [
      "--ask-for-approval",
      "never",
      "exec",
      "--ignore-user-config",
      "--strict-config",
      "--ephemeral",
      "--sandbox",
      sandbox,
      "--ignore-rules",
      "--cd",
      workspace.root,
      "--disable",
      "multi_agent",
      "-c",
      'shell_environment_policy.inherit="none"',
      "-c",
      "mcp_servers={}",
      "-c",
      "project_doc_max_bytes=0",
      "--color",
      "never",
      "--json"
    ];
    for (const feature of disabledCodexFeatures) args.push("--disable", feature);
    if (request.reasoning !== null) {
      args.push("-c", `model_reasoning_effort=${JSON.stringify(request.reasoning)}`);
    }
    if (request.model !== null) args.push("--model", request.model);
    args.push("-");
    return {
      command: { executable, args },
      stdin: prompt,
      harnessVersion: "codex-exec-jsonl-v1"
    } satisfies FactoryAgentCommand;
  },
  parse(input) {
    return parseCodexOutput(input);
  }
};

function assertCodexRequest(request: FactoryProviderRunRequest, workspace: FactoryWorkspace): void {
  if (request.provider !== "codex") throw new Error("Codex adapter received another provider.");
  if (
    request.taskId !== workspace.taskId ||
    request.attempt !== workspace.attempt ||
    request.repository.baseRevision !== workspace.baseRevision
  ) {
    throw new Error("Codex run does not match its exact factory workspace.");
  }
  if (
    request.capabilities.network.mode !== "off" ||
    request.capabilities.secretRefs.length > 0 ||
    request.capabilities.remoteRepository !== "none" ||
    request.capabilities.commandAllowlist.length > 0 ||
    request.capabilities.process !== "sandboxed"
  ) {
    throw new Error("Codex factory adapter cannot enforce the requested capabilities.");
  }
  const readOnly = isFactoryPreparationRunRequest(request) || request.role === "reviewer";
  const expectedFilesystem = readOnly ? "read" : "workspace-write";
  const expectedGit = readOnly ? "read" : "worktree-write";
  if (
    request.capabilities.filesystem !== expectedFilesystem ||
    request.capabilities.git !== expectedGit
  ) {
    throw new Error("Codex role and filesystem capability disagree.");
  }
}

const disabledCodexFeatures = [
  "apps",
  "browser_use",
  "browser_use_external",
  "browser_use_full_cdp_access",
  "computer_use",
  "hooks",
  "image_generation",
  "in_app_browser",
  "in_app_local_automation",
  "plugins",
  "remote_plugin",
  "shell_snapshot",
  "shell_snapshot_v2",
  "skill_search",
  "standalone_web_search"
] as const;

function parseCodexOutput(input: FactoryAgentParseInput) {
  const events = parseProviderJsonLines(input.stdout, "Codex");
  let providerSessionId: string | null = null;
  let finalOutput: string | null = null;
  let agentTurns = 0;
  let toolCalls = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  for (const event of events) {
    if (event.type === "thread.started" && typeof event.thread_id === "string") {
      providerSessionId = event.thread_id;
    }
    if (event.type === "turn.completed") {
      agentTurns += 1;
      const usage = objectValue(event.usage);
      inputTokens += nonnegativeInteger(usage?.input_tokens);
      outputTokens += nonnegativeInteger(usage?.output_tokens);
    }
    if (event.type === "item.completed") {
      const item = objectValue(event.item);
      if (item?.type === "agent_message" && typeof item.text === "string") {
        finalOutput = item.text;
      } else if (item?.type !== "reasoning") {
        toolCalls += 1;
      }
    }
  }
  const usage = emptyFactoryBudgetUsage();
  return {
    providerVersion: input.providerVersion,
    harnessVersion: input.harnessVersion,
    providerSessionId,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    stdout: input.stdout,
    stderr: input.stderr,
    finalOutput,
    usage: {
      ...usage,
      wallClockSeconds: elapsedSeconds(input.startedAt, input.finishedAt),
      agentTurns,
      toolCalls,
      inputTokens,
      outputTokens,
      processes: 1,
      outputBytes: Buffer.byteLength(input.stdout) + Buffer.byteLength(input.stderr)
    },
    usageComplete: false
  };
}

export { parseCodexOutput };
