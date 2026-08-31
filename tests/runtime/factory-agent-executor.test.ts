import { createHash } from "node:crypto";

import {
  factoryAgentRunRequestSchema,
  factoryCostPolicySchema,
  factoryPreparationRunRequestSchema,
  type FactoryAgentRunRequest,
  type FactoryPreparationRunRequest
} from "@agentlab/contracts";
import { describe, expect, it } from "vitest";

import type { FactoryWorkspace } from "../../packages/runtime/src/domain/factory-workspace.js";
import type { FactoryProcessIsolator } from "../../packages/runtime/src/domain/factory-process-isolation.js";
import { FactoryCostAccountant } from "../../packages/runtime/src/domain/factory-cost-accounting.js";
import { claudeFactoryAgentAdapter } from "../../packages/runtime/src/infrastructure/providers/claude-factory-agent.js";
import { codexFactoryAgentAdapter } from "../../packages/runtime/src/infrastructure/providers/codex-factory-agent.js";
import { factoryAgentEnvironment } from "../../packages/runtime/src/infrastructure/providers/factory-agent-environment.js";
import { LocalFactoryAgentExecutor } from "../../packages/runtime/src/infrastructure/providers/local-factory-agent-executor.js";
import type {
  CommandRunner,
  RunOptions,
  RunResult
} from "../../packages/runtime/src/infrastructure/process/command-runner.js";
import { testDigest, testFactoryContract } from "../helpers/factory.js";
import { testFactoryPreparationFixture } from "../helpers/factory-preparation.js";

const prompt = "Implement only the immutable task contract.";
const policyBundleDigest = testDigest("e");
const workspace = fakeWorkspace();
const resourceLimits = {
  maxProcesses: 64,
  maxMemoryBytes: 4 * 1_024 * 1_024 * 1_024,
  cpuQuotaPercent: 400
} as const;

