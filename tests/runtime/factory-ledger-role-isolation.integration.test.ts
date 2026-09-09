import { spawnSync, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { ledgerOperationSeed } from "../helpers/factory-ledger-operations.js";

describe.skipIf(process.env.AGENTLAB_RUN_FACTORY_ROLE_ISOLATION !== "1")(
  "single-owner ledger cross-UID reads, artifact transfers and operator writes",
  () => {
    it("serves exact tasks and eight-MiB artifacts to isolated worker/broker UIDs while denying raw storage, forgeries, and strangers", () => {
      const sourceRoot = mkdtempSync("/tmp/agentlab-ledger-source-");
      const source = join(sourceRoot, "source");
      mkdirSync(source);
      const git = (...args: string[]) =>
        execFileSync("/usr/bin/git", args, {
          cwd: source,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"]
        }).trim();
      try {
        git("init", "--initial-branch=main");
        git("config", "user.name", "Ledger Fixture");
        git("config", "user.email", "fixture@example.invalid");
        git("config", "commit.gpgsign", "false");
        mkdirSync(join(source, "tests"));
        writeFileSync(join(source, "tests", "fixture.txt"), "original\n");
        git("add", "tests/fixture.txt");
        git("commit", "-m", "Fixture base");
        const seed = ledgerOperationSeed(new Date().toISOString(), 2, git("rev-parse", "HEAD"));
        const result = spawnSync(
          "/usr/bin/unshare",
          [
            "--user",
            "--map-root-user",
            "--map-auto",
            "--fork",
            "--kill-child",
            process.execPath,
            fileURLToPath(new URL("../fixtures/probe-factory-ledger-roles.ts", import.meta.url))
          ],
          {
            encoding: "utf8",
            timeout: 60_000,
            killSignal: "SIGKILL",
            maxBuffer: 1_048_576,
            env: {
              PATH: "/usr/bin:/bin",
              NODE_NO_WARNINGS: "1",
              TMPDIR: "/tmp",
              AGENTLAB_LEDGER_PROOF_SEED: JSON.stringify({ ...seed, job: seed.job.value }),
              AGENTLAB_LEDGER_PROOF_SOURCE: source
            }
          }
        );
        expect(result.error).toBeUndefined();
        expect(result.status, result.stderr).toBe(0);
        const output: unknown = JSON.parse(result.stdout);
        expect(output).toEqual({
          ownerUid: 1,
          clients: [2, 3, 4].map((uid) => ({
            uid,
            taskRead: uid !== 4,
            authorityRead: uid !== 4,
            forgedOperationDenied: true,
            authorityChangeDenied: true,
            artifactSubmit: uid === 2,
            artifactReplayStable: uid === 2,
            artifactRead: uid !== 4,
            operationExecuted: uid === 2,
            operationReplayDenied: uid === 2,
            operationAccessDenied: uid !== 2,
            directArtifactDenied: true,
            directDatabaseDenied: true,
            directLeaseDenied: true
          })),
          operator: {
            uid: 5,
            applied: true,
            replayStable: true,
            lateReplayDidNotEnable: true,
            staleStateRejected: true,
            directDatabaseDenied: true,
            directLeaseDenied: true
          }
        });
      } finally {
        rmSync(sourceRoot, { recursive: true, force: true });
      }
    }, 65_000);
  }
);
