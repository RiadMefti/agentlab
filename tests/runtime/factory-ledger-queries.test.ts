import { describe, expect, it, vi } from "vitest";

import { FactoryLedgerQueries } from "../../packages/runtime/src/application/factory-ledger-queries.js";
import { factoryLedgerReadPolicyDigest } from "../../packages/runtime/src/infrastructure/filesystem/local-factory-ledger-config.js";
import { NodeFactoryDocumentCodec } from "../../packages/runtime/src/infrastructure/persistence/canonical-factory-documents.js";
import { SqliteFactoryRepository } from "../../packages/runtime/src/infrastructure/persistence/sqlite-factory-repository.js";
import {
  testDigest,
  testEvidenceBundle,
  testFactoryContract,
  testTaskEvent
} from "../helpers/factory.js";

function fixture() {
  const documents = new NodeFactoryDocumentCodec();
  const contract = documents.taskContract(testFactoryContract());
  const policy = {
    schemaVersion: "agentlab.ledger-read-policy.v1" as const,
    expiresAt: "2026-09-08T12:00:00.000Z",
    principals: [
      {
        uid: 1001,
        id: "worker",
        role: "worker" as const,
        tasks: [{ taskId: contract.value.taskId, contractDigest: contract.digest }]
      }
    ]
  };
  const controls = {
    state: vi.fn(() => Promise.resolve({ scheduler: false, prBroker: false, mergeBroker: false }))
  };
  const tasks = { findById: vi.fn(() => Promise.resolve(null)) };
  const now = vi.fn(() => "2026-09-08T11:00:00.000Z");
  const policyDigest = factoryLedgerReadPolicyDigest(policy);
  const request = {
    schemaVersion: "agentlab.ledger-read-request.v1",
    requestId: "33333333-3333-4333-8333-333333333333",
    peerPolicyDigest: policyDigest,
    operation: "task.read",
    taskId: contract.value.taskId,
    contractDigest: contract.digest
  };
  return { documents, contract, policy, policyDigest, controls, tasks, now, request };
}

describe("single-owner ledger read capabilities", () => {
  it("reads an exact immutable task from the real repository without changing its ledger", async () => {
    const f = fixture();
    const repository = new SqliteFactoryRepository(":memory:");
    try {
      const snapshot = await repository.create(
        f.contract,
        f.documents.taskEvent(
          testTaskEvent({
            eventId: "33333333-3333-4333-8333-333333333333",
            contractDigest: f.contract.digest,
            sequence: 1,
            from: null,
            to: "intake",
            previousEventDigest: null
          })
        ),
        f.documents.evidenceBundle(
          testEvidenceBundle({
            bundleId: "55555555-5555-4555-8555-555555555555",
            contractDigest: f.contract.digest,
            sequence: 1,
            previousBundleDigest: null
          })
        )
      );
      const queries = new FactoryLedgerQueries({ ...f, tasks: repository, controls: repository });
      await expect(queries.execute(1001, f.request)).resolves.toMatchObject({
        status: "task",
        snapshot
      });
      expect(await repository.listEvents(f.contract.value.taskId)).toHaveLength(1);
      await expect(
        queries.execute(1001, {
          schemaVersion: f.request.schemaVersion,
          requestId: f.request.requestId,
          peerPolicyDigest: f.policyDigest,
          operation: "authority.read"
        })
      ).resolves.toMatchObject({
        status: "authority",
        scheduler: false,
        prBroker: false,
        mergeBroker: false
      });
    } finally {
      repository.close();
    }
  });

  it("denies wrong UIDs, stale policy pins, ungranted tasks and expired grants before storage access", async () => {
    const f = fixture();
    const queries = new FactoryLedgerQueries(f);
    for (const [uid, request] of [
      [1002, f.request],
      [1001, { ...f.request, peerPolicyDigest: testDigest("f") }],
      [1001, { ...f.request, contractDigest: testDigest("e") }],
      [1001, { ...f.request, taskId: "77777777-7777-4777-8777-777777777777" }]
    ] as const) {
      await expect(queries.execute(uid, request)).resolves.toMatchObject({ status: "denied" });
    }
    f.now.mockReturnValue(f.policy.expiresAt);
    await expect(queries.execute(1001, f.request)).resolves.toMatchObject({ status: "denied" });
    expect(f.tasks.findById).not.toHaveBeenCalled();
    expect(f.controls.state).not.toHaveBeenCalled();
  });

  it("does not accept claimed actor identities, arbitrary operations, unknown fields or malformed input", async () => {
    const f = fixture();
    const queries = new FactoryLedgerQueries(f);
    for (const input of [
      null,
      [],
      "{}",
      { ...f.request, actor: { role: "operator" } },
      { ...f.request, uid: 1001 },
      { ...f.request, operation: "authority.enable" },
      { ...f.request, operation: "task.transition", nextState: "pr-ready" }
    ]) {
      await expect(queries.execute(1001, input)).resolves.toMatchObject({
        status: "denied",
        requestId: null
      });
    }
    expect(f.tasks.findById).not.toHaveBeenCalled();
    expect(f.controls.state).not.toHaveBeenCalled();
  });

  it("rejects duplicate principal identities and does not retain caller-mutable grants", async () => {
    const f = fixture();
    expect(
      () =>
        new FactoryLedgerQueries({
          ...f,
          policy: { ...f.policy, principals: [...f.policy.principals, ...f.policy.principals] }
        })
    ).toThrow(/distinct/u);
    const queries = new FactoryLedgerQueries(f);
    f.policy.principals.push({
      uid: 1002,
      id: "other",
      role: "worker",
      tasks: f.policy.principals[0]?.tasks ?? []
    });
    await expect(queries.execute(1002, f.request)).resolves.toMatchObject({ status: "denied" });
    expect(f.tasks.findById).not.toHaveBeenCalled();
  });
});
