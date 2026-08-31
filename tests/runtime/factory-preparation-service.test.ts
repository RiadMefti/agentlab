import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import {
  factorySkillPackageSchema,
  sha256DigestSchema,
  type FactoryArtifactReference,
  type FactoryBudgetUsage,
  type FactoryPreparationPhase,
  type FactoryPreparationRunRequest,
  type FactoryResourceLimits,
  type Sha256Digest
} from "@agentlab/contracts";

import { FactoryPreparationService } from "../../packages/runtime/src/application/factory-preparation-service.js";
import { FactoryPreparationMaterializer } from "../../packages/runtime/src/application/factory-preparation-materializer.js";
import type {
  FactoryAgentExecutionOutput,
  FactoryAgentExecutionPreflight,
  FactoryPreparationAgentExecutionInput,
  FactoryPreparationAgentExecutor
} from "../../packages/runtime/src/domain/factory-agent-executor.js";
import type {
  FactoryArtifactStore,
  StoredFactoryArtifact
} from "../../packages/runtime/src/domain/factory-artifact-store.js";
import type { FactoryPreparationRecoveryReconciler } from "../../packages/runtime/src/domain/factory-preparation-recovery.js";
import type {
  FactorySkillSource,
  ResolvedFactorySkill
} from "../../packages/runtime/src/domain/factory-skill.js";
import type {
  CreateFactoryWorkspaceInput,
  FactoryWorkspace,
  FactoryWorkspaceManager
} from "../../packages/runtime/src/domain/factory-workspace.js";
import { storedConversationSchema } from "../../packages/runtime/src/domain/conversation-record.js";
import { buildCaptainSessionName } from "../../packages/runtime/src/domain/agent-session-name.js";
import { defaultFactoryPolicyBundle } from "../../packages/runtime/src/domain/factory-policy.js";
import { FactoryPreparationCompiler } from "../../packages/runtime/src/domain/factory-preparation.js";
import { narrowFactoryResourceLimits } from "../../packages/runtime/src/domain/factory-process-isolation.js";
import { encodeCanonicalDocument } from "../../packages/runtime/src/infrastructure/persistence/canonical-factory-documents.js";
import { SqliteFactoryPreparationRepository } from "../../packages/runtime/src/infrastructure/persistence/sqlite-factory-preparation-repository.js";
import { SqliteFactoryRepository } from "../../packages/runtime/src/infrastructure/persistence/sqlite-factory-repository.js";
import { SqliteFactoryTaskMaterializer } from "../../packages/runtime/src/infrastructure/persistence/sqlite-factory-task-materializer.js";
import { MemoryConversationRepository } from "../helpers/fakes.js";
import { testFactoryPreparationFixture } from "../helpers/factory-preparation.js";
import { TEST_FACTORY_CONVERSATION_ID, testDigest } from "../helpers/factory.js";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("FactoryPreparationService", () => {
  it("advances one durable read-only checkpoint at a time with an exact predecessor chain", async () => {
    const context = await preparationContext();
    try {
      const qualified = await context.service.advance(command(1));
      const specified = await context.service.advance(command(2));
      const planned = await context.service.advance(command(3));

      expect([qualified.state, specified.state, planned.state]).toEqual([
        "qualified",
        "specified",
        "planned"
      ]);
      expect(context.agents.requests.map(({ phase }) => phase)).toEqual([
        "qualify",
        "specify",
        "plan"
      ]);
      expect(context.agents.preflights).toEqual(
        context.agents.requests.map((request) => ({
          provider: request.provider,
          model: request.model,
          policyBundleDigest: context.fixture.authority.policyBundleDigest
        }))
      );
      const events = await context.repository.listEvents(context.fixture.request.taskId);
      const successes = events.filter(({ kind }) => kind === "phase-succeeded");
      expect(successes).toHaveLength(3);
      expect(
        context.agents.requests.map(({ inputArtifactDigests }) => inputArtifactDigests)
      ).toEqual([
        [context.requestDigest],
        [context.requestDigest, requiredOutput(successes, "qualify").digest],
        [
          context.requestDigest,
          requiredOutput(successes, "qualify").digest,
          requiredOutput(successes, "specify").digest
        ]
      ]);
      expect(context.agents.prompts[0]).not.toContain("## Exact qualification");
      expect(context.agents.prompts[1]).toContain("## Exact qualification");
      expect(context.agents.prompts[1]).not.toContain("## Exact specification");
      expect(context.agents.prompts[2]).toContain("## Exact specification");
      expect(context.workspaces.closedAttempts).toEqual([1, 1, 1]);
      expect(context.workspaces.createdWorkspaceIds).toEqual(
        context.agents.requests.map(({ executionId }) => executionId)
      );
      expect(events.map(({ kind }) => kind)).toEqual([
        "registered",
        "phase-started",
        "phase-succeeded",
        "phase-started",
        "phase-succeeded",
        "phase-started",
        "phase-succeeded"
      ]);
    } finally {
      context.repository.close();
    }
  });

  it("fails closed and terminates after invalid provider output exhausts its retry budget", async () => {
    const context = await preparationContext({ outputMode: "invalid" });
    try {
      await expect(context.service.advance(command(1))).resolves.toMatchObject({
        state: "registered",
        lastEvent: { kind: "phase-failed", errorCode: "provider-output-invalid" }
      });
      await expect(context.service.advance(command(2))).resolves.toMatchObject({
        state: "failed",
        lastEvent: { kind: "failed", errorCode: "qualify-attempts-exhausted" }
      });
      expect(
        (await context.repository.listEvents(context.fixture.request.taskId)).map(
          (event) => event.kind
        )
      ).toEqual([
        "registered",
        "phase-started",
        "phase-failed",
        "phase-started",
        "phase-failed",
        "failed"
      ]);
      expect(context.workspaces.closedAttempts).toEqual([1, 2]);
    } finally {
      context.repository.close();
    }
  });

  it("keeps an uncertain cleanup in-flight until recovery proves inactivity", async () => {
    const context = await preparationContext({ failWorkspaceClose: true });
    try {
      await expect(context.service.advance(command(1))).rejects.toThrow(
        "workspace cleanup was not confirmed"
      );
      await expect(
        context.repository.findById(context.fixture.request.taskId)
      ).resolves.toMatchObject({
        state: "qualifying",
        lastEvent: { kind: "phase-started" }
      });
      await expect(context.service.recover(command(2))).rejects.toThrow(
        "preparation-process-not-inactive"
      );
      context.recovery.inactive = true;
      await expect(context.service.recover(command(3))).resolves.toMatchObject({
        state: "registered",
        lastEvent: { kind: "phase-abandoned" }
      });
    } finally {
      context.repository.close();
    }
  });

  it("keeps failed workspace acquisition in-flight until recovery proves no residue", async () => {
    const context = await preparationContext({ failWorkspaceCreate: true });
    try {
      await expect(context.service.advance(command(1))).rejects.toThrow(
        "workspace creation failed"
      );
      await expect(
        context.repository.findById(context.fixture.request.taskId)
      ).resolves.toMatchObject({
        state: "qualifying",
        lastEvent: { kind: "phase-started" }
      });
      context.recovery.inactive = true;
      await expect(context.service.recover(command(2))).resolves.toMatchObject({
        state: "registered",
        lastEvent: { kind: "phase-abandoned" }
      });
    } finally {
      context.repository.close();
    }
  });

  it("does not remove a workspace or journal completion when process cleanup is unconfirmed", async () => {
    const context = await preparationContext({ outputMode: "process-cleanup-failed" });
    try {
      await expect(context.service.advance(command(1))).rejects.toThrow(
        "process cleanup was not confirmed"
      );
      await expect(
        context.repository.findById(context.fixture.request.taskId)
      ).resolves.toMatchObject({
        state: "qualifying",
        lastEvent: { kind: "phase-started" }
      });
      expect(context.workspaces.closedAttempts).toEqual([]);
      context.recovery.inactive = true;
      await expect(context.service.recover(command(2))).resolves.toMatchObject({
        state: "registered",
        lastEvent: { kind: "phase-abandoned" }
      });
    } finally {
      context.repository.close();
    }
  });

  it("expires a proven-inactive run recovered after its authority window", async () => {
    const context = await preparationContext({
      failWorkspaceClose: true,
      timestamps: ["2026-08-30T12:02:00.000Z", "2026-08-31T12:01:00.000Z"]
    });
    try {
      await expect(context.service.advance(command(1))).rejects.toThrow(
        "workspace cleanup was not confirmed"
      );
      context.recovery.inactive = true;
      await expect(context.service.recover(command(2))).resolves.toMatchObject({
        state: "expired",
        lastEvent: { kind: "expired", from: "qualifying" }
      });
    } finally {
      context.repository.close();
    }
  });

  it("does not journal a run when the pinned provider lacks the required preparation capability", async () => {
    const context = await preparationContext({ advertisePreparation: false });
    try {
      await expect(context.service.advance(command(1))).rejects.toThrow(
        "cannot safely execute preparation phase qualify"
      );
      await expect(
        context.repository.listEvents(context.fixture.request.taskId)
      ).resolves.toHaveLength(1);
      expect(context.workspaces.createdAttempts).toEqual([]);
    } finally {
      context.repository.close();
    }
  });

  it("records an explicit needs-human decision as a terminal preparation outcome", async () => {
    const context = await preparationContext({ outputMode: "needs-human" });
    try {
      await expect(context.service.advance(command(1))).resolves.toMatchObject({
        state: "needs-human",
        lastEvent: {
          kind: "needs-human",
          actor: { kind: "agent", role: "qualifier", id: "preparation/qualify-worker" }
        }
      });
      await expect(context.service.advance(command(2))).resolves.toMatchObject({
        state: "needs-human"
      });
      expect(context.agents.requests).toHaveLength(1);
    } finally {
      context.repository.close();
    }
  });

  it("atomically materializes the exact planned journal, task history, and evidence", async () => {
    const root = mkdtempSync(join(tmpdir(), "agentlab-preparation-materializer-"));
    temporaryRoots.push(root);
    const databasePath = join(root, "agentlab.db");
    const context = await preparationContext({ databasePath });
    const tasks = new SqliteFactoryRepository(databasePath);
    const atomic = new SqliteFactoryTaskMaterializer(databasePath);
    try {
      await context.service.advance(command(1));
      await context.service.advance(command(2));
      await context.service.advance(command(3));
      const policyBundle = encodeCanonicalDocument(defaultFactoryPolicyBundle);
      let identifier = 2_000;
      const materializer = new FactoryPreparationMaterializer({
        preparations: context.repository,
        tasks,
        conversations: context.conversations,
        materializations: atomic,
        artifacts: context.artifacts,
        documents: context.fixture.documents,
        policy: context.fixture.policy,
        policyBundle,
        now: () => "2026-08-30T12:08:00.000Z",
        createId: () => uuid(identifier++),
        controlPlaneActorId: "local/factory-control-plane"
      });

      const result = await materializer.materialize(command(4));
      expect(result.preparation).toMatchObject({
        state: "prepared",
        lastEvent: {
          kind: "prepared",
          contractDigest: result.task.contractDigest,
          preparationBundleDigest: result.preparationBundleDigest,
          evidenceBundleDigest: result.evidenceBundleDigest
        }
      });
      expect(result.task).toMatchObject({ state: "planned", sequence: 4 });
      expect((await tasks.listEvents(context.fixture.request.taskId)).map(({ to }) => to)).toEqual([
        "intake",
        "qualified",
        "specified",
        "planned"
      ]);
      const evidence = await tasks.listEvidence(context.fixture.request.taskId);
      expect(evidence).toHaveLength(1);
      expect(evidence[0]?.digest).toBe(result.evidenceBundleDigest);
      expect(evidence[0]?.bundle.items.map(({ kind }) => kind)).toEqual(
        expect.arrayContaining([
          "request",
          "qualification",
          "specification",
          "plan",
          "contract",
          "policy",
          "provenance"
        ])
      );
      expect(
        evidence[0]?.bundle.items
          .filter(({ producer }) => producer.id === "agentlab-local-gates")
          .flatMap(({ claims }) =>
            claims.filter(({ name }) => name === "gate-id").map(({ value }) => value)
          )
          .sort()
      ).toEqual(["contract-validation", "policy-validation", "scope-validation"]);

      const executionAdmission = context.fixture.policy.evaluate({
        contract: {
          value: result.task.contract,
          digest: result.task.contractDigest,
          json: context.fixture.documents.taskContract(result.task.contract).json
        },
        stage: "execution",
        approvalSubjectDigest: result.task.contractDigest,
        now: "2026-08-30T12:09:00.000Z",
        currentBaseRevision: result.task.contract.repository.baseRevision,
        changeSet: {
          baseRevision: result.task.contract.repository.baseRevision,
          headRevision: null,
          changedPaths: [],
          binaryPaths: [],
          changedFiles: 0,
          changedLines: 0
        },
        usage: zeroUsage(),
        usageComplete: true,
        evidence: evidence[0]?.bundle.items ?? [],
        approvals: [],
        authority: { scheduler: false, prBroker: false },
        scheduled: false
      });
      expect(executionAdmission).toMatchObject({ outcome: "allow", reasonCodes: [] });

      const replay = await materializer.materialize(command(5));
      expect(replay.task.contractDigest).toBe(result.task.contractDigest);
      await expect(tasks.listEvents(context.fixture.request.taskId)).resolves.toHaveLength(4);
      await expect(tasks.listEvidence(context.fixture.request.taskId)).resolves.toHaveLength(1);
    } finally {
      atomic.close();
      tasks.close();
      context.repository.close();
    }
  });

  it("materializes a run whose process limit is narrowed below the R0 ceiling", async () => {
    const root = mkdtempSync(join(tmpdir(), "agentlab-preparation-narrowed-isolation-"));
    temporaryRoots.push(root);
    const databasePath = join(root, "agentlab.db");
    const context = await preparationContext({ databasePath, preparationMaxProcesses: 2 });
    const tasks = new SqliteFactoryRepository(databasePath);
    const atomic = new SqliteFactoryTaskMaterializer(databasePath);
    try {
      await context.service.advance(command(1));
      await context.service.advance(command(2));
      await context.service.advance(command(3));
      const policyBundle = encodeCanonicalDocument(defaultFactoryPolicyBundle);
      let identifier = 9_000;
      const materializer = new FactoryPreparationMaterializer({
        preparations: context.repository,
        tasks,
        conversations: context.conversations,
        materializations: atomic,
        artifacts: context.artifacts,
        documents: context.fixture.documents,
        policy: context.fixture.policy,
        policyBundle,
        now: () => "2026-08-30T12:08:00.000Z",
        createId: () => uuid(identifier++),
        controlPlaneActorId: "local/factory-control-plane"
      });

      await expect(materializer.materialize(command(4))).resolves.toMatchObject({
        task: { state: "planned" }
      });
    } finally {
      atomic.close();
      tasks.close();
      context.repository.close();
    }
  });

  it("rejects a non-canonical journal row at the atomic materialization boundary", async () => {
    const root = mkdtempSync(join(tmpdir(), "agentlab-preparation-tampered-journal-"));
    temporaryRoots.push(root);
    const databasePath = join(root, "agentlab.db");
    const context = await preparationContext({ databasePath });
    const tasks = new SqliteFactoryRepository(databasePath);
    const atomic = new SqliteFactoryTaskMaterializer(databasePath);
    try {
      await context.service.advance(command(1));
      await context.service.advance(command(2));
      await context.service.advance(command(3));
      const cachedPreparation = await context.repository.findById(context.fixture.request.taskId);
      const cachedHistory = await context.repository.listEvents(context.fixture.request.taskId);
      if (cachedPreparation === null) throw new Error("Expected a cached preparation snapshot.");
      const database = new DatabaseSync(databasePath);
      try {
        const row = database
          .prepare(
            `SELECT event_json
             FROM factory_preparation_events
             WHERE task_id = ?
             ORDER BY sequence DESC
             LIMIT 1`
          )
          .get(context.fixture.request.taskId) as { readonly event_json: string };
        database.exec("DROP TRIGGER factory_preparation_events_no_update");
        database
          .prepare(
            `UPDATE factory_preparation_events
             SET event_json = ?
             WHERE task_id = ? AND sequence = 7`
          )
          .run(JSON.stringify(JSON.parse(row.event_json), null, 2), context.fixture.request.taskId);
      } finally {
        database.close();
      }

      const policyBundle = encodeCanonicalDocument(defaultFactoryPolicyBundle);
      let identifier = 10_000;
      const materializer = new FactoryPreparationMaterializer({
        preparations: {
          findById: () => Promise.resolve(cachedPreparation),
          listEvents: () => Promise.resolve(cachedHistory)
        },
        tasks,
        conversations: context.conversations,
        materializations: atomic,
        artifacts: context.artifacts,
        documents: context.fixture.documents,
        policy: context.fixture.policy,
        policyBundle,
        now: () => "2026-08-30T12:08:00.000Z",
        createId: () => uuid(identifier++),
        controlPlaneActorId: "local/factory-control-plane"
      });

      await expect(materializer.materialize(command(4))).rejects.toThrow(
        "event chain failed materialization validation"
      );
      await expect(tasks.findById(context.fixture.request.taskId)).resolves.toBeNull();
    } finally {
      atomic.close();
      tasks.close();
      context.repository.close();
    }
  });

  it("rolls back the task ledger and prepared marker when a late evidence insert fails", async () => {
    const root = mkdtempSync(join(tmpdir(), "agentlab-preparation-rollback-"));
    temporaryRoots.push(root);
    const databasePath = join(root, "agentlab.db");
    const context = await preparationContext({ databasePath });
    const tasks = new SqliteFactoryRepository(databasePath);
    const atomic = new SqliteFactoryTaskMaterializer(databasePath);
    try {
      await context.service.advance(command(1));
      await context.service.advance(command(2));
      await context.service.advance(command(3));
      const policyBundle = encodeCanonicalDocument(defaultFactoryPolicyBundle);
      const otherTaskId = uuid(7_000);
      const otherContractValue = new FactoryPreparationCompiler(
        context.fixture.documents,
        context.fixture.policy,
        context.fixture.authority
      ).compile(context.fixture.input).contract.value;
      const otherContract = context.fixture.documents.taskContract({
        ...otherContractValue,
        taskId: otherTaskId,
        deduplicationKey: testDigest("f"),
        repository: { ...otherContractValue.repository, id: "agentlab-rollback-sentinel" }
      });
      const otherEvent = context.fixture.documents.taskEvent({
        schemaVersion: "agentlab.task-event.v1",
        eventId: uuid(7_001),
        taskId: otherTaskId,
        sequence: 1,
        contractDigest: otherContract.digest,
        previousEventDigest: null,
        from: null,
        to: "intake",
        actor: {
          kind: "control-plane",
          role: "policy-engine",
          id: "local/factory-control-plane",
          sessionId: null
        },
        occurredAt: otherContract.value.createdAt,
        reasonCode: "rollback-sentinel-created",
        summary: null,
        evidenceBundleDigest: null,
        correlationId: uuid(7_002)
      });
      const conflictingBundleId = uuid(7_003);
      const otherEvidence = context.fixture.documents.evidenceBundle({
        schemaVersion: "agentlab.evidence-bundle.v1",
        bundleId: conflictingBundleId,
        taskId: otherTaskId,
        sequence: 1,
        contractDigest: otherContract.digest,
        previousBundleDigest: null,
        policyBundleDigest: policyBundle.digest,
        createdAt: otherContract.value.createdAt,
        items: [
          {
            id: uuid(7_004),
            kind: "contract",
            result: "pass",
            subjectDigest: otherContract.digest,
            artifact: {
              digest: otherContract.digest,
              mediaType: "application/vnd.agentlab.task-contract.v1+json",
              sizeBytes: Buffer.byteLength(otherContract.json, "utf8")
            },
            producer: {
              kind: "control-plane",
              role: "policy-engine",
              id: "local/factory-control-plane",
              sessionId: null
            },
            createdAt: otherContract.value.createdAt,
            claims: []
          }
        ],
        attestations: []
      });
      await tasks.create(otherContract, otherEvent, otherEvidence);

      let identifier = 8_000;
      let idCalls = 0;
      const materializer = new FactoryPreparationMaterializer({
        preparations: context.repository,
        tasks,
        conversations: context.conversations,
        materializations: atomic,
        artifacts: context.artifacts,
        documents: context.fixture.documents,
        policy: context.fixture.policy,
        policyBundle,
        now: () => "2026-08-30T12:08:00.000Z",
        createId: () => {
          idCalls += 1;
          return idCalls === 18 ? conflictingBundleId : uuid(identifier++);
        },
        controlPlaneActorId: "local/factory-control-plane"
      });

      await expect(materializer.materialize(command(4))).rejects.toThrow(/UNIQUE constraint/u);
      await expect(tasks.findById(context.fixture.request.taskId)).resolves.toBeNull();
      await expect(
        context.repository.findById(context.fixture.request.taskId)
      ).resolves.toMatchObject({
        state: "planned",
        lastEvent: { kind: "phase-succeeded", phase: "plan" }
      });
    } finally {
      atomic.close();
      tasks.close();
      context.repository.close();
    }
  });
});

