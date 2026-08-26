import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { runLauncher, type ExecuteProgram } from "../../packages/launcher/src/cli.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true }))
  );
});

async function packageFixture(bytes: Uint8Array): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agentlab-launcher-cli-"));
  temporaryRoots.push(root);
  await mkdir(join(root, "cache"));
  await writeFile(
    join(root, "package.json"),
    `${JSON.stringify({ name: "agentlab", version: "0.2.0" })}\n`
  );
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  await writeFile(
    join(root, "release-manifest.json"),
    `${JSON.stringify({
      repository: "RiadMefti/agentlab",
      targets: {
        "linux-x64": {
          asset: "agentlab-v0.2.0-linux-x64",
          sha256,
          size: bytes.byteLength
        },
        "mac-arm64": {
          asset: "agentlab-v0.2.0-mac-arm64",
          sha256,
          size: bytes.byteLength
        }
      },
      version: "0.2.0"
    })}\n`
  );
  return root;
}

function downloadResponse(bytes: Uint8Array): Response {
  const response = new Response(arrayBuffer(bytes), {
    headers: { "content-length": String(bytes.byteLength) },
    status: 200
  });
  Object.defineProperty(response, "url", {
    value: "https://release-assets.githubusercontent.com/agentlab"
  });
  return response;
}

function arrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

describe("AgentLab npm launcher", () => {
  it("prints its package version without downloading a binary", async () => {
    const root = await packageFixture(new TextEncoder().encode("binary"));
    const output: string[] = [];
    const fetchImplementation = vi.fn();

    await expect(
      runLauncher(["--version"], {
        fetch: fetchImplementation as unknown as typeof fetch,
        packageDirectory: root,
        stdout: (message) => output.push(message)
      })
    ).resolves.toBe(0);
    expect(output).toEqual(["0.2.0\n"]);
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it("installs the target binary and forwards exact arguments without a shell", async () => {
    const bytes = new TextEncoder().encode("binary payload");
    const root = await packageFixture(bytes);
    const installOutput: string[] = [];
    const executions: {
      command: string;
      args: readonly string[];
      environment: NodeJS.ProcessEnv;
    }[] = [];
    const execute: ExecuteProgram = (command, args, environment) => {
      executions.push({ args, command, environment });
      return Promise.resolve(7);
    };
    const fetchImplementation = vi.fn(() =>
      Promise.resolve(downloadResponse(bytes))
    ) as unknown as typeof fetch;

    await expect(
      runLauncher(["--help"], {
        cacheRoot: join(root, "cache"),
        environment: {},
        execute,
        fetch: fetchImplementation,
        packageDirectory: root,
        runtime: { arch: "x64", glibcVersionRuntime: "2.39", platform: "linux" },
        stderr: (message) => installOutput.push(message),
        stderrIsTTY: false
      })
    ).resolves.toBe(7);
    expect(executions).toHaveLength(1);
    expect(executions[0]?.command).toBe(
      join(root, "cache", "releases", "0.2.0", "linux-x64", "agentlab")
    );
    expect(executions[0]?.args).toEqual(["--help"]);
    expect(executions[0]?.environment.AGENTLAB_INSTALL_METHOD).toBe("npm");
    expect(executions[0]?.environment.AGENTLAB_LAUNCHER_VERSION).toBe("0.2.0");
    expect(installOutput).toEqual([
      "Downloading AgentLab 0.2.0 for Linux x64 (0.0 MB)...\n",
      "AgentLab 0.2.0 installed for Linux x64.\n",
      "Starting AgentLab...\n"
    ]);

    const cachedOutput: string[] = [];
    const offline = vi.fn(() => Promise.reject(new Error("offline"))) as unknown as typeof fetch;
    await expect(
      runLauncher(["--help"], {
        cacheRoot: join(root, "cache"),
        environment: {},
        execute,
        fetch: offline,
        packageDirectory: root,
        runtime: { arch: "x64", glibcVersionRuntime: "2.39", platform: "linux" },
        stderr: (message) => cachedOutput.push(message),
        stderrIsTTY: false
      })
    ).resolves.toBe(7);
    expect(cachedOutput).toEqual([]);
    expect(offline).not.toHaveBeenCalled();
  });

  it("checks and explicitly installs npm updates", async () => {
    const root = await packageFixture(new TextEncoder().encode("binary"));
    const output: string[] = [];
    const registryFetch = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ version: "0.2.1" }), {
          headers: { "content-type": "application/json" },
          status: 200
        })
      )
    ) as unknown as typeof fetch;
    const executions: { command: string; args: readonly string[] }[] = [];
    const execute: ExecuteProgram = (command, args) => {
      executions.push({ args, command });
      return Promise.resolve(0);
    };

    await expect(
      runLauncher(["update", "--check"], {
        execute,
        fetch: registryFetch,
        packageDirectory: root,
        stdout: (message) => output.push(message)
      })
    ).resolves.toBe(0);
    expect(output.join("")).toContain("npm install --global agentlab@latest");
    expect(executions).toEqual([]);

    await expect(
      runLauncher(["update"], {
        environment: { PATH: "/usr/bin" },
        execute,
        fetch: registryFetch,
        packageDirectory: root,
        stdout: (message) => output.push(message)
      })
    ).resolves.toBe(0);
    expect(executions).toEqual([
      { args: ["install", "--global", "agentlab@latest"], command: "npm" }
    ]);
  });

  it("returns npm's failure without claiming the previous install was untouched", async () => {
    const root = await packageFixture(new TextEncoder().encode("binary"));
    const errors: string[] = [];
    const registryFetch = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ version: "0.2.1" }), {
          headers: { "content-type": "application/json" },
          status: 200
        })
      )
    ) as unknown as typeof fetch;

    await expect(
      runLauncher(["update"], {
        execute: () => Promise.resolve(17),
        fetch: registryFetch,
        packageDirectory: root,
        stderr: (message) => errors.push(message),
        stdout: () => undefined
      })
    ).resolves.toBe(17);
    expect(errors).toEqual([
      "AgentLab update failed; npm did not complete the requested update.\n"
    ]);
  });

  it("rejects unsupported update arguments before contacting npm", async () => {
    const root = await packageFixture(new TextEncoder().encode("binary"));
    const fetchImplementation = vi.fn();
    await expect(
      runLauncher(["update", "--force"], {
        fetch: fetchImplementation as unknown as typeof fetch,
        packageDirectory: root
      })
    ).rejects.toThrow("Usage: agentlab update [--check]");
    expect(fetchImplementation).not.toHaveBeenCalled();
  });
});
