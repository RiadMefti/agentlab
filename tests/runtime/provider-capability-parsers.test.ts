import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { IncompatibleProviderCapabilityError } from "../../packages/runtime/src/domain/provider-capability-discovery.js";
import {
  NodeCommandRunner,
  type CommandRunner
} from "../../packages/runtime/src/infrastructure/process/command-runner.js";
import {
  parseClaudeModels,
  supportedModelsWithTimeout
} from "../../packages/runtime/src/infrastructure/providers/claude-capability-discovery.js";
import {
  CodexAppServerCatalogClient,
  parseCodexModels
} from "../../packages/runtime/src/infrastructure/providers/codex-capability-discovery.js";
import {
  OpenCodeCapabilityDiscovery,
  parseOpenCodeModels
} from "../../packages/runtime/src/infrastructure/providers/opencode-capability-discovery.js";
import { LONG_BEDROCK_MODEL_ID, LONG_OPENCODE_BEDROCK_MODEL_ID } from "../helpers/model-ids.js";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe("provider capability parsers", () => {
  it("maps Codex catalog metadata to model-specific reasoning", () => {
    expect(
      parseCodexModels([
        {
          model: "gpt-test",
          displayName: "GPT Test",
          description: "Test model",
          hidden: false,
          supportedReasoningEfforts: [
            { reasoningEffort: "low", description: "Fast responses with lighter reasoning" },
            { reasoningEffort: "xhigh", description: "Extra high reasoning depth" },
            { reasoningEffort: "ultra", description: "Automatic delegation" }
          ],
          defaultReasoningEffort: "xhigh",
          isDefault: true,
          ignoredFutureField: true
        },
        {
          model: "hidden-test",
          displayName: "Hidden",
          description: "Hidden model",
          hidden: true,
          supportedReasoningEfforts: [],
          defaultReasoningEffort: "medium",
          isDefault: false
        }
      ])
    ).toEqual({
      defaultModel: "gpt-test",
      models: [
        {
          id: "gpt-test",
          label: "GPT Test",
          description: "Test model",
          defaultReasoning: "xhigh",
          reasoningOptions: [
            { id: "low", label: "Low" },
            { id: "xhigh", label: "Extra high" }
          ]
        }
      ]
    });
  });

  it("rejects inconsistent Codex defaults at the boundary", () => {
    expect(() =>
      parseCodexModels([
        {
          model: "gpt-test",
          displayName: "GPT Test",
          description: "Test",
          hidden: false,
          supportedReasoningEfforts: [{ reasoningEffort: "low", description: "Low" }],
          defaultReasoningEffort: "high",
          isDefault: true
        }
      ])
    ).toThrow(/Default reasoning/u);

    expect(() =>
      parseCodexModels(
        ["one", "two"].map((model) => ({
          model,
          displayName: model,
          description: "Test",
          hidden: false,
          supportedReasoningEfforts: [{ reasoningEffort: "high", description: "High" }],
          defaultReasoningEffort: "high",
          isDefault: true
        }))
      )
    ).toThrow(/more than one default/u);
  });

  it("rejects Codex models whose provider default would enable ultra delegation", () => {
    expect(() =>
      parseCodexModels([
        {
          model: "gpt-ultra-default",
          displayName: "GPT Ultra Default",
          description: "Unsafe implicit default",
          hidden: false,
          supportedReasoningEfforts: [
            { reasoningEffort: "high", description: "High" },
            { reasoningEffort: "ultra", description: "Automatic delegation" }
          ],
          defaultReasoningEffort: "ultra",
          isDefault: true
        }
      ])
    ).toThrow(/defaults to ultra, which would enable automatic delegation/u);

    expect(() =>
      parseCodexModels([
        {
          model: "hidden-provider-default",
          displayName: "Hidden Provider Default",
          description: "Still used when no model override is launched",
          hidden: true,
          supportedReasoningEfforts: [
            { reasoningEffort: "high", description: "High" },
            { reasoningEffort: "ultra", description: "Automatic delegation" }
          ],
          defaultReasoningEffort: "ultra",
          isDefault: true
        }
      ])
    ).toThrow(/hidden-provider-default defaults to ultra/u);
  });

  it("normalizes Codex reasoning metadata before excluding ultra", () => {
    expect(
      parseCodexModels([
        {
          model: "gpt-spaced",
          displayName: "GPT Spaced",
          description: "Normalized metadata",
          hidden: false,
          supportedReasoningEfforts: [
            { reasoningEffort: " high ", description: "High" },
            { reasoningEffort: " ultra ", description: "Automatic delegation" }
          ],
          defaultReasoningEffort: " high ",
          isDefault: true
        }
      ])
    ).toEqual({
      defaultModel: "gpt-spaced",
      models: [
        {
          id: "gpt-spaced",
          label: "GPT Spaced",
          description: "Normalized metadata",
          defaultReasoning: "high",
          reasoningOptions: [{ id: "high", label: "High" }]
        }
      ]
    });

    for (const hidden of [false, true]) {
      expect(() =>
        parseCodexModels([
          {
            model: hidden ? "hidden-spaced-ultra" : "spaced-ultra",
            displayName: "Spaced Ultra",
            description: "Unsafe after normalization",
            hidden,
            supportedReasoningEfforts: [
              { reasoningEffort: " high ", description: "High" },
              { reasoningEffort: " ultra ", description: "Automatic delegation" }
            ],
            defaultReasoningEffort: " ultra ",
            isDefault: true
          }
        ])
      ).toThrow(IncompatibleProviderCapabilityError);
    }
  });

  it("rejects duplicate model-specific reasoning identifiers", () => {
    expect(() =>
      parseCodexModels([
        {
          model: "gpt-test",
          displayName: "GPT Test",
          description: "Test",
          hidden: false,
          supportedReasoningEfforts: [
            { reasoningEffort: "high", description: "High" },
            { reasoningEffort: "high", description: "Duplicate" }
          ],
          defaultReasoningEffort: "high",
          isDefault: true
        }
      ])
    ).toThrow(/Reasoning identifiers must be unique/u);
  });

  it("maps Claude Agent SDK aliases and effort metadata", () => {
    expect(
      parseClaudeModels([
        {
          value: "default",
          resolvedModel: "claude-sonnet-test",
          displayName: "Default (recommended)",
          description: "Sonnet Test",
          supportsEffort: true,
          supportedEffortLevels: ["low", "high", "xhigh", "max"]
        },
        {
          value: "haiku",
          displayName: "Haiku",
          description: "Fast",
          supportsEffort: false
        }
      ])
    ).toEqual({
      defaultModel: "default",
      models: [
        {
          id: "default",
          label: "Default (recommended)",
          description: "Sonnet Test",
          defaultReasoning: null,
          reasoningOptions: [
            { id: "low", label: "Low" },
            { id: "high", label: "High" },
            { id: "xhigh", label: "Extra high" },
            { id: "max", label: "Max" }
          ]
        },
        {
          id: "haiku",
          label: "Haiku",
          description: "Fast",
          defaultReasoning: null,
          reasoningOptions: []
        }
      ]
    });
  });

  it("strictly parses OpenCode's verbose records but disables unsupported startup variants", () => {
    const output = `provider/model-one
{
  "id": "model-one",
  "providerID": "provider",
  "name": "Model One",
  "variants": {
    "low": { "reasoningEffort": "low" },
    "max": { "reasoningEffort": "max" }
  }
}
provider/model-two
{
  "id": "model-two",
  "providerID": "provider",
  "name": "Model Two",
  "variants": {}
}
`;

    expect(parseOpenCodeModels(output)).toEqual({
      defaultModel: null,
      models: [
        {
          id: "provider/model-one",
          label: "Model One",
          description: null,
          defaultReasoning: null,
          reasoningOptions: []
        },
        {
          id: "provider/model-two",
          label: "Model Two",
          description: null,
          defaultReasoning: null,
          reasoningOptions: []
        }
      ]
    });
    expect(() =>
      parseOpenCodeModels(
        'provider/claimed\n{"id":"different","providerID":"provider","name":"Bad","variants":{}}'
      )
    ).toThrow(/does not match/u);
    expect(() => parseOpenCodeModels("provider/model\n{not-json}")).toThrow(/invalid JSON/u);
    expect(() =>
      parseOpenCodeModels(
        `provider/model\n{"id":"model","providerID":"provider","name":"Deep","variants":${"[".repeat(33)}0${"]".repeat(33)}}`
      )
    ).toThrow(/nesting limit/u);
  });

  it("accepts a bounded provider-qualified Bedrock inference-profile ARN", () => {
    const output = `${LONG_OPENCODE_BEDROCK_MODEL_ID}\n${JSON.stringify({
      id: LONG_BEDROCK_MODEL_ID,
      providerID: "amazon-bedrock",
      name: "Long Bedrock deployment",
      variants: {}
    })}`;

    expect(parseOpenCodeModels(output).models).toEqual([
      expect.objectContaining({ id: LONG_OPENCODE_BEDROCK_MODEL_ID })
    ]);
  });

  it("runs OpenCode discovery with bounded non-interactive arguments", async () => {
    const run = vi.fn<CommandRunner["run"]>(() =>
      Promise.resolve({
        stdout:
          'provider/model\n{"id":"model","providerID":"provider","name":"Model","variants":{}}',
        stderr: ""
      })
    );
    const adapter = new OpenCodeCapabilityDiscovery({ run });

    await adapter.discover({
      executable: "/opt/opencode",
      version: "1.18.21",
      workspace: "/work/project"
    });
    expect(run).toHaveBeenCalledWith(
      "/opt/opencode",
      ["models", "--verbose"],
      expect.objectContaining({
        cwd: "/work/project",
        timeoutMs: 5_000,
        cleanupProcessTree: true
      })
    );
  });

  it("cleans an ignored-TERM OpenCode process tree before reporting malformed output", async () => {
    const fixture = createIgnoredTermFixture(
      "opencode-malformed-",
      "printf '%s\\n' 'provider/model' '{not-json}'"
    );
    const adapter = new OpenCodeCapabilityDiscovery(
      new NodeCommandRunner({ gracefulShutdownMs: 25, forcedShutdownMs: 1_000 })
    );

    await expect(
      adapter.discover({
        executable: fixture.executable,
        version: "1.18.21",
        workspace: fixture.root
      })
    ).rejects.toThrow(/invalid JSON/u);
    expectProcessGone(readPid(fixture.leaderPidPath));
    expectProcessGone(readPid(fixture.childPidPath));
  });

  it("cleans an ignored-TERM OpenCode process tree after a discovery timeout", async () => {
    const fixture = createIgnoredTermFixture("opencode-timeout-", 'wait "$child_pid"');
    const adapter = new OpenCodeCapabilityDiscovery(
      new NodeCommandRunner({ gracefulShutdownMs: 25, forcedShutdownMs: 1_000 }),
      250
    );

    await expect(
      adapter.discover({
        executable: fixture.executable,
        version: "1.18.21",
        workspace: fixture.root
      })
    ).rejects.toThrow(/timed out after 250 milliseconds/u);
    expectProcessGone(readPid(fixture.leaderPidPath));
    expectProcessGone(readPid(fixture.childPidPath));
  });
});