type OutputMode = "success" | "invalid" | "needs-human" | "process-cleanup-failed";

async function preparationContext(
  options: {
    readonly outputMode?: OutputMode;
    readonly failWorkspaceClose?: boolean;
    readonly failWorkspaceCreate?: boolean;
    readonly advertisePreparation?: boolean;
    readonly databasePath?: string;
    readonly timestamps?: readonly string[];
    readonly preparationMaxProcesses?: number;
  } = {}
) {
  const fixture = testFactoryPreparationFixture({
    ...(options.preparationMaxProcesses === undefined
      ? {}
      : { preparationMaxProcesses: options.preparationMaxProcesses })
  });
  const repository = new SqliteFactoryPreparationRepository(options.databasePath ?? ":memory:");
  const artifacts = new MemoryFactoryArtifactStore();
  const request = fixture.documents.intakeRequest(fixture.request);
  const authority = fixture.documents.preparationAuthority(fixture.authority);
  await artifacts.putText(request.json);
  await artifacts.putText(authority.json);
  const registered = fixture.documents.preparationEvent({
    schemaVersion: "agentlab.preparation-event.v1",
    eventId: uuid(1),
    taskId: fixture.request.taskId,
    sequence: 1,
    requestDigest: request.digest,
    authorityDigest: authority.digest,
    previousEventDigest: null,
    kind: "registered",
    from: null,
    to: "registered",
    actor: {
      kind: "control-plane",
      role: "policy-engine",
      id: "local/factory-control-plane",
      sessionId: null
    },
    occurredAt: fixture.authority.issuedAt,
    reasonCode: "request-registered",
    summary: null,
    correlationId: uuid(2)
  });
  await repository.register(request, authority, registered);

  const conversations = new MemoryConversationRepository();
  conversations.conversations.push(
    storedConversationSchema.parse({
      id: TEST_FACTORY_CONVERSATION_ID,
      title: "Factory preparation test",
      workspacePath: "/work/agentlab",
      provider: "codex",
      model: null,
      reasoning: null,
      captainSessionName: buildCaptainSessionName(TEST_FACTORY_CONVERSATION_ID, "codex"),
      createdAt: fixture.request.createdAt,
      updatedAt: fixture.request.createdAt,
      lifecycleState: "active",
      ownershipMode: "legacy-name",
      ownershipNonce: null
    })
  );
  const workspaces = new FakePreparationWorkspaceManager(
    options.failWorkspaceClose === true,
    options.failWorkspaceCreate === true
  );
  const agents = new FakePreparationAgentExecutor(
    fixture,
    options.outputMode ?? "success",
    options.advertisePreparation !== false
  );
  const recovery = new MutableRecoveryReconciler();
  const timestamps = [
    ...(options.timestamps ?? [
      "2026-08-30T12:02:00.000Z",
      "2026-08-30T12:04:00.000Z",
      "2026-08-30T12:06:00.000Z",
      "2026-08-30T12:08:00.000Z"
    ])
  ];
  let identifier = 100;
  const service = new FactoryPreparationService({
    preparations: repository,
    conversations,
    artifacts,
    documents: fixture.documents,
    policy: fixture.policy,
    skills: preparationSkills(fixture),
    workspaces,
    agents,
    providers: {
      resolve: (provider) => Promise.resolve({ executable: `/opt/${provider}`, version: "1.0.0" })
    },
    recovery,
    now: () => timestamps.shift() ?? "2026-08-30T12:09:00.000Z",
    createId: () => uuid(identifier++),
    controlPlaneActorId: "local/factory-control-plane"
  });
  return {
    fixture,
    repository,
    artifacts,
    conversations,
    requestDigest: request.digest,
    service,
    workspaces,
    agents,
    recovery
  };
}