describe("factory agent adapters", () => {
  it("builds a hardened Codex argument vector with the prompt only on stdin", () => {
    const request = runRequest("codex", "implementer");
    const invocation = codexFactoryAgentAdapter.build(request, "/opt/codex", workspace, prompt);

    expect(invocation.command.executable).toBe("/opt/codex");
    expect(invocation.command.args.slice(0, 3)).toEqual(["--ask-for-approval", "never", "exec"]);
    expect(invocation.command.args).toContain("workspace-write");
    expect(invocation.command.args).toContain("--ignore-user-config");
    expect(invocation.command.args).toContain("--ignore-rules");
    expect(invocation.command.args).toContain("mcp_servers={}");
    expect(invocation.command.args).toContain("project_doc_max_bytes=0");
    expect(invocation.command.args).toContain("browser_use");
    expect(invocation.command.args).not.toContain(prompt);
    expect(invocation.command.args).not.toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(invocation.stdin).toBe(prompt);
  });

  it("limits Claude to restricted read-only review", () => {
    const reviewer = runRequest("claude", "reviewer");
    const invocation = claudeFactoryAgentAdapter.build(reviewer, "/opt/claude", workspace, prompt);

    expect(invocation.command.args).toEqual(
      expect.arrayContaining([
        "--bare",
        "--restricted",
        "--safe-mode",
        "--strict-mcp-config",
        "Read,Glob,Grep"
      ])
    );
    expect(() =>
      claudeFactoryAgentAdapter.build(
        runRequest("claude", "implementer"),
        "/opt/claude",
        workspace,
        prompt
      )
    ).toThrow(/read-only review and preparation only/u);
  });

  it("uses the same hardened provider harness for read-only preparation", async () => {
    const codex = preparationRunRequest("codex");
    const codexInvocation = codexFactoryAgentAdapter.build(codex, "/opt/codex", workspace, prompt);
    expect(codexInvocation.command.args).toContain("read-only");

    const claude = preparationRunRequest("claude");
    const claudeInvocation = claudeFactoryAgentAdapter.build(
      claude,
      "/opt/claude",
      workspace,
      prompt
    );
    expect(claudeInvocation.command.args).toContain("Read,Glob,Grep");

    const runner = new FakeCommandRunner({
      stdout: JSON.stringify({ type: "turn.completed", usage: {} }),
      stderr: ""
    });
    const output = await executorWithTimes(runner).execute({
      request: codex,
      policyBundleDigest,
      executable: "/opt/codex",
      providerVersion: "1.2.3",
      workspace,
      prompt,
      resourceLimits
    });
    expect(output.status).toBe("succeeded");
    expect(
      executorWithTimes(runner)
        .capabilities()
        .find(({ provider }) => provider === "codex")?.preparationPhases
    ).toEqual(["qualify", "specify", "plan"]);
  });

  it("parses provider JSONL without treating it as authority", () => {
    const codex = codexFactoryAgentAdapter.parse({
      request: runRequest("codex", "implementer"),
      providerVersion: "1.2.3",
      harnessVersion: "codex-exec-jsonl-v1",
      startedAt: "2026-08-30T12:00:00.000Z",
      finishedAt: "2026-08-30T12:00:02.000Z",
      stdout: [
        JSON.stringify({ type: "thread.started", thread_id: "thread-1" }),
        JSON.stringify({
          type: "item.completed",
          item: { type: "command_execution", command: "npm test" }
        }),
        JSON.stringify({
          type: "item.completed",
          item: { type: "agent_message", text: "Implemented and tested." }
        }),
        JSON.stringify({
          type: "turn.completed",
          usage: { input_tokens: 100, output_tokens: 20 }
        })
      ].join("\n"),
      stderr: ""
    });
    expect(codex).toMatchObject({
      providerSessionId: "thread-1",
      finalOutput: "Implemented and tested.",
      usage: { inputTokens: 100, outputTokens: 20, toolCalls: 1, agentTurns: 1 },
      usageMeasurementsComplete: true,
      reportedCostMicrousd: null
    });

    const claude = claudeFactoryAgentAdapter.parse({
      request: runRequest("claude", "reviewer"),
      providerVersion: "2.3.4",
      harnessVersion: "claude-restricted-review-jsonl-v1",
      startedAt: "2026-08-30T12:00:00.000Z",
      finishedAt: "2026-08-30T12:00:03.000Z",
      stdout: [
        JSON.stringify({
          type: "assistant",
          message: { content: [{ type: "tool_use", name: "Read" }] }
        }),
        JSON.stringify({
          type: "result",
          subtype: "success",
          is_error: false,
          result: "No blocking findings.",
          session_id: "session-1",
          num_turns: 2,
          total_cost_usd: 0.012345,
          modelUsage: {
            "claude-sonnet-4-6": {
              inputTokens: 200,
              outputTokens: 30,
              cacheReadInputTokens: 50,
              cacheCreationInputTokens: 25
            }
          }
        })
      ].join("\n"),
      stderr: ""
    });
    expect(claude).toMatchObject({
      finalOutput: "No blocking findings.",
      providerSessionId: "session-1",
      usage: { inputTokens: 275, outputTokens: 30, agentTurns: 2, toolCalls: 1 },
      usageMeasurementsComplete: true,
      reportedCostMicrousd: 12_345
    });

    const unknownCostBasis = claudeFactoryAgentAdapter.parse({
      request: runRequest("claude", "reviewer"),
      providerVersion: "2.3.4",
      harnessVersion: "claude-restricted-review-jsonl-v1",
      startedAt: "2026-08-30T12:00:00.000Z",
      finishedAt: "2026-08-30T12:00:03.000Z",
      stdout: [
        JSON.stringify({ type: "assistant", message: { content: [] } }),
        JSON.stringify({
          type: "result",
          subtype: "success",
          is_error: false,
          result: "No blocking findings.",
          session_id: "session-1",
          num_turns: 1,
          total_cost_usd: 0.01,
          modelUsage: {
            "gateway-model": {
              inputTokens: 10,
              outputTokens: 2,
              cacheReadInputTokens: 0,
              cacheCreationInputTokens: 0,
              costBasis: "unknown"
            }
          }
        })
      ].join("\n"),
      stderr: ""
    });
    expect(unknownCostBasis).toMatchObject({
      usageMeasurementsComplete: true,
      reportedCostMicrousd: null
    });
  });
});