describe("provider discovery timeouts", () => {
  it("aborts a stalled Claude SDK control request without sending a prompt", async () => {
    const abortController = new AbortController();
    const supportedModels = vi.fn(() => new Promise<never>(() => undefined));

    await expect(
      supportedModelsWithTimeout({ supportedModels }, abortController, 5)
    ).rejects.toThrow("Claude model catalog timed out.");
    expect(abortController.signal.aborted).toBe(true);
  });

  it("gracefully terminates a stalled Codex app-server catalog request", async () => {
    const root = mkdtempSync(join(tmpdir(), "codex-catalog-timeout-"));
    temporaryRoots.push(root);
    const executable = join(root, "codex");
    const pidPath = join(root, "pid");
    const termPath = join(root, "term");
    writeFileSync(
      executable,
      `#!/bin/sh
printf '%s' "$$" > ${shellQuote(pidPath)}
trap "printf term > ${shellQuote(termPath)}; exit 0" TERM
read -r first
read -r second
`
    );
    chmodSync(executable, 0o755);

    await expect(
      new CodexAppServerCatalogClient(250, 500, 2_000).listModels({
        executable,
        version: "codex-cli test",
        workspace: root
      })
    ).rejects.toThrow("Codex model catalog timed out.");
    expect(readFileSync(termPath, "utf8")).toBe("term");
    expectProcessGone(readPid(pidPath));
  });

  it("ignores an unsolicited Codex protocol response", async () => {
    const root = mkdtempSync(join(tmpdir(), "codex-catalog-correlation-"));
    temporaryRoots.push(root);
    const executable = join(root, "codex");
    writeFileSync(
      executable,
      `#!/bin/sh
read -r first
printf '%s\\n' '{"id":99,"result":{"data":[],"nextCursor":null}}'
sleep 1
`
    );
    chmodSync(executable, 0o755);

    await expect(
      new CodexAppServerCatalogClient(250, 500, 2_000).listModels({
        executable,
        version: "codex-cli test",
        workspace: root
      })
    ).rejects.toThrow("Codex model catalog timed out.");
  });

  it("uses the exact initialized notification and paginates before cleanup", async () => {
    const root = mkdtempSync(join(tmpdir(), "codex-catalog-handshake-"));
    temporaryRoots.push(root);
    const executable = join(root, "codex");
    const pidPath = join(root, "pid");
    const transcriptPath = join(root, "transcript.json");
    writeFileSync(
      executable,
      `#!/bin/sh
printf '%s' "$$" > ${shellQuote(pidPath)}
trap 'exit 0' TERM
IFS= read -r initialize
printf '[%s' "$initialize" > ${shellQuote(transcriptPath)}
printf '%s\n' '{"id":1,"result":{}}'
IFS= read -r initialized
printf ',%s' "$initialized" >> ${shellQuote(transcriptPath)}
IFS= read -r first_page
printf ',%s' "$first_page" >> ${shellQuote(transcriptPath)}
printf '%s\n' '{"id":2,"result":{"data":[{"model":"gpt-one"}],"nextCursor":"page-2"}}'
IFS= read -r second_page
printf ',%s]' "$second_page" >> ${shellQuote(transcriptPath)}
printf '%s\n' '{"id":3,"result":{"data":[{"model":"gpt-two"}],"nextCursor":null}}'
while :; do sleep 1; done
`
    );
    chmodSync(executable, 0o755);

    await expect(
      new CodexAppServerCatalogClient(1_000, 500, 2_000).listModels({
        executable,
        version: "codex-cli test",
        workspace: root
      })
    ).resolves.toEqual([{ model: "gpt-one" }, { model: "gpt-two" }]);

    expect(JSON.parse(readFileSync(transcriptPath, "utf8"))).toEqual([
      {
        method: "initialize",
        id: 1,
        params: {
          clientInfo: {
            name: "agentlab",
            title: "AgentLab",
            version: "0.1.0"
          },
          capabilities: null
        }
      },
      { method: "initialized" },
      {
        method: "model/list",
        id: 2,
        params: { cursor: null, limit: 100, includeHidden: false }
      },
      {
        method: "model/list",
        id: 3,
        params: { cursor: "page-2", limit: 100, includeHidden: false }
      }
    ]);
    expectProcessGone(readPid(pidPath));
  });

  it("force-kills a Codex app-server that returns malformed output and ignores SIGTERM", async () => {
    const root = mkdtempSync(join(tmpdir(), "codex-catalog-force-kill-"));
    temporaryRoots.push(root);
    const executable = join(root, "codex");
    const pidPath = join(root, "pid");
    const childPidPath = join(root, "child-pid");
    writeFileSync(
      executable,
      `#!/bin/sh
printf '%s' "$$" > ${shellQuote(pidPath)}
trap '' TERM
sleep 1000 &
child_pid=$!
printf '%s' "$child_pid" > ${shellQuote(childPidPath)}
printf '%s\n' 'not-json'
wait "$child_pid"
`
    );
    chmodSync(executable, 0o755);

    await expect(
      new CodexAppServerCatalogClient(1_000, 250, 2_000).listModels({
        executable,
        version: "codex-cli test",
        workspace: root
      })
    ).rejects.toThrow("Codex app-server returned invalid JSON.");
    expectProcessGone(readPid(pidPath));
    expectProcessGone(readPid(childPidPath));
  });
});

