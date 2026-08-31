import type { FactoryControlEvent, FactoryControlName } from "@agentlab/contracts";
import { describe, expect, it, vi } from "vitest";

import { FactoryAuthorityOperator } from "../../packages/runtime/src/application/factory-authority-operator.js";
import type { CanonicalFactoryDocument } from "../../packages/runtime/src/domain/factory-documents.js";
import type {
  FactoryAuthorityState,
  FactoryControlRepository
} from "../../packages/runtime/src/domain/factory-task-repository.js";
import { NodeFactoryDocumentCodec } from "../../packages/runtime/src/infrastructure/persistence/canonical-factory-documents.js";

const now = "2026-08-31T12:00:00.000Z";
const eventId = "0198f005-4ec4-7000-8000-000000000001";

describe("FactoryAuthorityOperator", () => {
  it("inspects local state and bounded scheduler and broker audit history", async () => {
    const controls = new MemoryControls({ scheduler: false, prBroker: true });
    const operator = createOperator(controls);

    await expect(operator.inspect()).resolves.toEqual({
      schemaVersion: "agentlab.authority-inspection.v2",
      schedulerEnabled: false,
      prBrokerEnabled: true,
      recentSchedulerEvents: [],
      recentBrokerEvents: []
    });
    expect(controls.historyCalls).toEqual([
      { control: "scheduler", limit: 20 },
      { control: "pr-broker", limit: 20 }
    ]);
  });

  it("records scheduler authority independently through compare-and-set", async () => {
    const controls = new MemoryControls();
    const operator = createOperator(controls);

    await expect(
      operator.setSchedulerAuthority({
        expectedEnabled: false,
        enabled: true,
        reason: "Approved bounded daily maintenance.",
        confirmation: "enable-scheduler"
      })
    ).resolves.toMatchObject({
      schemaVersion: "agentlab.scheduler-authority-change-result.v1",
      schedulerEnabled: true,
      prBrokerEnabled: false,
      event: { control: "scheduler", enabled: true }
    });
    expect(controls.stateValue).toEqual({ scheduler: true, prBroker: false });
    expect(controls.expectedStates).toEqual([false]);
  });

  it("records one pinned human event through compare-and-set without changing scheduler", async () => {
    const controls = new MemoryControls();
    const operator = createOperator(controls);

    const result = await operator.setBrokerAuthority({
      expectedEnabled: false,
      enabled: true,
      reason: "Approved for one governed draft-PR canary.",
      confirmation: "enable-draft-broker"
    });

    expect(result).toMatchObject({
      schemaVersion: "agentlab.authority-change-result.v1",
      changed: true,
      schedulerEnabled: false,
      prBrokerEnabled: true,
      event: {
        eventId,
        control: "pr-broker",
        enabled: true,
        actor: {
          kind: "human",
          role: "requester",
          id: "maintainer/riad",
          sessionId: null
        },
        occurredAt: now,
        reason: "Approved for one governed draft-PR canary."
      }
    });
    expect(result.eventDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(controls.stateValue).toEqual({ scheduler: false, prBroker: true });
    expect(controls.expectedStates).toEqual([false]);
  });

  it("rejects no-op, mismatched-confirmation, and unknown commands before creating an event", async () => {
    const controls = new MemoryControls();
    const createId = vi.fn(() => eventId);
    const operator = createOperator(controls, createId);

    await expect(
      operator.setBrokerAuthority({
        expectedEnabled: false,
        enabled: false,
        reason: "No-op.",
        confirmation: "disable-draft-broker"
      })
    ).rejects.toThrow(/opposite state/u);
    await expect(
      operator.setBrokerAuthority({
        expectedEnabled: false,
        enabled: true,
        reason: "Wrong confirmation.",
        confirmation: "disable-draft-broker"
      })
    ).rejects.toThrow(/confirmation/u);
    await expect(
      operator.setBrokerAuthority({
        expectedEnabled: false,
        enabled: true,
        reason: "Unexpected field.",
        confirmation: "enable-draft-broker",
        scheduler: true
      })
    ).rejects.toThrow();
    expect(createId).not.toHaveBeenCalled();
    expect(controls.events).toEqual([]);
  });

  it("fails closed when authority changed after inspection", async () => {
    const controls = new MemoryControls();
    controls.forceConflict = true;
    const operator = createOperator(controls);

    await expect(
      operator.setBrokerAuthority({
        expectedEnabled: false,
        enabled: true,
        reason: "Stale operator view.",
        confirmation: "enable-draft-broker"
      })
    ).rejects.toThrow(/changed concurrently/u);
    expect(controls.events).toEqual([]);
  });
});

class MemoryControls implements FactoryControlRepository {
  public readonly events: FactoryControlEvent[] = [];
  public readonly expectedStates: boolean[] = [];
  public readonly historyCalls: { readonly control: FactoryControlName; readonly limit: number }[] =
    [];
  public forceConflict = false;

  public constructor(
    public stateValue: FactoryAuthorityState = { scheduler: false, prBroker: false }
  ) {}

  public state(): Promise<FactoryAuthorityState> {
    return Promise.resolve(this.stateValue);
  }

  public record(
    event: CanonicalFactoryDocument<FactoryControlEvent>
  ): Promise<FactoryAuthorityState>;
  public record(
    event: CanonicalFactoryDocument<FactoryControlEvent>,
    expectedEnabled: boolean
  ): Promise<FactoryAuthorityState | null>;
  public record(
    event: CanonicalFactoryDocument<FactoryControlEvent>,
    expectedEnabled?: boolean
  ): Promise<FactoryAuthorityState | null> {
    if (expectedEnabled !== undefined) this.expectedStates.push(expectedEnabled);
    if (
      this.forceConflict ||
      (expectedEnabled !== undefined &&
        this.stateValue[event.value.control === "scheduler" ? "scheduler" : "prBroker"] !==
          expectedEnabled)
    ) {
      return Promise.resolve(null);
    }
    this.events.unshift(event.value);
    this.stateValue =
      event.value.control === "scheduler"
        ? { ...this.stateValue, scheduler: event.value.enabled }
        : { ...this.stateValue, prBroker: event.value.enabled };
    return Promise.resolve(this.stateValue);
  }

  public history(
    control: FactoryControlName,
    limit: number
  ): Promise<readonly FactoryControlEvent[]> {
    this.historyCalls.push({ control, limit });
    return Promise.resolve(
      this.events.filter((event) => event.control === control).slice(0, limit)
    );
  }
}

function createOperator(
  controls: FactoryControlRepository,
  createId: () => string = () => eventId
): FactoryAuthorityOperator {
  return new FactoryAuthorityOperator({
    controls,
    documents: new NodeFactoryDocumentCodec(),
    operatorId: "maintainer/riad",
    now: () => now,
    createId
  });
}
