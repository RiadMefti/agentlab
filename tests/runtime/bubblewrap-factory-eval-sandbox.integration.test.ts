import { existsSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { BubblewrapFactoryEvalSandbox } from "../../packages/runtime/src/infrastructure/process/bubblewrap-factory-eval-sandbox.js";
import { NodeCommandRunner } from "../../packages/runtime/src/infrastructure/process/command-runner.js";

const runLive = process.platform === "linux" && process.env.AGENTLAB_RUN_FACTORY_SANDBOX === "1";
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe.runIf(runLive)("BubblewrapFactoryEvalSandbox integration", () => {
  it("exposes one writable workspace with no home, host root, or shared network namespace", async () => {
    const workspace = realpathSync(mkdtempSync(join(tmpdir(), "agentlab-live-eval-sandbox-")));
    temporaryRoots.push(workspace);
    const runtimeRoot = dirname(dirname(realpathSync(process.execPath)));
    const sandbox = new BubblewrapFactoryEvalSandbox({
      executable: "/usr/bin/bwrap",
      runtimeRoots: [runtimeRoot]
    });
    const command = await sandbox.wrap(
      {
        executable: realpathSync(process.execPath),
        args: ["-e", probe(workspace)]
      },
      workspace
    );

    const result = await new NodeCommandRunner().run(command.executable, command.args, {
      timeoutMs: 10_000,
      cleanupProcessTree: true,
      maxBufferBytes: 16_384
    });
    const observed = JSON.parse(result.stdout) as {
      readonly cwd: string;
      readonly home: string | null;
      readonly hostWorkspaceVisible: boolean;
      readonly hostHomeVisible: boolean;
      readonly networkNamespace: string;
      readonly workspaceWritable: boolean;
    };

    expect(observed).toMatchObject({
      cwd: "/workspace",
      home: "/tmp/home",
      hostWorkspaceVisible: false,
      hostHomeVisible: false,
      workspaceWritable: true
    });
    expect(observed.networkNamespace).not.toBe(readlinkSync("/proc/self/ns/net"));
    expect(readFileSync(join(workspace, "sandbox-output"), "utf8")).toBe("ok\n");
    expect(existsSync(join(workspace, "home"))).toBe(false);
  });
});

function probe(hostWorkspace: string): string {
  return `
const fs = require("node:fs");
let workspaceWritable = true;
try {
  fs.writeFileSync("/workspace/sandbox-output", "ok\\n", { mode: 0o600 });
} catch {
  workspaceWritable = false;
}
process.stdout.write(JSON.stringify({
  cwd: process.cwd(),
  home: process.env.HOME ?? null,
  hostWorkspaceVisible: fs.existsSync(${JSON.stringify(hostWorkspace)}),
  hostHomeVisible: fs.existsSync("/home"),
  networkNamespace: fs.readlinkSync("/proc/self/ns/net"),
  workspaceWritable
}));
`;
}