describe("LocalFactoryAgentExecutor", () => {
  it("bounds process input/output and normalizes a successful provider run", async () => {
    const runner = new FakeCommandRunner({
      stdout: [
        JSON.stringify({ type: "thread.started", thread_id: "thread-1" }),
        JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 5 } })
      ].join("\n"),
      stderr: ""
    });
    const executor = executorWithTimes(runner);
    const output = await executor.execute({
      request: runRequest("codex", "implementer"),
      policyBundleDigest,
      executable: "/opt/codex",
      providerVersion: "1.2.3",
      workspace,
      prompt,
      resourceLimits
    });

    expect(output).toMatchObject({
      status: "succeeded",
      exitCode: 0,
      errorCode: null,
      usageComplete: true,
      usage: { costMicrousd: 20 }
    });
    expect(output.isolation.limits.maxProcesses).toBe(32);
    expect(runner.calls[0]).toMatchObject({
      executable: "/opt/codex",
      options: {
        cwd: workspace.root,
        cleanupProcessTree: true,
        stdin: prompt,
        maxCombinedBufferBytes: testFactoryContract().budget.maxOutputBytes
      }
    });
  });

  it("drops repository and cloud credentials from the model-bearing process environment", async () => {
    const runner = new FakeCommandRunner({
      stdout: JSON.stringify({ type: "turn.completed", usage: {} }),
      stderr: ""
    });
    const executor = executorWithTimes(runner, {
      HOME: "/home/tester",
      OPENAI_API_KEY: "provider-only",
      GITHUB_TOKEN: "must-not-leak",
      AWS_SECRET_ACCESS_KEY: "must-not-leak",
      NPM_TOKEN: "must-not-leak"
    });

    await executor.execute({
      request: runRequest("codex", "implementer"),
      policyBundleDigest,
      executable: "/opt/codex",
      providerVersion: "1.2.3",
      workspace,
      prompt,
      resourceLimits
    });

    expect(runner.calls[0]?.options.environment).toMatchObject({
      HOME: "/home/tester",
      OPENAI_API_KEY: "provider-only",
      CI: "true"
    });
    expect(runner.calls[0]?.options.environment).not.toHaveProperty("GITHUB_TOKEN");
    expect(runner.calls[0]?.options.environment).not.toHaveProperty("AWS_SECRET_ACCESS_KEY");
    expect(runner.calls[0]?.options.environment).not.toHaveProperty("NPM_TOKEN");
    expect(() => factoryAgentEnvironment("codex", {}, { GITHUB_TOKEN: "forbidden" })).toThrow(
      /not allowlisted/u
    );
  });

  it("normalizes timeouts and malformed provider output as failed untrusted runs", async () => {
    const timeout = Object.assign(new Error("timed out"), {
      commandFailureKind: "timeout",
      exitCode: null,
      signal: null,
      stdout: "partial",
      stderr: ""
    });
    const timedOut = await executorWithTimes(new FakeCommandRunner(timeout)).execute({
      request: runRequest("codex", "implementer"),
      policyBundleDigest,
      executable: "/opt/codex",
      providerVersion: "1.2.3",
      workspace,
      prompt,
      resourceLimits
    });
    expect(timedOut).toMatchObject({
      status: "timed-out",
      errorCode: "execution-timeout",
      stdout: "partial",
      usageComplete: false
    });

    const malformed = await executorWithTimes(
      new FakeCommandRunner({ stdout: "not json", stderr: "" })
    ).execute({
      request: runRequest("codex", "implementer"),
      policyBundleDigest,
      executable: "/opt/codex",
      providerVersion: "1.2.3",
      workspace,
      prompt,
      resourceLimits
    });
    expect(malformed).toMatchObject({
      status: "failed",
      errorCode: "provider-output-invalid",
      stdout: "not json"
    });
  });

  it("advertises no unsafe OpenCode autonomous adapter", () => {
    const executor = executorWithTimes(new FakeCommandRunner({ stdout: "", stderr: "" }));
    expect(executor.capabilities().map(({ provider }) => provider)).toEqual(["codex", "claude"]);
  });

  it("rejects an unknown cost coordinate before process isolation or spawn", async () => {
    let isolationCalls = 0;
    const runner = new FakeCommandRunner({ stdout: "", stderr: "" });
    const executor = new LocalFactoryAgentExecutor(runner, {
      now: () => "2026-08-30T12:00:00.000Z",
      processIsolator: {
        isolate: (input) => {
          isolationCalls += 1;
          return passthroughProcessIsolator.isolate(input);
        }
      },
      costAccountant: new FactoryCostAccountant(
        policyBundleDigest,
        factoryCostPolicySchema.parse({
          schemaVersion: "agentlab.cost-policy.v1",
          id: "agentlab/empty-test-costs",
          version: "1.0.0",
          rules: []
        })
      )
    });

    await expect(
      executor.execute({
        request: runRequest("codex", "implementer"),
        policyBundleDigest,
        executable: "/opt/codex",
        providerVersion: "1.2.3",
        workspace,
        prompt,
        resourceLimits
      })
    ).rejects.toThrow(/No exact cost rule/u);
    expect(isolationCalls).toBe(0);
    expect(runner.calls).toHaveLength(0);
  });

  it("records post-run accounting failures separately from malformed provider output", async () => {
    const runner = new FakeCommandRunner({
      stdout: JSON.stringify({
        type: "turn.completed",
        usage: { input_tokens: 10, output_tokens: 5 }
      }),
      stderr: ""
    });
    const executor = new LocalFactoryAgentExecutor(runner, {
      now: (() => {
        const times = ["2026-08-30T12:00:00.000Z", "2026-08-30T12:00:02.000Z"];
        return () => times.shift() ?? "2026-08-30T12:00:02.000Z";
      })(),
      processIsolator: passthroughProcessIsolator,
      costAccountant: {
        preflight: () => undefined,
        account: () => {
          throw new Error("test accounting failure");
        }
      }
    });

    await expect(
      executor.execute({
        request: runRequest("codex", "implementer"),
        policyBundleDigest,
        executable: "/opt/codex",
        providerVersion: "1.2.3",
        workspace,
        prompt,
        resourceLimits
      })
    ).resolves.toMatchObject({
      status: "failed",
      errorCode: "cost-accounting-invalid",
      usageComplete: false
    });
    expect(runner.calls).toHaveLength(1);
  });
});

