import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { FactoryLedgerAuthorityPolicy, FactoryLedgerReadPolicy } from "@agentlab/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { FactoryLedgerAuthority } from "../../packages/runtime/src/application/factory-ledger-authority.js";
import {
  encodeCanonicalDocument,
  NodeFactoryDocumentCodec
} from "../../packages/runtime/src/infrastructure/persistence/canonical-factory-documents.js";
import { SqliteFactoryRepository } from "../../packages/runtime/src/infrastructure/persistence/sqlite-factory-repository.js";
import { latestSchemaVersion } from "../../packages/runtime/src/infrastructure/persistence/migrations.js";
import { testControlEvent, testDigest } from "../helpers/factory.js";

const fixtures: { root: string; repository: SqliteFactoryRepository }[] = [];
afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    fixture.repository.close();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "agentlab-ledger-authority-"));
  const path = join(root, "factory.sqlite");
  const repository = new SqliteFactoryRepository(path);
  fixtures.push({ root, repository });
  const peerPolicy: FactoryLedgerReadPolicy = {
    schemaVersion: "agentlab.ledger-read-policy.v1",
    expiresAt: "2026-09-08T12:00:00.000Z",
    principals: [
      { uid: 1001, id: "maintainer", role: "operator", tasks: [] },
      { uid: 1002, id: "worker", role: "worker", tasks: [] }
    ]
  };
  const authorityPolicy: FactoryLedgerAuthorityPolicy = {
    schemaVersion: "agentlab.ledger-authority-policy.v1",
    expiresAt: peerPolicy.expiresAt,
    grants: [
      {
        uid: 1001,
        id: "maintainer",
        controls: [
          { control: "scheduler", allowEnable: true },
          { control: "pr-broker", allowEnable: false }
        ]
      }
    ]
  };
  const now = vi.fn(() => "2026-09-08T11:00:00.000Z");
  const dependencies = {
    peerPolicy,
    peerPolicyDigest: encodeCanonicalDocument(peerPolicy).digest,
    authorityPolicy,
    authorityPolicyDigest: encodeCanonicalDocument(authorityPolicy).digest,
    repository,
    documents: new NodeFactoryDocumentCodec(),
    encode: encodeCanonicalDocument,
    now,
    createId: randomUUID
  };
  const service = new FactoryLedgerAuthority(dependencies);
  const request = {
    schemaVersion: "agentlab.ledger-authority-request.v1" as const,
    requestId: randomUUID(),
    peerPolicyDigest: dependencies.peerPolicyDigest,
    authorityPolicyDigest: dependencies.authorityPolicyDigest,
    operation: "authority.change" as const,
    command: {
      idempotencyKey: randomUUID(),
      expiresAt: "2026-09-08T11:01:00.000Z",
      control: "scheduler" as const,
      enabled: true,
      expectedEnabled: false,
      expectedEventDigest: null,
      confirmation: "enable-scheduler" as const,
      reason: "Bounded operator canary."
    }
  };
  return { root, path, repository, service, request, now, dependencies };
}

