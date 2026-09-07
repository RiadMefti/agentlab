import {
  factoryMaintenanceDiscoveryPolicySchema,
  factoryTimestampSchema,
  sha256DigestSchema,
  type FactoryBudgetUsage,
  type FactoryMaintenanceDiscoveryEvent,
  type FactoryMaintenanceDiscoveryOutput,
  type FactoryMaintenanceDiscoveryPolicy,
  type FactoryMaintenanceDiscoveryRun,
  type FactoryMaintenanceDiscoveryRunRequest,
  type FactoryMaintenanceFinding,
  type Sha256Digest
} from "@agentlab/contracts";
import { z } from "zod";

import { ConflictError } from "../domain/errors.js";
import type {
  FactoryMaintenanceDiscoveryAgentExecutor,
  FactoryAgentProviderResolver
} from "../domain/factory-agent-executor.js";
import type { FactoryArtifactStore } from "../domain/factory-artifact-store.js";
import type { FactoryControlRepository } from "../domain/factory-task-repository.js";
import type { ConversationRepository } from "../domain/conversation-repository.js";
import type {
  FactoryDocumentCodec,
  CanonicalFactoryDocument
} from "../domain/factory-documents.js";
import type { FactoryMaintenanceEvidenceInventory } from "../domain/factory-maintenance-evidence-inventory.js";
import type {
  FactoryMaintenanceDiscoveryRepository,
  FactoryMaintenanceDiscoverySnapshot
} from "../domain/factory-maintenance-discovery-repository.js";
import type { FactoryRepositoryRevisionReader } from "../domain/factory-repository-revision.js";
import type { FactoryWorkspaceManager } from "../domain/factory-workspace.js";
import type { FactoryWorkspaceRecoveryReconciler } from "../domain/factory-workspace-recovery.js";
import type { FactoryWorkerHostInspector } from "../domain/factory-worker-host.js";
import {
  repositoryPathIsInScope,
  repositoryPathMatches
} from "../domain/repository-path-policy.js";
import { resolveFactoryDailyScheduleSlot } from "../domain/factory-schedule-time.js";
import { FactoryMaintenanceDiscoveryIntake } from "./factory-maintenance-discovery-intake.js";
import { renderFactoryMaintenanceDiscoveryPrompt } from "./factory-maintenance-discovery-prompt-renderer.js";
import { FactoryMaintenanceDiscoveryRunRecorder } from "./factory-maintenance-discovery-run-recorder.js";
import { FactoryMaintenanceDiscoverySkill } from "./factory-maintenance-discovery-skill.js";

const tickCommandSchema = z
  .object({
    expectedDiscoveryPolicyDigest: sha256DigestSchema,
    expectedSchedulePolicyDigest: sha256DigestSchema,
    expectedFactoryPolicyBundleDigest: sha256DigestSchema,
    expectedPreparationGrantDigest: sha256DigestSchema,
    expectedRoleIdentityPolicyDigest: sha256DigestSchema
  })
  .strict();

type TickCommand = z.infer<typeof tickCommandSchema>;

export interface FactoryMaintenanceDiscoveryPreflight {
  readonly schemaVersion: "agentlab.maintenance-discovery-preflight.v1";
  readonly status: "ready" | "blocked";
  readonly repository: { readonly id: string; readonly baseRevision: string };
  readonly discoveryPolicyDigest: Sha256Digest;
  readonly schedulePolicyDigest: Sha256Digest;
  readonly factoryPolicyBundleDigest: Sha256Digest;
  readonly preparationGrantDigest: Sha256Digest;
  readonly roleIdentityPolicyDigest: Sha256Digest;
  readonly provider: string;
  readonly skillPackageDigest: Sha256Digest;
  readonly schedulerEnabled: boolean;
  readonly reasonCodes: readonly string[];
}