interface IgnoredTermFixture {
  readonly root: string;
  readonly executable: string;
  readonly leaderPidPath: string;
  readonly childPidPath: string;
}

function createIgnoredTermFixture(prefix: string, body: string): IgnoredTermFixture {
  const root = mkdtempSync(join(tmpdir(), prefix));
  temporaryRoots.push(root);
  const executable = join(root, "provider");
  const leaderPidPath = join(root, "leader-pid");
  const childPidPath = join(root, "child-pid");
  writeFileSync(
    executable,
    `#!/bin/sh
printf '%s' "$$" > ${shellQuote(leaderPidPath)}
trap '' TERM
sleep 1000 >/dev/null 2>&1 &
child_pid=$!
printf '%s' "$child_pid" > ${shellQuote(childPidPath)}
${body}
`
  );
  chmodSync(executable, 0o755);
  return { root, executable, leaderPidPath, childPidPath };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function readPid(path: string): number {
  const pid = Number(readFileSync(path, "utf8"));
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("Invalid fixture process ID.");
  return pid;
}

function expectProcessGone(pid: number): void {
  try {
    process.kill(pid, 0);
  } catch (error: unknown) {
    expect(error).toMatchObject({ code: "ESRCH" });
    return;
  }
  throw new Error(`Fixture process ${String(pid)} is still running.`);
}
