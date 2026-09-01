import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

import { afterEach, describe, expect, it } from "vitest";

import { compileFactoryDailyCyclePlan } from "../../packages/runtime/src/domain/factory-daily-cycle-plan.js";
import { pinnedLocalExecutableDigest } from "../../packages/runtime/src/infrastructure/filesystem/pinned-local-executable.js";
import { renderSystemdFactoryDailyCycle } from "../../packages/runtime/src/infrastructure/process/systemd-factory-daily-cycle-renderer.js";
import { testFactoryRoleIdentityPolicy } from "../helpers/factory-evaluation.js";
import { testFactorySchedulePolicy } from "../helpers/factory-schedule.js";
import { testDigest } from "../helpers/factory.js";

const temporaryRoots: string[] = [];
const runLiveProof = process.env.AGENTLAB_RUN_FACTORY_SANDBOX === "1";

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true }))
  );
});

describe.skipIf(!runLiveProof)("systemd factory daily-cycle renderer host proof", () => {
  it("passes the installed systemd unit verifier as one complete chain", async () => {
    const executable = "/usr/bin/true";
    const analyzer = "/usr/bin/systemd-analyze";
    await Promise.all([access(executable), access(analyzer)]);
    const root = await mkdtemp(join(tmpdir(), "agentlab-systemd-cycle-"));
    temporaryRoots.push(root);
    const workerUserId = process.getuid?.() ?? 1_000;
    const brokerUserId = workerUserId === 65_534 ? 1 : 65_534;
    const manifest = {
      schemaVersion: "agentlab.daily-cycle-manifest.v1",
      id: "agentlab/daily-software-factory",
      version: "1.0.0",
      agentlabExecutable: {
        path: executable,
        digest: await pinnedLocalExecutableDigest(executable, "Test AgentLab executable")
      },
      executableChecksumPath: "/etc/agentlab/factory-executable.sha256",
      worker: { userId: workerUserId, configPath: "/tmp/agentlab-worker.json" },
      broker: { userId: brokerUserId, configPath: "/tmp/agentlab-broker.json" },
      schedulePolicyPath: "/tmp/agentlab-schedule.json",
      roleIdentityPolicyPath: "/tmp/agentlab-roles.json",
      expectedSchedulePolicyDigest: testDigest("2"),
      expectedRoleIdentityPolicyDigest: testDigest("3"),
      expectedFactoryPolicyBundleDigest: testDigest("4"),
      maximumRepairRounds: 2,
      workerCommandTimeoutSeconds: 7_230,
      brokerCommandTimeoutSeconds: 900
    } as const;
    const plan = compileFactoryDailyCyclePlan(
      manifest,
      testFactorySchedulePolicy(),
      testFactoryRoleIdentityPolicy({
        keyId: testDigest("8"),
        workerUserId,
        attestorUserId: workerUserId === 1 ? 2 : 1
      })
    );
    const bundle = renderSystemdFactoryDailyCycle(manifest, plan);
    const temporaryChecksumPath = join(root, "agentlab-factory-executable.sha256");
    await writeFile(temporaryChecksumPath, bundle.executableVerification.checksumContent, {
      encoding: "utf8",
      mode: 0o600
    });
    const paths = await Promise.all(
      bundle.units.map(async (unit) => {
        const path = join(root, unit.name);
        await writeFile(path, unit.content, { encoding: "utf8", mode: 0o600 });
        return path;
      })
    );

    const verification = await run("/usr/bin/sha256sum", [
      "--status",
      "--check",
      temporaryChecksumPath
    ]);
    const result = await run(analyzer, ["verify", ...paths]);

    expect(verification.exitCode, verification.stderr).toBe(0);
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stderr).toBe("");
  });
});

async function run(
  executable: string,
  arguments_: readonly string[]
): Promise<{ readonly exitCode: number; readonly stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(executable, arguments_, {
      env: { PATH: "/usr/bin:/bin", SYSTEMD_LOG_LEVEL: "warning" },
      stdio: ["ignore", "ignore", "pipe"]
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => {
      resolve({ exitCode: code ?? 1, stderr });
    });
  });
}