export interface FactoryMaintenanceDiscoveryTickReport {
  readonly schemaVersion: "agentlab.maintenance-discovery-tick-result.v1";
  readonly status: "completed" | "already-completed" | "failed" | "missed-deadline" | "blocked";
  readonly scheduledFor: string;
  readonly deadlineAt: string;
  readonly runId: string | null;
  readonly runDigest: Sha256Digest | null;
  readonly findings: number;
  readonly admitted: number;
  readonly skipped: number;
  readonly usage: FactoryBudgetUsage;
  readonly reasonCodes: readonly string[];
}

export interface FactoryMaintenanceDiscoveryServiceDependencies {
  readonly repositoryId: string;
  readonly repositoryRoot: string;
  readonly conversationId: string;
  readonly discoveryPolicy: CanonicalFactoryDocument<FactoryMaintenanceDiscoveryPolicy>;
  readonly schedulePolicy: CanonicalFactoryDocument<
    FactoryMaintenanceDiscoveryRun["schedulePolicy"]
  >;
  readonly factoryPolicyBundleDigest: Sha256Digest;
  readonly preparationGrantDigest: Sha256Digest;
  readonly roleIdentityPolicyDigest: Sha256Digest;
  readonly controls: Pick<FactoryControlRepository, "state">;
  readonly conversations: Pick<ConversationRepository, "findById">;
  readonly revisions: FactoryRepositoryRevisionReader;
  readonly discoveries: FactoryMaintenanceDiscoveryRepository;
  readonly artifacts: FactoryArtifactStore;
  readonly documents: FactoryDocumentCodec;
  readonly skill: FactoryMaintenanceDiscoverySkill;
  readonly intake: FactoryMaintenanceDiscoveryIntake;
  readonly host: FactoryWorkerHostInspector;
  readonly providers: FactoryAgentProviderResolver;
  readonly agents: FactoryMaintenanceDiscoveryAgentExecutor;
  readonly workspaces: FactoryWorkspaceManager;
  readonly recovery: FactoryWorkspaceRecoveryReconciler;
  readonly evidenceInventory: FactoryMaintenanceEvidenceInventory;
  readonly now: () => string;
  readonly createId: () => string;
}

/** Discovers and admits bounded R1 maintenance without execution or remote-repository authority. */
export class FactoryMaintenanceDiscoveryService {
  readonly #policy: FactoryMaintenanceDiscoveryPolicy;

