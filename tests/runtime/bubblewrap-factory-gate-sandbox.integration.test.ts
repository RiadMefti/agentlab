import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { FactoryWorkspace } from "../../packages/runtime/src/domain/factory-workspace.js";
import { BubblewrapFactoryGateSandbox } from "../../packages/runtime/src/infrastructure/process/bubblewrap-factory-gate-sandbox.js";
import { NodeCommandRunner } from "../../packages/runtime/src/infrastructure/process/command-runner.js";

const runLive = process.platform === "linux" && process.env.AGENTLAB_RUN_FACTORY_SANDBOX === "1";
const bubblewrapExecutable = "/usr/bin/bwrap";
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe.runIf(runLive)("BubblewrapFactoryGateSandbox integration", () => {
  it("provides workspace-only writes, read-only dependencies, and a distinct network namespace", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "agentlab-live-bubblewrap-")));
    temporaryRoots.push(root);
    const repositoryRoot = join(root, "repository");
    const workspaceRoot = join(root, "workspace");
    mkdirSync(join(repositoryRoot, "node_modules"), { recursive: true });
    mkdirSync(workspaceRoot);
    const workspace = fakeWorkspace(repositoryRoot, workspaceRoot);
    const runtimeRoot = dirname(dirname(realpathSync(process.execPath)));
    const sandbox = new BubblewrapFactoryGateSandbox({
      executable: bubblewrapExecutable,
      runtimeRoots: [runtimeRoot]
    });
    const wrapped = await sandbox.wrap(
      {
        executable: realpathSync(process.execPath),
        args: ["-e", probe(repositoryRoot)]
      },
      workspace
    );

    const result = await new NodeCommandRunner().run(wrapped.executable, wrapped.args, {
      timeoutMs: 10_000,
      cleanupProcessTree: true,
      maxBufferBytes: 16_384
    });
    const observed = JSON.parse(result.stdout) as {
      readonly cwd: string;
      readonly home: string | null;
      readonly networkNamespace: string;
      readonly dependencyWritable: boolean;
      readonly sourceVisible: boolean;
      readonly workspaceWritable: boolean;
    };

    expect(observed).toMatchObject({
      cwd: "/workspace",
      home: "/tmp/home",
      dependencyWritable: false,
      sourceVisible: false,
      workspaceWritable: true
    });
    expect(observed.networkNamespace).not.toBe(readlinkSync("/proc/self/ns/net"));
    expect(existsSync(join(workspaceRoot, "node_modules", "probe"))).toBe(false);
    expect(readFileSync(join(workspaceRoot, "sandbox-output.txt"), "utf8")).toBe("ok\n");
  });
});

function fakeWorkspace(repositoryRoot: string, root: string): FactoryWorkspace {
  return {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    taskId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    attempt: 1,
    repositoryRoot,
    root,
    baseRevision: "a".repeat(40),
    closeAndWait: () => Promise.resolve()
  };
}

function probe(repositoryRoot: string): string {
  return `
const fs = require("node:fs");
let dependencyWritable = true;
try {
  fs.writeFileSync("/workspace/node_modules/probe", "unsafe");
} catch {
  dependencyWritable = false;
}
let workspaceWritable = true;
try {
  fs.writeFileSync("/workspace/sandbox-output.txt", "ok\\n");
} catch {
  workspaceWritable = false;
}
process.stdout.write(JSON.stringify({
  cwd: process.cwd(),
  home: process.env.HOME ?? null,
  networkNamespace: fs.readlinkSync("/proc/self/ns/net"),
  dependencyWritable,
  sourceVisible: fs.existsSync(${JSON.stringify(repositoryRoot)}),
  workspaceWritable
}));
`;
}