class MemoryFactoryArtifactStore implements FactoryArtifactStore {
  readonly #content = new Map<Sha256Digest, Uint8Array>();

  public put(content: Uint8Array): Promise<StoredFactoryArtifact> {
    const copy = Uint8Array.from(content);
    const digest = sha256DigestSchema.parse(
      `sha256:${createHash("sha256").update(copy).digest("hex")}`
    );
    this.#content.set(digest, copy);
    return Promise.resolve({ digest, sizeBytes: copy.byteLength });
  }

  public putText(content: string): Promise<StoredFactoryArtifact> {
    return this.put(Buffer.from(content, "utf8"));
  }

  public read(digest: Sha256Digest, maximumBytes: number): Promise<Uint8Array> {
    const content = this.#content.get(digest);
    if (content === undefined) return Promise.reject(new Error(`Missing artifact ${digest}.`));
    if (content.byteLength > maximumBytes) {
      return Promise.reject(new Error(`Artifact ${digest} exceeds its read limit.`));
    }
    return Promise.resolve(Uint8Array.from(content));
  }

  public async readText(digest: Sha256Digest, maximumBytes: number): Promise<string> {
    return Buffer.from(await this.read(digest, maximumBytes)).toString("utf8");
  }
}

class FakePreparationWorkspaceManager implements FactoryWorkspaceManager {
  public readonly createdAttempts: number[] = [];
  public readonly createdWorkspaceIds: (string | undefined)[] = [];
  public readonly closedAttempts: number[] = [];