  public constructor(
    private readonly dependencies: FactoryMaintenanceDiscoveryServiceDependencies
  ) {
    this.#policy = factoryMaintenanceDiscoveryPolicySchema.parse(
      dependencies.discoveryPolicy.value
    );
  }

  public async preflight(): Promise<FactoryMaintenanceDiscoveryPreflight> {
    const [authority, conversation, baseRevision, host] = await Promise.all([
      this.dependencies.controls.state(),
      this.dependencies.conversations.findById(this.dependencies.conversationId),
      this.dependencies.revisions.currentRevision(this.dependencies.repositoryRoot),
      this.dependencies.host.inspect()
    ]);
    const capability = this.dependencies.agents
      .capabilities()
      .find(({ provider }) => provider === this.#policy.profile.provider);
    const reasons = [
      ...host.reasonCodes,
      ...(authority.scheduler ? [] : ["scheduler-disabled"]),
      ...(conversation === null ? ["conversation-not-found"] : []),
      ...(conversation?.lifecycleState === "active" ? [] : ["conversation-not-active"]),
      ...(conversation?.workspacePath === this.dependencies.repositoryRoot
        ? []
        : ["conversation-workspace-mismatch"]),
      ...(capability?.maintenanceDiscovery === true ? [] : ["provider-discovery-unsupported"])
    ];
    try {
      this.dependencies.agents.preflight({
        provider: this.#policy.profile.provider,
        model: this.#policy.profile.model,
        policyBundleDigest: this.dependencies.factoryPolicyBundleDigest
      });
    } catch {
      reasons.push("cost-policy-incomplete");
    }
    return {
      schemaVersion: "agentlab.maintenance-discovery-preflight.v1",
      status: reasons.length === 0 ? "ready" : "blocked",
      repository: { id: this.dependencies.repositoryId, baseRevision },
      discoveryPolicyDigest: this.dependencies.discoveryPolicy.digest,
      schedulePolicyDigest: this.dependencies.schedulePolicy.digest,
      factoryPolicyBundleDigest: this.dependencies.factoryPolicyBundleDigest,
      preparationGrantDigest: this.dependencies.preparationGrantDigest,
      roleIdentityPolicyDigest: this.dependencies.roleIdentityPolicyDigest,
      provider: this.#policy.profile.provider,
      skillPackageDigest: this.#policy.skill.packageDigest,
      schedulerEnabled: authority.scheduler,
      reasonCodes: uniqueSorted(reasons)
    };
  }

  public async tick(input: unknown): Promise<FactoryMaintenanceDiscoveryTickReport> {
    const command = tickCommandSchema.parse(input);
    this.#assertPins(command);
    const now = factoryTimestampSchema.parse(this.dependencies.now());
    const slot = resolveFactoryDailyScheduleSlot(this.dependencies.schedulePolicy.value, now);
    let snapshot = await this.dependencies.discoveries.findOpen();
    if (snapshot !== null) {
      if (!this.#usesCurrentPins(snapshot))
        return this.#report("blocked", snapshot, ["open-discovery-policy-drift"]);
      if (now < snapshot.run.scheduledFor || now < snapshot.lastEvent.occurredAt) {
        return this.#report("blocked", snapshot, ["open-discovery-clock-regression"]);
      }
    } else {
      snapshot = await this.dependencies.discoveries.findBySlot(this.#policy.id, slot.scheduledFor);
      if (snapshot !== null) {
        if (!this.#usesCurrentPins(snapshot))
          return this.#report("blocked", snapshot, ["discovery-slot-policy-drift"]);
        if (snapshot.state === "completed") return this.#report("already-completed", snapshot, []);
        if (snapshot.state === "failed")
          return this.#report("failed", snapshot, ["discovery-agent-failed"]);
      } else if (slot.status === "missed-deadline") {
        return emptyReport("missed-deadline", slot.scheduledFor, slot.deadlineAt, [
          "discovery-start-deadline-missed"
        ]);
      }
    }

    const preflight = await this.preflight();
    if (preflight.status !== "ready") {
      return snapshot === null
        ? emptyReport("blocked", slot.scheduledFor, slot.deadlineAt, preflight.reasonCodes)
        : this.#report("blocked", snapshot, preflight.reasonCodes);
    }
    snapshot ??= await this.#register(
      slot.scheduledFor,
      slot.deadlineAt,
      preflight.repository.baseRevision,
      now
    );
    return this.#drive(snapshot);
  }

  async #drive(
    snapshot: FactoryMaintenanceDiscoverySnapshot
  ): Promise<FactoryMaintenanceDiscoveryTickReport> {
    if (snapshot.state === "ready") snapshot = await this.#startAgent(snapshot);
    if (snapshot.state === "agent-active") snapshot = await this.#runAgent(snapshot);
    if (snapshot.state === "failed")
      return this.#report("failed", snapshot, ["discovery-agent-failed"]);
    if (snapshot.state === "admitting") snapshot = await this.#admitFindings(snapshot);
    if (snapshot.state !== "completed")
      return this.#report("blocked", snapshot, ["discovery-recovery-incomplete"]);
    return this.#report("completed", snapshot, []);
  }

  async #register(
    scheduledFor: string,
    deadlineAt: string,
    baseRevision: string,
    createdAt: string
  ): Promise<FactoryMaintenanceDiscoverySnapshot> {
    const run = this.dependencies.documents.maintenanceDiscoveryRun({
      schemaVersion: "agentlab.maintenance-discovery-run.v1",
      runId: this.#id(),
      discoveryPolicyDigest: this.dependencies.discoveryPolicy.digest,
      discoveryPolicy: this.#policy,
      schedulePolicyDigest: this.dependencies.schedulePolicy.digest,
      schedulePolicy: this.dependencies.schedulePolicy.value,
      factoryPolicyBundleDigest: this.dependencies.factoryPolicyBundleDigest,
      preparationGrantDigest: this.dependencies.preparationGrantDigest,
      roleIdentityPolicyDigest: this.dependencies.roleIdentityPolicyDigest,
      repository: { id: this.dependencies.repositoryId, baseRevision },
      scheduledFor,
      deadlineAt,
      createdAt,
      correlationId: this.#id()
    });
    const event = this.dependencies.documents.maintenanceDiscoveryEvent({
      ...eventBase(run.value, run.digest, this.#id(), 1, null, createdAt),
      kind: "registered",
      from: null,
      to: "ready",
      reasonCode: "maintenance-discovery-registered"
    });
    try {
      return await this.dependencies.discoveries.register(run, event);
    } catch (error: unknown) {
      const existing = await this.dependencies.discoveries.findBySlot(
        this.#policy.id,
        scheduledFor
      );
      if (existing === null) throw error;
      if (!this.#usesCurrentPins(existing))
        throw new ConflictError("Discovery slot was registered under different policy pins.");
      return existing;
    }
  }

  async #startAgent(
    snapshot: FactoryMaintenanceDiscoverySnapshot
  ): Promise<FactoryMaintenanceDiscoverySnapshot> {
    const [skill] = await Promise.all([
      this.dependencies.skill.publish(),
      this.dependencies.intake.publishPreparationSkills()
    ]);
    const prompt = renderFactoryMaintenanceDiscoveryPrompt({
      run: snapshot.run,
      runDigest: snapshot.runDigest,
      skill
    });
    const promptArtifact = await this.#putText(prompt, "text/plain; charset=utf-8");
    const executionId = this.#id();
    const outputSchemaDigest = skill.manifest.outputSchemaDigest;
    if (outputSchemaDigest === null)
      throw new Error("Discovery skill has no output schema digest.");
    const request = this.dependencies.documents.maintenanceDiscoveryRunRequest({
      schemaVersion: "agentlab.maintenance-discovery-run-request.v1",
      executionId,
      runId: snapshot.run.runId,
      taskId: snapshot.run.runId,
      runDigest: snapshot.runDigest,
      attempt: 1,
      provider: this.#policy.profile.provider,
      model: this.#policy.profile.model,
      reasoning: this.#policy.profile.reasoning,
      repository: snapshot.run.repository,
      skillId: skill.manifest.id,
      skillPackageDigest: skill.packageDigest,
      promptArtifact,
      outputSchemaDigest,
      capabilities: skill.manifest.requestedCapabilities,
      budget: skill.manifest.budgetCeiling
    });
    await this.#putCanonical(
      request.json,
      request.digest,
      "application/vnd.agentlab.maintenance-discovery-run-request+json;version=1"
    );
    return this.#append(snapshot, {
      ...this.#nextEvent(snapshot),
      kind: "agent-started",
      from: "ready",
      to: "agent-active",
      executionId,
      runRequestDigest: request.digest,
      reasonCode: "maintenance-discovery-agent-started"
    });
  }

  async #runAgent(
    snapshot: FactoryMaintenanceDiscoverySnapshot
  ): Promise<FactoryMaintenanceDiscoverySnapshot> {
    const started = snapshot.lastEvent;
    if (started.kind !== "agent-started")
      throw new Error("Active discovery has no agent start event.");
    const [request, skill, provider] = await Promise.all([
      this.#loadRunRequest(started.runRequestDigest),
      this.dependencies.skill.publish(),
      this.dependencies.providers.resolve(
        this.#policy.profile.provider,
        this.dependencies.repositoryRoot
      )
    ]);
    if (provider === null) throw new Error("Pinned maintenance discovery provider is unavailable.");
    this.#assertRunRequest(snapshot, request.value);
    const recovery = await this.dependencies.recovery.reconcile({
      taskId: snapshot.run.runId,
      workspaceId: request.value.executionId,
      attempt: 1,
      repositoryRoot: this.dependencies.repositoryRoot,
      baseRevision: snapshot.run.repository.baseRevision,
      processExecutionIds: [request.value.executionId]
    });
    if (recovery.status !== "inactive") {
      throw new ConflictError(
        `Maintenance discovery recovery is uncertain: ${recovery.reasonCode}.`
      );
    }
    const prompt = renderFactoryMaintenanceDiscoveryPrompt({
      run: snapshot.run,
      runDigest: snapshot.runDigest,
      skill
    });
    if (
      request.value.promptArtifact.digest !==
      (await this.#putText(prompt, "text/plain; charset=utf-8")).digest
    ) {
      throw new Error("Maintenance discovery prompt changed after its durable start event.");
    }
    const workspace = await this.dependencies.workspaces.create({
      taskId: snapshot.run.runId,
      workspaceId: request.value.executionId,
      attempt: 1,
      repositoryRoot: this.dependencies.repositoryRoot,
      baseRevision: snapshot.run.repository.baseRevision
    });
    let captured;
    try {
      const output = await this.dependencies.agents.execute({
        request: request.value,
        policyBundleDigest: snapshot.run.factoryPolicyBundleDigest,
        executable: provider.executable,
        providerVersion: provider.version,
        workspace,
        prompt,
        resourceLimits: this.#policy.profile.resourceLimits
      });
      captured = await new FactoryMaintenanceDiscoveryRunRecorder(
        this.dependencies.artifacts,
        this.dependencies.documents
      ).capture({ request, policy: this.#policy, output });
      await workspace.closeAndWait();
    } catch (error: unknown) {
      try {
        await workspace.closeAndWait();
      } catch (cleanupError: unknown) {
        throw new AggregateError(
          [error, cleanupError],
          "Discovery execution and workspace cleanup failed.",
          { cause: error }
        );
      }
      throw error;
    }
    const record = captured.record.value;
    if (captured.output === null || record.status !== "succeeded") {
      return this.#append(snapshot, {
        ...this.#nextEvent(snapshot, record.finishedAt),
        kind: "agent-failed",
        from: "agent-active",
        to: "failed",
        executionId: request.value.executionId,
        runRecordDigest: captured.record.digest,
        errorCode: record.errorCode ?? "discovery-run-failed",
        usage: record.usage,
        reasonCode: "maintenance-discovery-agent-failed"
      });
    }
    return this.#append(snapshot, {
      ...this.#nextEvent(snapshot, record.finishedAt),
      kind: "agent-finished",
      from: "agent-active",
      to: "admitting",
      executionId: request.value.executionId,
      runRecordDigest: captured.record.digest,
      outputDigest: captured.output.digest,
      findings: captured.output.value.findings.length,
      usage: record.usage,
      reasonCode: "maintenance-discovery-agent-finished"
    });
  }

  async #admitFindings(
    snapshot: FactoryMaintenanceDiscoverySnapshot
  ): Promise<FactoryMaintenanceDiscoverySnapshot> {
    const finished = snapshot.events.find(
      (
        event
      ): event is Extract<FactoryMaintenanceDiscoveryEvent, { readonly kind: "agent-finished" }> =>
        event.kind === "agent-finished"
    );
    if (finished === undefined)
      throw new Error("Discovery admission has no successful agent result.");
    const output = await this.#loadOutput(finished.outputDigest);
    const trackedPaths = await this.dependencies.evidenceInventory.trackedPaths(
      this.dependencies.repositoryRoot,
      snapshot.run.repository.baseRevision
    );
    const disposed = new Set(
      snapshot.events.flatMap((event) =>
        event.kind === "finding-admitted" || event.kind === "finding-skipped"
          ? [event.findingKey]
          : []
      )
    );
    const sorted = [...output.value.findings].sort(compareFindings);
    for (const candidate of sorted) {
      if (disposed.has(candidate.findingKey)) continue;
      const finding = this.dependencies.documents.maintenanceFinding({
        schemaVersion: "agentlab.maintenance-finding.v1",
        runId: snapshot.run.runId,
        runDigest: snapshot.runDigest,
        discoveredAt: finished.occurredAt,
        candidate
      });
      await this.#putCanonical(
        finding.json,
        finding.digest,
        "application/vnd.agentlab.maintenance-finding+json;version=1"
      );
      const reason = this.#admissionReason(snapshot, finding.value, trackedPaths);
      if (reason !== null) {
        snapshot = await this.#skip(snapshot, finding.value, finding.digest, reason);
        continue;
      }
      try {
        const result = await this.dependencies.intake.admit(
          snapshot.run,
          this.#policy,
          finding.value
        );
        snapshot = await this.#append(snapshot, {
          ...this.#nextEvent(snapshot),
          kind: "finding-admitted",
          from: "admitting",
          to: "admitting",
          findingKey: candidate.findingKey,
          findingDigest: finding.digest,
          taskId: result.taskId,
          requestDigest: result.requestDigest,
          authorityDigest: result.authorityDigest,
          reasonCode:
            result.status === "existing"
              ? "maintenance-finding-existing"
              : "maintenance-finding-admitted"
        });
      } catch (error: unknown) {
        if (!(error instanceof ConflictError)) throw error;
        snapshot = await this.#skip(
          snapshot,
          finding.value,
          finding.digest,
          "finding-identity-conflict"
        );
      }
    }
    return this.#append(snapshot, {
      ...this.#nextEvent(snapshot),
      kind: "completed",
      from: "admitting",
      to: "completed",
      findings: output.value.findings.length,
      admitted: countEvents(snapshot.events, "finding-admitted"),
      skipped: countEvents(snapshot.events, "finding-skipped"),
      usage: finished.usage,
      reasonCode: "maintenance-discovery-completed"
    });
  }

  #admissionReason(
    snapshot: FactoryMaintenanceDiscoverySnapshot,
    finding: FactoryMaintenanceFinding,
    trackedPaths: ReadonlySet<string>
  ): string | null {
    const candidate = finding.candidate;
    if (!this.#policy.allowedChangeClasses.includes(candidate.changeClass))
      return "change-class-denied";
    if (candidate.confidence < this.#policy.minimumConfidence) return "confidence-below-policy";
    if (countEvents(snapshot.events, "finding-admitted") >= this.#policy.maximumAdmissionsPerTick) {
      return "admission-limit-reached";
    }
    const paths = [...candidate.affectedPaths, ...candidate.evidence.map(({ path }) => path)];
    if (paths.some((path) => !trackedPaths.has(path))) return "evidence-path-not-tracked";
    if (
      paths.some(
        (path) =>
          !repositoryPathIsInScope(
            path,
            this.#policy.allowedIncludePaths,
            this.#policy.excludedPaths
          )
      )
    ) {
      return "finding-outside-scope";
    }
    if (
      paths.some((path) =>
        this.#policy.protectedPaths.some((pattern) => repositoryPathMatches(path, pattern))
      )
    ) {
      return "protected-path-denied";
    }
    return null;
  }

  async #skip(
    snapshot: FactoryMaintenanceDiscoverySnapshot,
    finding: FactoryMaintenanceFinding,
    findingDigest: Sha256Digest,
    skipReason: string
  ) {
    return this.#append(snapshot, {
      ...this.#nextEvent(snapshot),
      kind: "finding-skipped",
      from: "admitting",
      to: "admitting",
      findingKey: finding.candidate.findingKey,
      findingDigest,
      skipReason,
      reasonCode: skipReason
    });
  }

  async #loadRunRequest(digest: Sha256Digest) {
    const json = await this.dependencies.artifacts.readText(digest, 2 * 1_024 * 1_024);
    const document = this.dependencies.documents.maintenanceDiscoveryRunRequest(JSON.parse(json));
    if (document.digest !== digest || document.json !== json)
      throw new Error("Stored discovery run request is not canonical.");
    return document;
  }

  async #loadOutput(digest: Sha256Digest) {
    const json = await this.dependencies.artifacts.readText(digest, 2 * 1_024 * 1_024);
    const document = this.dependencies.documents.maintenanceDiscoveryOutput(JSON.parse(json));
    if (document.digest !== digest || document.json !== json)
      throw new Error("Stored discovery output is not canonical.");
    return document;
  }

  #assertRunRequest(
    snapshot: FactoryMaintenanceDiscoverySnapshot,
    request: FactoryMaintenanceDiscoveryRunRequest
  ): void {
    const skill = this.#policy.skill;
    if (
      request.runId !== snapshot.run.runId ||
      request.taskId !== snapshot.run.runId ||
      request.runDigest !== snapshot.runDigest ||
      request.repository.id !== snapshot.run.repository.id ||
      request.repository.baseRevision !== snapshot.run.repository.baseRevision ||
      request.provider !== this.#policy.profile.provider ||
      request.model !== this.#policy.profile.model ||
      request.reasoning !== this.#policy.profile.reasoning ||
      request.skillId !== skill.id ||
      request.skillPackageDigest !== skill.packageDigest ||
      request.outputSchemaDigest !== skill.outputSchemaDigest ||
      JSON.stringify(request.capabilities) !== JSON.stringify(skill.requestedCapabilities) ||
      JSON.stringify(request.budget) !== JSON.stringify(skill.budgetCeiling)
    ) {
      throw new Error("Stored maintenance discovery request changed after journal admission.");
    }
  }

  #assertPins(command: TickCommand): void {
    const pairs: readonly [string, string][] = [
      [command.expectedDiscoveryPolicyDigest, this.dependencies.discoveryPolicy.digest],
      [command.expectedSchedulePolicyDigest, this.dependencies.schedulePolicy.digest],
      [command.expectedFactoryPolicyBundleDigest, this.dependencies.factoryPolicyBundleDigest],
      [command.expectedPreparationGrantDigest, this.dependencies.preparationGrantDigest],
      [command.expectedRoleIdentityPolicyDigest, this.dependencies.roleIdentityPolicyDigest]
    ];
    if (pairs.some(([actual, expected]) => actual !== expected)) {
      throw new ConflictError("Maintenance discovery policy pins changed after review.");
    }
  }

  #usesCurrentPins(snapshot: FactoryMaintenanceDiscoverySnapshot): boolean {
    return (
      snapshot.run.discoveryPolicyDigest === this.dependencies.discoveryPolicy.digest &&
      snapshot.run.schedulePolicyDigest === this.dependencies.schedulePolicy.digest &&
      snapshot.run.factoryPolicyBundleDigest === this.dependencies.factoryPolicyBundleDigest &&
      snapshot.run.preparationGrantDigest === this.dependencies.preparationGrantDigest &&
      snapshot.run.roleIdentityPolicyDigest === this.dependencies.roleIdentityPolicyDigest
    );
  }

  async #append(
    snapshot: FactoryMaintenanceDiscoverySnapshot,
    eventValue: FactoryMaintenanceDiscoveryEvent
  ): Promise<FactoryMaintenanceDiscoverySnapshot> {
    const event = this.dependencies.documents.maintenanceDiscoveryEvent(eventValue);
    const appended = await this.dependencies.discoveries.append(event);
    if (appended === null)
      throw new ConflictError("Maintenance discovery journal advanced concurrently.");
    return appended;
  }

  #nextEvent(snapshot: FactoryMaintenanceDiscoverySnapshot, occurredAt?: string) {
    return eventBase(
      snapshot.run,
      snapshot.runDigest,
      this.#id(),
      snapshot.sequence + 1,
      snapshot.lastEventDigest,
      occurredAt ?? factoryTimestampSchema.parse(this.dependencies.now())
    );
  }

  async #putText(content: string, mediaType: string) {
    const stored = await this.dependencies.artifacts.putText(content);
    return { digest: stored.digest, mediaType, sizeBytes: stored.sizeBytes };
  }

  async #putCanonical(json: string, expectedDigest: string, mediaType: string) {
    const artifact = await this.#putText(json, mediaType);
    if (artifact.digest !== expectedDigest)
      throw new Error("Canonical discovery artifact digest changed during publication.");
    return artifact;
  }

  #id(): string {
    return z.uuid().parse(this.dependencies.createId());
  }

  #report(
    status: FactoryMaintenanceDiscoveryTickReport["status"],
    snapshot: FactoryMaintenanceDiscoverySnapshot,
    reasonCodes: readonly string[]
  ): FactoryMaintenanceDiscoveryTickReport {
    const finished = snapshot.events.find(
      (
        event
      ): event is Extract<
        FactoryMaintenanceDiscoveryEvent,
        { readonly kind: "agent-finished" | "agent-failed" }
      > => event.kind === "agent-finished" || event.kind === "agent-failed"
    );
    return {
      schemaVersion: "agentlab.maintenance-discovery-tick-result.v1",
      status,
      scheduledFor: snapshot.run.scheduledFor,
      deadlineAt: snapshot.run.deadlineAt,
      runId: snapshot.run.runId,
      runDigest: snapshot.runDigest,
      findings: finished?.kind === "agent-finished" ? finished.findings : 0,
      admitted: countEvents(snapshot.events, "finding-admitted"),
      skipped: countEvents(snapshot.events, "finding-skipped"),
      usage: finished?.usage ?? emptyUsage(),
      reasonCodes: uniqueSorted(reasonCodes)
    };
  }
}

