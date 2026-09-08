import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { NodeFactoryDocumentCodec } from "../../packages/runtime/src/infrastructure/persistence/canonical-factory-documents.js";
import { testEvidenceBundle, testFactoryContract, testTaskEvent } from "../helpers/factory.js";

describe.skipIf(process.env.AGENTLAB_RUN_FACTORY_ROLE_ISOLATION !== "1")(
  "single-owner ledger cross-UID reads",
  () => {
    it("serves exact tasks to isolated worker/broker UIDs while denying raw storage, forgeries, and strangers", () => {
      const contract = new NodeFactoryDocumentCodec().taskContract(testFactoryContract());
      const seed = {
        contract: contract.value,
        event: testTaskEvent({
          eventId: "33333333-3333-4333-8333-333333333333",
          contractDigest: contract.digest,
          sequence: 1,
          from: null,
          to: "intake",
          previousEventDigest: null
        }),
        evidence: testEvidenceBundle({
          bundleId: "55555555-5555-4555-8555-555555555555",
          contractDigest: contract.digest,
          sequence: 1,
          previousBundleDigest: null
        })
      };
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
          directDatabaseDenied: true,
          directLeaseDenied: true
        }))
      });
    }, 45_000);
  }
);