  public constructor(
    private readonly failClose: boolean,
    private readonly failCreate: boolean
  ) {}

  public create(input: CreateFactoryWorkspaceInput): Promise<FactoryWorkspace> {
    this.createdAttempts.push(input.attempt);
    this.createdWorkspaceIds.push(input.workspaceId);
    if (this.failCreate) return Promise.reject(new Error("workspace creation failed"));
    return Promise.resolve({
      id: input.workspaceId ?? uuid(900 + input.attempt),
      taskId: input.taskId,
      attempt: input.attempt,
      repositoryRoot: input.repositoryRoot,
      root: `${input.repositoryRoot}/.agentlab/preparation-${String(input.attempt)}`,
      baseRevision: input.baseRevision,
      closeAndWait: () => {
        if (this.failClose) return Promise.reject(new Error("workspace close failed"));
        this.closedAttempts.push(input.attempt);
        return Promise.resolve();
      }
    });
  }

  public apply(): Promise<void> {
    return Promise.reject(new Error("Preparation workspace is read-only."));
  }

  public collect(): Promise<never> {
    return Promise.reject(new Error("Preparation workspace cannot produce a patch."));
  }
}

class MutableRecoveryReconciler implements FactoryPreparationRecoveryReconciler {
  public inactive = false;

  public reconcile() {
    return Promise.resolve(
      this.inactive
        ? ({ status: "inactive" } as const)
        : ({
            status: "uncertain",
            reasonCode: "preparation-process-not-inactive"
          } as const)
    );
  }
}

