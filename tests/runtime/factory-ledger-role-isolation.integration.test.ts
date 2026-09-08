import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { ledgerArtifactSeed } from "../helpers/factory-ledger-artifacts.js";

describe.skipIf(process.env.AGENTLAB_RUN_FACTORY_ROLE_ISOLATION !== "1")(
  "single-owner ledger cross-UID reads, artifact transfers and operator writes",
  () => {
    it("serves exact tasks and eight-MiB artifacts to isolated worker/broker UIDs while denying raw storage, forgeries, and strangers", () => {
      const seed = ledgerArtifactSeed(new Date().toISOString());
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
          timeout: 40_000,
          killSignal: "SIGKILL",
          maxBuffer: 1_048_576,
          env: {
            PATH: "/usr/bin:/bin",
            NODE_NO_WARNINGS: "1",
            TMPDIR: "/tmp",
            AGENTLAB_LEDGER_PROOF_SEED: JSON.stringify(seed)
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
    }, 45_000);
  }
);