class FakeCommandRunner implements CommandRunner {
  public readonly calls: {
    readonly executable: string;
    readonly args: readonly string[];
    readonly options: RunOptions;
  }[] = [];

  public constructor(private readonly result: RunResult | Error) {}

  public run(
    executable: string,
    args: readonly string[],
    options: RunOptions = {}
  ): Promise<RunResult> {
    this.calls.push({ executable, args, options });
    return this.result instanceof Error
      ? Promise.reject(this.result)
      : Promise.resolve(this.result);
  }
}

function executorWithTimes(
  runner: CommandRunner,
  hostEnvironment?: NodeJS.ProcessEnv
): LocalFactoryAgentExecutor {
  const times = ["2026-08-30T12:00:00.000Z", "2026-08-30T12:00:02.000Z"];
  return new LocalFactoryAgentExecutor(runner, {
    now: () => times.shift() ?? "2026-08-30T12:00:02.000Z",
    processIsolator: passthroughProcessIsolator,
    costAccountant: testCostAccountant(),
    ...(hostEnvironment === undefined ? {} : { hostEnvironment })
  });
}

function testCostAccountant(): FactoryCostAccountant {
  return new FactoryCostAccountant(
    policyBundleDigest,
    factoryCostPolicySchema.parse({
      schemaVersion: "agentlab.cost-policy.v1",
      id: "agentlab/test-costs",
      version: "1.0.0",
      rules: [
        {
          provider: "codex",
          model: "gpt-5.4",
          accounting: {
            mode: "token-rate",
            inputMicrousdPerMillionTokens: 1_000_000,
            outputMicrousdPerMillionTokens: 2_000_000
          }
        },
        {
          provider: "claude",
          model: "claude-sonnet-4-6",
          accounting: { mode: "provider-reported" }
        }
      ]
    })
  );
}