class FakePreparationAgentExecutor implements FactoryPreparationAgentExecutor {
  public readonly requests: FactoryPreparationRunRequest[] = [];
  public readonly prompts: string[] = [];
  public readonly preflights: FactoryAgentExecutionPreflight[] = [];

  public constructor(
    private readonly fixture: ReturnType<typeof testFactoryPreparationFixture>,
    private readonly outputMode: OutputMode,
    private readonly advertisePreparation: boolean
  ) {}

  public capabilities() {
    return [
      {
        provider: "codex" as const,
        roles: ["implementer" as const, "repairer" as const, "reviewer" as const],
        preparationPhases: this.advertisePreparation
          ? (["qualify", "specify", "plan"] as const)
          : ([] as const),
        maximumToolFilesystemAccess: "workspace-write" as const,
        toolNetwork: "off" as const,
        acceptsCommandAllowlist: false,
        acceptsSecrets: false as const
      }
    ];
  }

  public preflight(input: FactoryAgentExecutionPreflight): void {
    this.preflights.push(input);
  }

  public execute(
    input: FactoryPreparationAgentExecutionInput
  ): Promise<FactoryAgentExecutionOutput> {
    this.requests.push(input.request);
    this.prompts.push(input.prompt);
    const times = phaseTimes(input.request.phase, input.request.attempt);
    const finalOutput = this.#finalOutput(input.request.phase);
    if (this.outputMode === "process-cleanup-failed") {
      return Promise.resolve({
        status: "failed",
        exitCode: null,
        stdout: "",
        stderr: "provider process tree may still be active",
        finalOutput: null,
        providerSessionId: null,
        providerVersion: input.providerVersion,
        harnessVersion: "test-harness-v1",
        startedAt: times.startedAt,
        finishedAt: times.finishedAt,
        usage: successfulUsage(""),
        usageComplete: false,
        errorCode: "process-cleanup-failed",
        isolation: testIsolation(
          input.request.executionId,
          narrowFactoryResourceLimits(input.resourceLimits, input.request.budget.maxProcesses)
        )
      });
    }
    return Promise.resolve({
      status: "succeeded",
      exitCode: 0,
      stdout: "provider events",
      stderr: "",
      finalOutput,
      providerSessionId: `${input.request.phase}-session`,
      providerVersion: input.providerVersion,
      harnessVersion: "test-harness-v1",
      startedAt: times.startedAt,
      finishedAt: times.finishedAt,
      usage: successfulUsage(finalOutput),
      usageComplete: true,
      errorCode: null,
      isolation: testIsolation(
        input.request.executionId,
        narrowFactoryResourceLimits(input.resourceLimits, input.request.budget.maxProcesses)
      )
    });
  }

