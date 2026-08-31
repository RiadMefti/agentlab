import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import type {
  FactoryActorRole,
  FactoryPreparationEvent,
  FactoryPreparationPhase
} from "@agentlab/contracts";

import type { CanonicalFactoryDocument } from "../../packages/runtime/src/domain/factory-documents.js";
import { NodeFactoryDocumentCodec } from "../../packages/runtime/src/infrastructure/persistence/canonical-factory-documents.js";
import { latestSchemaVersion } from "../../packages/runtime/src/infrastructure/persistence/migrations.js";
import { SqliteFactoryPreparationRepository } from "../../packages/runtime/src/infrastructure/persistence/sqlite-factory-preparation-repository.js";
import { testDigest } from "../helpers/factory.js";
import { testFactoryPreparationFixture } from "../helpers/factory-preparation.js";

const codec = new NodeFactoryDocumentCodec();
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe("SqliteFactoryPreparationRepository", () => {
  it("resumes a digest-linked preparation after a failed attempt", async () => {
    const fixture = testFactoryPreparationFixture();
    const repository = new SqliteFactoryPreparationRepository(":memory:");
    const request = codec.intakeRequest(fixture.request);
    const authority = codec.preparationAuthority(fixture.authority);
    const registered = registrationEvent(request.digest, authority.digest);

    try {
      await expect(repository.register(request, authority, registered)).resolves.toMatchObject({
        state: "registered",
        sequence: 1,
        lastEventDigest: registered.digest
      });
      await expect(
        repository.findByDeduplicationKey(
          request.value.repository.id,
          request.value.deduplicationKey
        )
      ).resolves.toMatchObject({
        requestDigest: request.digest,
        authorityDigest: authority.digest,
        state: "registered"
      });
      await expect(
        repository.findByDeduplicationKey("another/repository", request.value.deduplicationKey)
      ).resolves.toBeNull();

      const qualify1 = phaseStarted(registered, "qualify", 1, [request.digest], "1");
      await expect(repository.append(qualify1)).resolves.toMatchObject({ state: "qualifying" });
      const failed = phaseFailed(qualify1, "qualify", 1, "1");
      await expect(repository.append(failed)).resolves.toMatchObject({ state: "registered" });

      const qualify2 = phaseStarted(failed, "qualify", 2, [request.digest], "2");
      await repository.append(qualify2);
      const qualification = codec.qualification(fixture.qualification);
      const qualified = phaseSucceeded(qualify2, "qualify", 2, qualification, "2");
      await expect(repository.append(qualified)).resolves.toMatchObject({ state: "qualified" });

      const specify = phaseStarted(
        qualified,
        "specify",
        1,
        [request.digest, qualification.digest],
        "3"
      );
      await repository.append(specify);
      const specification = codec.specification(fixture.specification);
      const specified = phaseSucceeded(specify, "specify", 1, specification, "3");
      await repository.append(specified);

      const plan = phaseStarted(
        specified,
        "plan",
        1,
        [request.digest, qualification.digest, specification.digest],
        "4"
      );
      await repository.append(plan);
      const planDocument = codec.plan(fixture.plan);
      const planned = phaseSucceeded(plan, "plan", 1, planDocument, "4");
      await expect(repository.append(planned)).resolves.toMatchObject({
        state: "planned",
        sequence: 9,
        lastEventDigest: planned.digest
      });

      await expect(repository.findById(request.value.taskId)).resolves.toMatchObject({
        request: request.value,
        requestDigest: request.digest,
        authority: authority.value,
        authorityDigest: authority.digest,
        state: "planned"
      });
      await expect(repository.listEvents(request.value.taskId)).resolves.toHaveLength(9);
      await expect(
        repository.listForConversation(request.value.conversationId, 10)
      ).resolves.toHaveLength(1);
    } finally {
      repository.close();
    }
  });

  it("rejects omitted predecessor artifacts, run substitution, and direct prepared append", async () => {
    const fixture = testFactoryPreparationFixture();
    const repository = new SqliteFactoryPreparationRepository(":memory:");
    const request = codec.intakeRequest(fixture.request);
    const authority = codec.preparationAuthority(fixture.authority);
    const registered = registrationEvent(request.digest, authority.digest);

    try {
      await repository.register(request, authority, registered);
      const qualify = phaseStarted(registered, "qualify", 1, [request.digest], "5");
      await repository.append(qualify);
      const qualification = codec.qualification(fixture.qualification);
      const qualified = phaseSucceeded(qualify, "qualify", 1, qualification, "5");
      await repository.append(qualified);

      const incomplete = phaseStarted(qualified, "specify", 1, [qualification.digest], "6");
      expect(() => repository.append(incomplete)).toThrow(/predecessor chain/u);

      const specify = phaseStarted(
        qualified,
        "specify",
        1,
        [request.digest, qualification.digest],
        "7"
      );
      await repository.append(specify);
      const substituted = codec.preparationEvent({
        ...phaseSucceeded(specify, "specify", 1, codec.specification(fixture.specification), "7")
          .value,
        executionId: "88888888-8888-4888-8888-888888888888"
      });
      expect(() => repository.append(substituted)).toThrow(/exact active run/u);

      const abandoned = phaseAbandoned(specify, "specify", 1, "7");
      await repository.append(abandoned);
      const prepared = codec.preparationEvent({
        schemaVersion: "agentlab.preparation-event.v1",
        eventId: "99999999-9999-4999-8999-999999999999",
        taskId: request.value.taskId,
        sequence: abandoned.value.sequence + 1,
        requestDigest: request.digest,
        authorityDigest: authority.digest,
        previousEventDigest: abandoned.digest,
        kind: "prepared",
        from: "planned",
        to: "prepared",
        actor: controlPlaneActor(),
        occurredAt: "2026-08-30T12:08:00.000Z",
        reasonCode: "preparation-compiled",
        summary: null,
        correlationId: correlationId(),
        preparationBundleDigest: testDigest("e"),
        contractDigest: testDigest("f"),
        evidenceBundleDigest: testDigest("a")
      });
      expect(() => repository.append(prepared)).toThrow(/atomic task-ledger materialization/u);
    } finally {
      repository.close();
    }
  });

  it("lists only eligible scheduled work in oldest-first order", async () => {
    const repository = new SqliteFactoryPreparationRepository(":memory:");
    try {
      const later = await registerTriggeredPreparation(
        repository,
        "scheduled",
        "3",
        "2026-08-30T11:00:00.000Z"
      );
      await registerTriggeredPreparation(repository, "manual", "2", "2026-08-30T09:00:00.000Z");
      const earlier = await registerTriggeredPreparation(
        repository,
        "scheduled",
        "1",
        "2026-08-30T10:00:00.000Z"
      );

      await expect(repository.listScheduled(10)).resolves.toEqual([earlier, later]);
      await expect(repository.listScheduled(1)).resolves.toEqual([earlier]);
      expect(() => repository.listScheduled(0)).toThrow(/limit/u);
    } finally {
      repository.close();
    }
  });

  it("enforces immutable preparation rows at the SQLite boundary", async () => {
    const databasePath = temporaryDatabase("agentlab-preparation-journal-");
    const fixture = testFactoryPreparationFixture();
    const repository = new SqliteFactoryPreparationRepository(databasePath);
    const request = codec.intakeRequest(fixture.request);
    const authority = codec.preparationAuthority(fixture.authority);
    const registered = registrationEvent(request.digest, authority.digest);

    try {
      await repository.register(request, authority, registered);
      const database = new DatabaseSync(databasePath);
      try {
        expect(() =>
          database.prepare("UPDATE factory_preparation_events SET to_state = 'prepared'").run()
        ).toThrow(/append-only/u);
        expect(() => database.prepare("DELETE FROM factory_preparations").run()).toThrow(
          /immutable/u
        );
      } finally {
        database.close();
      }
    } finally {
      repository.close();
    }
  });

  it("migrates a version-five factory ledger without losing existing rows", () => {
    const databasePath = temporaryDatabase("agentlab-preparation-migration-");
    new SqliteFactoryPreparationRepository(databasePath).close();
    const historical = new DatabaseSync(databasePath);
    try {
      historical.exec(`
        DROP TABLE factory_schedule_events;
        DROP TABLE factory_schedule_runs;
        DROP TABLE factory_pull_request_update_events;
        DROP TABLE factory_pull_request_updates;
        DROP TABLE factory_pull_request_repair_events;
        DROP TABLE factory_pull_request_repair_runs;
        DROP TABLE factory_pull_request_dispatch_events;
        DROP TABLE factory_pull_request_dispatches;
        DROP TABLE factory_execution_events;
        DROP TABLE factory_execution_runs;
        DROP TABLE factory_preparation_events;
        DROP TABLE factory_preparations;
        PRAGMA user_version = 5;
      `);
      historical
        .prepare(
          `INSERT INTO factory_control_events (
            event_id, event_digest, control_name, enabled, event_json, occurred_at, reason
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          "77777777-7777-4777-8777-777777777777",
          testDigest("7"),
          "scheduler",
          0,
          "{}",
          "2026-08-30T12:00:00.000Z",
          "Historical control row"
        );
    } finally {
      historical.close();
    }

    new SqliteFactoryPreparationRepository(databasePath).close();
    const migrated = new DatabaseSync(databasePath);
    try {
      expect(
        (migrated.prepare("PRAGMA user_version").get() as { user_version: number }).user_version
      ).toBe(latestSchemaVersion);
      expect(
        (
          migrated.prepare("SELECT COUNT(*) AS count FROM factory_control_events").get() as {
            count: number;
          }
        ).count
      ).toBe(1);
      expect(
        migrated
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
          .get("factory_preparations")
      ).toMatchObject({ name: "factory_preparations" });
      expect(
        migrated
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
          .get("factory_execution_runs")
      ).toMatchObject({ name: "factory_execution_runs" });
    } finally {
      migrated.close();
    }
  });
});

function registrationEvent(requestDigest: string, authorityDigest: string) {
  const fixture = testFactoryPreparationFixture();
  return codec.preparationEvent({
    schemaVersion: "agentlab.preparation-event.v1",
    eventId: "10000000-0000-4000-8000-000000000001",
    taskId: fixture.request.taskId,
    sequence: 1,
    requestDigest,
    authorityDigest,
    previousEventDigest: null,
    kind: "registered",
    from: null,
    to: "registered",
    actor: controlPlaneActor(),
    occurredAt: fixture.authority.issuedAt,
    reasonCode: "request-registered",
    summary: null,
    correlationId: correlationId()
  });
}

async function registerTriggeredPreparation(
  repository: SqliteFactoryPreparationRepository,
  trigger: "manual" | "scheduled",
  id: string,
  createdAt: string
) {
  const fixture = testFactoryPreparationFixture();
  const taskId = `${id.repeat(8)}-${id.repeat(4)}-4${id.repeat(3)}-8${id.repeat(3)}-${id.repeat(12)}`;
  const request = codec.intakeRequest({
    ...fixture.request,
    taskId,
    createdAt,
    deduplicationKey: testDigest(id),
    requestSources: [{ kind: "local", ref: `request-${id}` }],
    trigger
  });
  const authority = codec.preparationAuthority({
    ...fixture.authority,
    taskId,
    requestDigest: request.digest
  });
  const event = codec.preparationEvent({
    schemaVersion: "agentlab.preparation-event.v1",
    eventId: `${id.repeat(8)}-${id.repeat(4)}-4${id.repeat(3)}-9${id.repeat(3)}-${id.repeat(12)}`,
    taskId,
    sequence: 1,
    requestDigest: request.digest,
    authorityDigest: authority.digest,
    previousEventDigest: null,
    kind: "registered",
    from: null,
    to: "registered",
    actor: controlPlaneActor(),
    occurredAt: authority.value.issuedAt,
    reasonCode: "request-registered",
    summary: null,
    correlationId: correlationId()
  });
  return repository.register(request, authority, event);
}

function phaseStarted(
  previous: CanonicalFactoryDocument<FactoryPreparationEvent>,
  phase: FactoryPreparationPhase,
  attempt: number,
  inputArtifactDigests: readonly string[],
  id: string
) {
  const profile = preparationProfile(phase);
  return codec.preparationEvent({
    schemaVersion: "agentlab.preparation-event.v1",
    eventId: eventId(id, 1),
    taskId: previous.value.taskId,
    sequence: previous.value.sequence + 1,
    requestDigest: previous.value.requestDigest,
    authorityDigest: previous.value.authorityDigest,
    previousEventDigest: previous.digest,
    kind: "phase-started",
    phase,
    attempt,
    executionId: eventId(id, 0),
    runRequestDigest: testDigest(id),
    from: phaseStates(phase).stable,
    to: phaseStates(phase).running,
    skillId: profile.skillId,
    skillPackageDigest: testDigest(profile.digestCharacter),
    workerProfileId: profile.workerProfileId,
    inputArtifactDigests,
    actor: controlPlaneActor(),
    occurredAt:
      phase === "qualify" && attempt > 1 ? "2026-08-30T12:02:40.000Z" : phaseTimes(phase).started,
    reasonCode: `${phase}-started`,
    summary: null,
    correlationId: correlationId()
  });
}

function phaseSucceeded(
  previous: CanonicalFactoryDocument<FactoryPreparationEvent>,
  phase: FactoryPreparationPhase,
  attempt: number,
  output: CanonicalFactoryDocument<unknown>,
  id: string
) {
  const coordinates = activeRun(previous, phase, attempt);
  return codec.preparationEvent({
    ...eventBase(previous, eventId(id, 2), `${phase}-succeeded`, phaseTimes(phase).finished),
    kind: "phase-succeeded",
    ...coordinates,
    from: phaseStates(phase).running,
    to: phaseStates(phase).complete,
    runRecordArtifact: artifact(testDigest(recordDigestCharacter(id))),
    outputArtifact: artifact(output.digest, Buffer.byteLength(output.json, "utf8")),
    actor: phaseActor(phase)
  });
}

function phaseFailed(
  previous: CanonicalFactoryDocument<FactoryPreparationEvent>,
  phase: FactoryPreparationPhase,
  attempt: number,
  id: string
) {
  return codec.preparationEvent({
    ...eventBase(previous, eventId(id, 3), `${phase}-failed`, "2026-08-30T12:02:30.000Z"),
    kind: "phase-failed",
    ...activeRun(previous, phase, attempt),
    from: phaseStates(phase).running,
    to: phaseStates(phase).stable,
    runRecordArtifact: artifact(testDigest(recordDigestCharacter(id))),
    errorCode: "provider-exit",
    actor: controlPlaneActor()
  });
}

function phaseAbandoned(
  previous: CanonicalFactoryDocument<FactoryPreparationEvent>,
  phase: FactoryPreparationPhase,
  attempt: number,
  id: string
) {
  return codec.preparationEvent({
    ...eventBase(previous, eventId(id, 4), `${phase}-abandoned`, phaseTimes(phase).finished),
    kind: "phase-abandoned",
    ...activeRun(previous, phase, attempt),
    from: phaseStates(phase).running,
    to: phaseStates(phase).stable,
    actor: controlPlaneActor()
  });
}

function eventBase(
  previous: CanonicalFactoryDocument<FactoryPreparationEvent>,
  id: string,
  reasonCode: string,
  occurredAt: string
) {
  return {
    schemaVersion: "agentlab.preparation-event.v1" as const,
    eventId: id,
    taskId: previous.value.taskId,
    sequence: previous.value.sequence + 1,
    requestDigest: previous.value.requestDigest,
    authorityDigest: previous.value.authorityDigest,
    previousEventDigest: previous.digest,
    occurredAt,
    reasonCode,
    summary: null,
    correlationId: correlationId()
  };
}

function activeRun(
  previous: CanonicalFactoryDocument<FactoryPreparationEvent>,
  phase: FactoryPreparationPhase,
  attempt: number
) {
  if (previous.value.kind !== "phase-started") throw new Error("Expected an active phase run.");
  return {
    phase,
    attempt,
    executionId: previous.value.executionId,
    runRequestDigest: previous.value.runRequestDigest
  };
}

function preparationProfile(phase: FactoryPreparationPhase) {
  if (phase === "qualify") {
    return {
      skillId: "preparation/qualify",
      workerProfileId: "preparation/qualify-worker",
      digestCharacter: "1"
    };
  }
  if (phase === "specify") {
    return {
      skillId: "preparation/specify",
      workerProfileId: "preparation/specify-worker",
      digestCharacter: "2"
    };
  }
  return {
    skillId: "preparation/plan",
    workerProfileId: "preparation/plan-worker",
    digestCharacter: "3"
  };
}

function phaseStates(phase: FactoryPreparationPhase) {
  if (phase === "qualify") {
    return { stable: "registered", running: "qualifying", complete: "qualified" } as const;
  }
  if (phase === "specify") {
    return { stable: "qualified", running: "specifying", complete: "specified" } as const;
  }
  return { stable: "specified", running: "planning", complete: "planned" } as const;
}

function phaseTimes(phase: FactoryPreparationPhase) {
  if (phase === "qualify") {
    return { started: "2026-08-30T12:02:00.000Z", finished: "2026-08-30T12:03:00.000Z" };
  }
  if (phase === "specify") {
    return { started: "2026-08-30T12:04:00.000Z", finished: "2026-08-30T12:05:00.000Z" };
  }
  return { started: "2026-08-30T12:06:00.000Z", finished: "2026-08-30T12:07:00.000Z" };
}

function phaseActor(phase: FactoryPreparationPhase) {
  const roles: Readonly<Record<FactoryPreparationPhase, FactoryActorRole>> = {
    qualify: "qualifier",
    specify: "specifier",
    plan: "planner"
  };
  return {
    kind: "agent" as const,
    role: roles[phase],
    id: preparationProfile(phase).workerProfileId,
    sessionId: `${phase}-session`
  };
}

function controlPlaneActor() {
  return {
    kind: "control-plane" as const,
    role: "policy-engine" as const,
    id: "local/factory-control-plane",
    sessionId: null
  };
}

function artifact(digest: string, sizeBytes = 100) {
  return { digest, mediaType: "application/json", sizeBytes };
}

function eventId(character: string, suffix: number): string {
  return `${character.repeat(8)}-${character.repeat(4)}-4${character.repeat(3)}-8${character.repeat(3)}-${character.repeat(11)}${String(suffix)}`;
}

function recordDigestCharacter(character: string): string {
  const characters = "abcdef0123456789";
  const index = characters.indexOf(character);
  return characters[(index + 1) % characters.length] ?? "a";
}

function correlationId(): string {
  return "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
}

function temporaryDatabase(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  temporaryRoots.push(root);
  return join(root, "agentlab.sqlite");
}