const passthroughProcessIsolator: FactoryProcessIsolator = {
  isolate: ({ command, isolationId, limits }) =>
    Promise.resolve({
      command,
      controllerEnvironment: {},
      isolation: {
        isolationId,
        mechanism: { id: "linux/systemd-user-scope", version: "test-systemd-1" },
        scopeName: `agentlab-factory-${isolationId.replaceAll("-", "")}.scope`,
        limits
      }
    })
};

function runRequest(
  provider: "codex" | "claude",
  role: "implementer" | "reviewer"
): FactoryAgentRunRequest {
  const contract = testFactoryContract();
  const reviewer = role === "reviewer";
  return factoryAgentRunRequestSchema.parse({
    schemaVersion: "agentlab.agent-run-request.v1",
    executionId: "33333333-3333-4333-8333-333333333333",
    taskId: contract.taskId,
    contractDigest: testDigest("d"),
    role,
    attempt: 1,
    provider,
    model: provider === "codex" ? "gpt-5.4" : "claude-sonnet-4-6",
    reasoning: "high",
    repository: contract.repository,
    promptArtifact: {
      digest: digestOf(prompt),
      mediaType: "text/plain",
      sizeBytes: Buffer.byteLength(prompt)
    },
    outputSchemaDigest: null,
    skillDigests: contract.skillPlan.map(({ packageDigest }) => packageDigest),
    capabilities: {
      filesystem: reviewer ? "read" : "workspace-write",
      git: reviewer ? "read" : "worktree-write",
      remoteRepository: "none",
      process: provider === "claude" ? "none" : "sandboxed",
      network: { mode: "off" },
      commandAllowlist: [],
      secretRefs: []
    },
    budget: contract.budget
  });
}

function preparationRunRequest(provider: "codex" | "claude"): FactoryPreparationRunRequest {
  const fixture = testFactoryPreparationFixture();
  const request = fixture.documents.intakeRequest(fixture.request);
  const authority = fixture.documents.preparationAuthority(fixture.authority);
  const skill = fixture.authority.skills.find(({ phase }) => phase === "qualify");
  const profile = fixture.authority.preparationProfiles.find(({ phase }) => phase === "qualify");
  if (skill === undefined || profile === undefined || skill.manifest.outputSchemaDigest === null) {
    throw new Error("Preparation fixture is incomplete.");
  }
  return factoryPreparationRunRequestSchema.parse({
    schemaVersion: "agentlab.preparation-run-request.v1",
    executionId: "33333333-3333-4333-8333-333333333333",
    taskId: fixture.request.taskId,
    requestDigest: request.digest,
    authorityDigest: authority.digest,
    phase: "qualify",
    attempt: 1,
    provider,
    model: provider === "codex" ? "gpt-5.4" : "claude-sonnet-4-6",
    reasoning: "high",
    repository: fixture.request.repository,
    skillId: skill.manifest.id,
    skillPackageDigest: skill.manifest.packageDigest,
    promptArtifact: {
      digest: digestOf(prompt),
      mediaType: "text/plain",
      sizeBytes: Buffer.byteLength(prompt)
    },
    inputArtifactDigests: [request.digest],
    outputSchemaDigest: skill.manifest.outputSchemaDigest,
    capabilities: {
      ...profile.capabilities,
      process: provider === "claude" ? "none" : "sandboxed",
      commandAllowlist: []
    },
    budget: profile.budget
  });
}

function fakeWorkspace(): FactoryWorkspace {
  const contract = testFactoryContract();
  return {
    id: "44444444-4444-4444-8444-444444444444",
    taskId: contract.taskId,
    attempt: 1,
    repositoryRoot: "/work/agentlab",
    root: "/work/factory/task-1",
    baseRevision: contract.repository.baseRevision,
    closeAndWait: () => Promise.resolve()
  };
}

function digestOf(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}