  #finalOutput(phase: FactoryPreparationPhase): string {
    if (this.outputMode === "invalid") return "not valid JSON";
    if (phase === "qualify") {
      if (this.outputMode === "needs-human") {
        return JSON.stringify({
          schemaVersion: "agentlab.qualification-output.v1",
          disposition: "needs-human",
          objective: this.fixture.qualification.objective,
          assumptions: this.fixture.qualification.assumptions,
          openQuestions: ["Which repository paths may change?"],
          rejectionReason: null
        });
      }
      return JSON.stringify({
        schemaVersion: "agentlab.qualification-output.v1",
        disposition: "ready",
        objective: this.fixture.qualification.objective,
        assumptions: this.fixture.qualification.assumptions,
        openQuestions: [],
        rejectionReason: null
      });
    }
    if (phase === "specify") {
      const { objective, acceptanceCriteria, nonGoals, scope } = this.fixture.specification;
      return JSON.stringify({
        schemaVersion: "agentlab.specification-output.v1",
        objective,
        acceptanceCriteria,
        nonGoals,
        scope
      });
    }
    const {
      proposedRiskTier,
      selectedSkillIds,
      selectedWorkerProfileIds,
      capabilities,
      budget,
      requiredEvidence
    } = this.fixture.plan;
    return JSON.stringify({
      schemaVersion: "agentlab.plan-output.v1",
      proposedRiskTier,
      selectedSkillIds,
      selectedWorkerProfileIds,
      capabilities,
      budget,
      requiredEvidence
    });
  }
}

