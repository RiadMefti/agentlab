import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { NodeFactoryDocumentCodec } from "../../packages/runtime/src/infrastructure/persistence/canonical-factory-documents.js";
import { SqliteFactoryRepository } from "../../packages/runtime/src/infrastructure/persistence/sqlite-factory-repository.js";
import {
  testControlEvent,
  testEvidenceBundle,
  testFactoryContract,
  testTaskEvent
} from "../helpers/factory.js";

const codec = new NodeFactoryDocumentCodec();
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe("SqliteFactoryRepository", () => {
  it("creates a contract and appends a hash-chained legal transition", async () => {
    const repository = new SqliteFactoryRepository(":memory:");
    const contract = codec.taskContract(testFactoryContract());
    const initial = codec.taskEvent(
      testTaskEvent({
        contractDigest: contract.digest,
        eventId: "33333333-3333-4333-8333-333333333333",
        sequence: 1,
        previousEventDigest: null,
        from: null,
        to: "intake"
      })
    );
    const registrationEvidence = initialEvidence(contract.digest);

    try {
      await expect(
        repository.create(contract, initial, registrationEvidence)
      ).resolves.toMatchObject({
        state: "intake",
        sequence: 1,
        lastEventDigest: initial.digest
      });
      const qualified = codec.taskEvent(
        testTaskEvent({
          contractDigest: contract.digest,
          eventId: "77777777-7777-4777-8777-777777777777",
          sequence: 2,
          previousEventDigest: initial.digest,
          from: "intake",
          to: "qualified"
        })
      );
      await expect(repository.append(qualified)).resolves.toMatchObject({
        state: "qualified",
        sequence: 2,
        lastEventDigest: qualified.digest
      });
      await expect(repository.append(qualified)).resolves.toBeNull();
      await expect(repository.listEvents(contract.value.taskId)).resolves.toHaveLength(2);
      await expect(repository.findById(contract.value.taskId)).resolves.toMatchObject({
        contract: contract.value,
        contractDigest: contract.digest,
        state: "qualified"
      });
      await expect(
        repository.listForConversation(contract.value.conversationId, 10)
      ).resolves.toHaveLength(1);

      const secondBundle = codec.evidenceBundle(
        testEvidenceBundle({
          contractDigest: contract.digest,
          bundleId: "66666666-6666-4666-8666-666666666666",
          sequence: 2,
          previousBundleDigest: registrationEvidence.digest
        })
      );
      await expect(repository.appendEvidence(secondBundle)).resolves.toMatchObject({
        digest: secondBundle.digest
      });
      await expect(repository.appendEvidence(secondBundle)).resolves.toBeNull();
      await expect(repository.latestEvidence(contract.value.taskId)).resolves.toMatchObject({
        digest: secondBundle.digest
      });
      await expect(repository.listEvidence(contract.value.taskId)).resolves.toHaveLength(2);
    } finally {
      repository.close();
    }
  });

  it("rejects a forged document claim and an illegal transition", async () => {
    const repository = new SqliteFactoryRepository(":memory:");
    const contract = codec.taskContract(testFactoryContract());
    const initial = codec.taskEvent(
      testTaskEvent({
        contractDigest: contract.digest,
        eventId: "33333333-3333-4333-8333-333333333333",
        sequence: 1,
        previousEventDigest: null,
        from: null,
        to: "intake"
      })
    );
    const registrationEvidence = initialEvidence(contract.digest);

    try {
      expect(() =>
        repository.create({ ...contract, json: "{}" }, initial, registrationEvidence)
      ).toThrow(/does not match/u);
      await repository.create(contract, initial, registrationEvidence);
      const illegal = codec.taskEvent(
        testTaskEvent({
          contractDigest: contract.digest,
          eventId: "77777777-7777-4777-8777-777777777777",
          sequence: 2,
          previousEventDigest: initial.digest,
          from: "intake",
          to: "merged"
        })
      );
      expect(() => repository.append(illegal)).toThrow(/Illegal factory task transition/u);
    } finally {
      repository.close();
    }
  });

  it("keeps scheduler and PR broker disabled until a human enables each control", async () => {
    const repository = new SqliteFactoryRepository(":memory:");
    try {
      await expect(repository.state()).resolves.toEqual({ scheduler: false, prBroker: false });
      const enabled = codec.controlEvent(
        testControlEvent({
          eventId: "88888888-8888-4888-8888-888888888888",
          control: "scheduler",
          enabled: true
        })
      );
      await expect(repository.record(enabled)).resolves.toEqual({
        scheduler: true,
        prBroker: false
      });
      await expect(repository.history("scheduler", 10)).resolves.toEqual([enabled.value]);
      expect(() =>
        codec.controlEvent({
          ...enabled.value,
          eventId: "99999999-9999-4999-8999-999999999999",
          control: "pr-broker",
          actor: { ...enabled.value.actor, kind: "agent" }
        })
      ).toThrow(/Only a human/u);
    } finally {
      repository.close();
    }
  });

  it("atomically compares authority state before appending a control event", async () => {
    const repository = new SqliteFactoryRepository(":memory:");
    const enable = codec.controlEvent(
      testControlEvent({
        eventId: "88888888-8888-4888-8888-888888888888",
        control: "pr-broker",
        enabled: true
      })
    );
    const staleDisable = codec.controlEvent(
      testControlEvent({
        eventId: "99999999-9999-4999-8999-999999999999",
        control: "pr-broker",
        enabled: false
      })
    );
    const disable = codec.controlEvent(
      testControlEvent({
        eventId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        control: "pr-broker",
        enabled: false
      })
    );

    try {
      await expect(repository.record(enable, false)).resolves.toEqual({
        scheduler: false,
        prBroker: true
      });
      await expect(repository.record(staleDisable, false)).resolves.toBeNull();
      await expect(repository.history("pr-broker", 10)).resolves.toEqual([enable.value]);
      await expect(repository.record(disable, true)).resolves.toEqual({
        scheduler: false,
        prBroker: false
      });
      await expect(repository.history("pr-broker", 10)).resolves.toEqual([
        disable.value,
        enable.value
      ]);
    } finally {
      repository.close();
    }
  });

  it("enforces append-only task rows at the SQLite boundary", async () => {
    const databasePath = temporaryDatabase("agentlab-factory-ledger-");
    const repository = new SqliteFactoryRepository(databasePath);
    const contract = codec.taskContract(testFactoryContract());
    const initial = codec.taskEvent(
      testTaskEvent({
        contractDigest: contract.digest,
        eventId: "33333333-3333-4333-8333-333333333333",
        sequence: 1,
        previousEventDigest: null,
        from: null,
        to: "intake"
      })
    );
    const registrationEvidence = initialEvidence(contract.digest);
    try {
      await repository.create(contract, initial, registrationEvidence);
      const database = new DatabaseSync(databasePath);
      try {
        expect(() =>
          database.prepare("UPDATE factory_task_events SET to_state = 'merged'").run()
        ).toThrow(/append-only/u);
        expect(() => database.prepare("DELETE FROM factory_task_contracts").run()).toThrow(
          /immutable/u
        );
      } finally {
        database.close();
      }
    } finally {
      repository.close();
    }
  });
});

function temporaryDatabase(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  temporaryRoots.push(root);
  return join(root, "agentlab.sqlite");
}

function initialEvidence(contractDigest: string) {
  return codec.evidenceBundle(
    testEvidenceBundle({
      contractDigest,
      bundleId: "55555555-5555-4555-8555-555555555555",
      sequence: 1,
      previousBundleDigest: null
    })
  );
}