function eventBase(
  run: FactoryMaintenanceDiscoveryRun,
  runDigest: Sha256Digest,
  eventId: string,
  sequence: number,
  previousEventDigest: Sha256Digest | null,
  occurredAt: string
) {
  return {
    schemaVersion: "agentlab.maintenance-discovery-event.v1" as const,
    eventId,
    runId: run.runId,
    runDigest,
    sequence,
    previousEventDigest,
    actor: {
      kind: "control-plane" as const,
      role: "policy-engine" as const,
      id: "agentlab-maintenance-discovery",
      sessionId: null
    },
    occurredAt,
    correlationId: run.correlationId
  };
}

function compareFindings(
  left: FactoryMaintenanceDiscoveryOutput["findings"][number],
  right: FactoryMaintenanceDiscoveryOutput["findings"][number]
): number {
  return (
    right.priority - left.priority ||
    right.confidence - left.confidence ||
    left.findingKey.localeCompare(right.findingKey)
  );
}

function countEvents(
  events: readonly FactoryMaintenanceDiscoveryEvent[],
  kind: FactoryMaintenanceDiscoveryEvent["kind"]
): number {
  return events.filter((event) => event.kind === kind).length;
}

function uniqueSorted(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort();
}

function emptyUsage(): FactoryBudgetUsage {
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

function emptyReport(
  status: FactoryMaintenanceDiscoveryTickReport["status"],
  scheduledFor: string,
  deadlineAt: string,
  reasonCodes: readonly string[]
): FactoryMaintenanceDiscoveryTickReport {
  return {
    schemaVersion: "agentlab.maintenance-discovery-tick-result.v1",
    status,
    scheduledFor,
    deadlineAt,
    runId: null,
    runDigest: null,
    findings: 0,
    admitted: 0,
    skipped: 0,
    usage: emptyUsage(),
    reasonCodes: uniqueSorted(reasonCodes)
  };
}