function preparationSkills(
  fixture: ReturnType<typeof testFactoryPreparationFixture>
): FactorySkillSource {
  return {
    resolve: (digest) => {
      const authorized = fixture.authority.skills.find(
        ({ manifest }) => manifest.packageDigest === digest
      );
      if (authorized === undefined) return Promise.reject(new Error(`Unknown skill ${digest}.`));
      const manifestBody: Record<string, unknown> = { ...authorized.manifest };
      delete manifestBody.packageDigest;
      const instructions = `Perform only the ${authorized.phase} phase and return strict JSON.`;
      const skill: ResolvedFactorySkill = {
        packageDigest: authorized.manifest.packageDigest,
        manifest: authorized.manifest,
        package: factorySkillPackageSchema.parse({
          schemaVersion: "agentlab.skill-package.v1",
          manifest: manifestBody,
          files: { [authorized.manifest.instructionPath]: instructions }
        }),
        instructions
      };
      return Promise.resolve(skill);
    }
  };
}

function successfulUsage(finalOutput: string): FactoryBudgetUsage {
  return {
    wallClockSeconds: 1,
    agentTurns: 1,
    toolCalls: 1,
    inputTokens: 100,
    outputTokens: 100,
    costMicrousd: 1_000,
    processes: 1,
    outputBytes: Buffer.byteLength(finalOutput, "utf8"),
    workers: 1,
    repairAttempts: 0,
    changedFiles: 0,
    changedLines: 0
  };
}