describe("ledger authority commands", () => {
  it("upgrades a disposable schema-31 layout without changing existing control records", async () => {
    const f = fixture();
    const event = new NodeFactoryDocumentCodec().controlEvent(
      testControlEvent({
        eventId: randomUUID(),
        control: "scheduler",
        enabled: true
      })
    );
    await f.repository.record(event);
    const before = await f.repository.history(event.value.control, 20);
    const raw = new DatabaseSync(f.path);
    try {
      // Reconstruct the preceding layout only inside this fresh, test-owned database.
      raw.exec(
        "DROP TABLE factory_ledger_artifact_reservations; DROP TABLE factory_ledger_authority_receipts; PRAGMA user_version = 31;"
      );
    } finally {
      raw.close();
    }
    const upgraded = new SqliteFactoryRepository(f.path);
    try {
      expect(await upgraded.history(event.value.control, 20)).toEqual(before);
      await expect(upgraded.findAuthorityReceipt(1001, randomUUID())).resolves.toBeNull();
      const check = new DatabaseSync(f.path);
      try {
        expect(check.prepare("PRAGMA user_version").get()).toMatchObject({
          user_version: latestSchemaVersion
        });
        expect(check.prepare("PRAGMA quick_check").get()).toMatchObject({ quick_check: "ok" });
      } finally {
        check.close();
      }
    } finally {
      upgraded.close();
    }
  });

  it("records one human change, replays its receipt, and never re-enables after a later disable", async () => {
    const f = fixture();
    const first = await f.service.execute(1001, f.request);
    expect(first.status).toBe("receipt");
    if (first.status !== "receipt") throw new Error("Expected receipt.");
    expect(first.receipt).toMatchObject({
      outcome: "applied",
      head: { enabled: true, event: { actor: { id: "maintainer", kind: "human" } } }
    });
    const replay = await f.service.execute(1001, { ...f.request, requestId: randomUUID() });
    expect(replay).toMatchObject({ receiptDigest: first.receiptDigest });
    const disabled = await f.service.execute(1001, {
      ...f.request,
      requestId: randomUUID(),
      command: {
        ...f.request.command,
        idempotencyKey: randomUUID(),
        expectedEnabled: true,
        expectedEventDigest: first.receipt.head.eventDigest,
        enabled: false,
        confirmation: "disable-scheduler"
      }
    });
    expect(disabled).toMatchObject({
      status: "receipt",
      receipt: { outcome: "applied", head: { enabled: false } }
    });
    await expect(f.service.execute(1001, f.request)).resolves.toMatchObject({
      receiptDigest: first.receiptDigest
    });
    expect(await f.repository.state()).toMatchObject({ scheduler: false });
    expect(await f.repository.history("scheduler", 20)).toHaveLength(2);
    // A new key with an old off-state snapshot must not bypass a disable/enable/disable cycle.
    await expect(
      f.service.execute(1001, {
        ...f.request,
        command: { ...f.request.command, idempotencyKey: randomUUID() }
      })
    ).resolves.toMatchObject({ receipt: { outcome: "conflict" } });
    expect(await f.repository.history("scheduler", 20)).toHaveLength(2);
  });

  it("denies workers, stale pins, ungranted controls and disable-only escalation before persistence", async () => {
    const f = fixture();
    const writes = vi.spyOn(f.repository, "changeAuthority");
    for (const [uid, request] of [
      [1002, f.request],
      [1003, f.request],
      [1001, { ...f.request, peerPolicyDigest: testDigest("a") }],
      [1001, { ...f.request, authorityPolicyDigest: testDigest("b") }],
      [
        1001,
        {
          ...f.request,
          command: {
            ...f.request.command,
            control: "pr-broker",
            confirmation: "enable-draft-broker"
          }
        }
      ],
      [
        1001,
        {
          ...f.request,
          command: {
            ...f.request.command,
            control: "merge-broker",
            confirmation: "enable-autonomous-merge"
          }
        }
      ]
    ] as const) {
      await expect(f.service.execute(uid, request)).resolves.toMatchObject({ status: "denied" });
    }
    expect(writes).not.toHaveBeenCalled();
  });

  it("reconciles an expired command by receipt without executing it again", async () => {
    const f = fixture();
    const result = await f.service.execute(1001, f.request);
    if (result.status !== "receipt") throw new Error("Expected receipt.");
    f.now.mockReturnValue("2026-09-08T11:02:00.000Z");
    await expect(f.service.execute(1001, f.request)).resolves.toMatchObject({ status: "denied" });
    const envelope = {
      schemaVersion: f.request.schemaVersion,
      requestId: randomUUID(),
      peerPolicyDigest: f.request.peerPolicyDigest,
      authorityPolicyDigest: f.request.authorityPolicyDigest
    };
    await expect(
      f.service.execute(1001, {
        ...envelope,
        operation: "authority.receipt",
        idempotencyKey: f.request.command.idempotencyKey,
        intentDigest: result.receipt.intentDigest
      })
    ).resolves.toMatchObject({ receiptDigest: result.receiptDigest });
    expect(await f.repository.history("scheduler", 20)).toHaveLength(1);
    f.now.mockReturnValue(f.dependencies.authorityPolicy.expiresAt);
    await expect(
      f.service.execute(1001, { ...envelope, operation: "authority.inspect" })
    ).resolves.toMatchObject({ status: "denied" });
  });

  it("rejects identity injection, no-ops, mismatched confirmations and excessive command lifetimes", async () => {
    const f = fixture();
    for (const request of [
      { ...f.request, actor: { id: "maintainer", role: "operator" } },
      { ...f.request, uid: 1001 },
      { ...f.request, command: { ...f.request.command, expectedEnabled: true } },
      { ...f.request, command: { ...f.request.command, confirmation: "disable-scheduler" } },
      { ...f.request, command: { ...f.request.command, expiresAt: "2026-09-08T11:03:00.000Z" } }
    ])
      await expect(f.service.execute(1001, request)).resolves.toMatchObject({ status: "denied" });
    expect(await f.repository.history("scheduler", 20)).toHaveLength(0);
  });

  it("refuses rebinding an idempotency key to different command bytes", async () => {
    const f = fixture();
    await f.service.execute(1001, f.request);
    await expect(
      f.service.execute(1001, {
        ...f.request,
        command: {
          ...f.request.command,
          reason: "A different intent."
        }
      })
    ).resolves.toMatchObject({ status: "denied" });
    expect(await f.repository.history("scheduler", 20)).toHaveLength(1);
  });

  it("rolls back the event when receipt persistence fails, then safely retries", async () => {
    const f = fixture();
    const raw = new DatabaseSync(f.path);
    try {
      raw.exec(
        "CREATE TRIGGER test_receipt_failure BEFORE INSERT ON factory_ledger_authority_receipts BEGIN SELECT RAISE(ABORT, 'injected receipt failure'); END"
      );
      await expect(f.service.execute(1001, f.request)).rejects.toThrow(/injected receipt/u);
      expect(await f.repository.history("scheduler", 20)).toHaveLength(0);
      await expect(
        f.repository.findAuthorityReceipt(1001, f.request.command.idempotencyKey)
      ).resolves.toBeNull();
      raw.exec("DROP TRIGGER test_receipt_failure");
      await expect(f.service.execute(1001, f.request)).resolves.toMatchObject({
        receipt: { outcome: "applied" }
      });
      expect(await f.repository.history("scheduler", 20)).toHaveLength(1);
    } finally {
      raw.close();
    }
  });

  it("rechecks the deadline after acquiring the transaction instead of using admission time", async () => {
    const f = fixture();
    f.now
      .mockReturnValueOnce("2026-09-08T11:00:00.000Z")
      .mockReturnValue("2026-09-08T11:01:00.000Z");
    await expect(f.service.execute(1001, f.request)).resolves.toMatchObject({ status: "denied" });
    expect(await f.repository.history("scheduler", 20)).toHaveLength(0);
    await expect(
      f.repository.findAuthorityReceipt(1001, f.request.command.idempotencyKey)
    ).resolves.toBeNull();
  });

  it("retains receipts across reopen and rejects tampering and direct receipt replacement", async () => {
    const f = fixture();
    const result = await f.service.execute(1001, f.request);
    if (result.status !== "receipt") throw new Error("Expected receipt.");
    const reopened = new SqliteFactoryRepository(f.path);
    try {
      await expect(
        reopened.findAuthorityReceipt(1001, f.request.command.idempotencyKey)
      ).resolves.toMatchObject({ digest: result.receiptDigest });
    } finally {
      reopened.close();
    }
    const raw = new DatabaseSync(f.path);
    try {
      expect(() => {
        raw.exec("DELETE FROM factory_ledger_authority_receipts");
      }).toThrow(/immutable/u);
      expect(() => {
        raw.exec("UPDATE factory_ledger_authority_receipts SET recorded_at = 'bad'");
      }).toThrow(/immutable/u);
      raw.exec("DROP TRIGGER factory_ledger_authority_receipts_no_update");
      raw.exec(
        "UPDATE factory_ledger_authority_receipts SET receipt_digest = 'sha256:' || printf('%064d', 0)"
      );
      expect(() =>
        f.repository.findAuthorityReceipt(1001, f.request.command.idempotencyKey)
      ).toThrow(/identity/u);
    } finally {
      raw.close();
    }
  });

  it("refuses a policy that grants authority to a worker or is not bound to its claimed digest", () => {
    const f = fixture();
    expect(
      () =>
        new FactoryLedgerAuthority({ ...f.dependencies, authorityPolicyDigest: testDigest("c") })
    ).toThrow(/pinned/u);
    const authorityPolicy = {
      ...f.dependencies.authorityPolicy,
      grants: [
        {
          uid: 1002,
          id: "worker",
          controls: [{ control: "scheduler" as const, allowEnable: true }]
        }
      ]
    };
    expect(
      () =>
        new FactoryLedgerAuthority({
          ...f.dependencies,
          authorityPolicy,
          authorityPolicyDigest: encodeCanonicalDocument(authorityPolicy).digest
        })
    ).toThrow(/operator/u);
  });
});