function zeroUsage(): FactoryBudgetUsage {
  return {
    wallClockSeconds: 0,
    agentTurns: 0,
    toolCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    costMicrousd: 0,
    processes: 0,
    outputBytes: 0,
    workers: 0,
    repairAttempts: 0,
    changedFiles: 0,
    changedLines: 0
  };
}

function phaseTimes(phase: FactoryPreparationPhase, attempt: number) {
  if (phase === "qualify" && attempt === 1) {
    return { startedAt: "2026-08-30T12:02:00.000Z", finishedAt: "2026-08-30T12:03:00.000Z" };
  }
  if (phase === "qualify") {
    return { startedAt: "2026-08-30T12:04:00.000Z", finishedAt: "2026-08-30T12:05:00.000Z" };
  }
  if (phase === "specify") {
    return { startedAt: "2026-08-30T12:04:00.000Z", finishedAt: "2026-08-30T12:05:00.000Z" };
  }
  return { startedAt: "2026-08-30T12:06:00.000Z", finishedAt: "2026-08-30T12:07:00.000Z" };
}

function testIsolation(isolationId: string, limits: FactoryResourceLimits) {
  return {
    isolationId,
    mechanism: { id: "linux/systemd-user-scope", version: "test-systemd-1" },
    scopeName: `agentlab-factory-${isolationId.replaceAll("-", "")}.scope`,
    limits
  } as const;
}

function requiredOutput(
  events: readonly {
    readonly kind: string;
    readonly phase?: FactoryPreparationPhase;
    readonly outputArtifact?: FactoryArtifactReference;
  }[],
  phase: FactoryPreparationPhase
): FactoryArtifactReference {
  const event = events.find(
    (candidate) => candidate.kind === "phase-succeeded" && candidate.phase === phase
  );
  if (event?.outputArtifact === undefined) throw new Error(`Missing ${phase} output.`);
  return event.outputArtifact;
}

function command(index: number) {
  return {
    taskId: testFactoryPreparationFixture().request.taskId,
    correlationId: uuid(500 + index)
  };
}

function uuid(index: number): string {
  return `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}
