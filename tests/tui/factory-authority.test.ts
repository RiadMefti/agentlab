import type {
  FactoryAuthorityInspection,
  FactoryBrokerAuthorityChange,
  LocalFactoryAuthorityConfig,
  LocalFactoryAuthorityRuntime
} from "@agentlab/runtime/factory-authority";
import { describe, expect, it, vi } from "vitest";

import {
  runFactoryAuthorityStatus,
  runFactoryBrokerAuthority,
  type FactoryAuthorityRunnerDependencies
} from "../../apps/tui/src/run-factory-authority.js";

const configPath = "/private/agentlab/authority.json";

describe("factory authority CLI runner", () => {
  it("prints a deterministic inspection only after clean shutdown", async () => {
    const writes: string[] = [];
    const close = vi.fn(() => Promise.resolve());
    const dependencies = runnerDependencies(close, writes);

    await expect(runFactoryAuthorityStatus(configPath, dependencies)).resolves.toBe(0);

    expect(close).toHaveBeenCalledOnce();
    expect(writes).toHaveLength(1);
    expect(JSON.parse(writes[0] ?? "")).toEqual(inspection());
  });

  it("passes the exact compare-and-set command and emits its append-only event result", async () => {
    const writes: string[] = [];
    const setBrokerAuthority = vi.fn(() => Promise.resolve(change()));
    const close = vi.fn(() => Promise.resolve());
    const dependencies = runnerDependencies(close, writes, setBrokerAuthority);

    await expect(
      runFactoryBrokerAuthority(
        configPath,
        false,
        true,
        "Approved for one governed canary.",
        "enable-draft-broker",
        dependencies
      )
    ).resolves.toBe(0);

    expect(setBrokerAuthority).toHaveBeenCalledWith({
      expectedEnabled: false,
      enabled: true,
      reason: "Approved for one governed canary.",
      confirmation: "enable-draft-broker"
    });
    expect(close).toHaveBeenCalledOnce();
    expect(JSON.parse(writes[0] ?? "")).toEqual(change());
  });

  it("closes on operation failure and suppresses output when cleanup also fails", async () => {
    const writes: string[] = [];
    const operationFailure = new Error("authority conflict");
    const cleanupFailure = new Error("cleanup failed");
    const runtime = authorityRuntime(
      Promise.reject(operationFailure),
      vi.fn(() => Promise.reject(cleanupFailure))
    );
    const dependencies: FactoryAuthorityRunnerDependencies = {
      loadConfig: () => Promise.resolve(config()),
      createRuntime: () => runtime,
      write: (message) => writes.push(message)
    };

    await expect(runFactoryAuthorityStatus(configPath, dependencies)).rejects.toEqual(
      expect.objectContaining({
        name: "AggregateError",
        errors: [operationFailure, cleanupFailure]
      })
    );
    expect(writes).toEqual([]);
  });
});

function runnerDependencies(
  close: () => Promise<void>,
  writes: string[],
  setBrokerAuthority: (input: unknown) => Promise<FactoryBrokerAuthorityChange> = () =>
    Promise.resolve(change())
): FactoryAuthorityRunnerDependencies {
  return {
    loadConfig: vi.fn(() => Promise.resolve(config())),
    createRuntime: vi.fn(() =>
      authorityRuntime(Promise.resolve(inspection()), close, setBrokerAuthority)
    ),
    write: (message) => writes.push(message)
  };
}

function authorityRuntime(
  inspect: Promise<FactoryAuthorityInspection>,
  close: () => Promise<void>,
  setBrokerAuthority: (input: unknown) => Promise<FactoryBrokerAuthorityChange> = () =>
    Promise.resolve(change())
): LocalFactoryAuthorityRuntime {
  return {
    commands: { inspect: () => inspect, setBrokerAuthority },
    close
  };
}

function inspection(): FactoryAuthorityInspection {
  return {
    schemaVersion: "agentlab.authority-inspection.v1",
    schedulerEnabled: false,
    prBrokerEnabled: false,
    recentBrokerEvents: []
  };
}

function change(): FactoryBrokerAuthorityChange {
  return {
    schemaVersion: "agentlab.authority-change-result.v1",
    changed: true,
    schedulerEnabled: false,
    prBrokerEnabled: true,
    event: {
      schemaVersion: "agentlab.control-event.v1",
      eventId: "0198f005-4ec4-7000-8000-000000000001",
      control: "pr-broker",
      enabled: true,
      actor: {
        kind: "human",
        role: "requester",
        id: "maintainer/riad",
        sessionId: null
      },
      occurredAt: "2026-08-31T12:00:00.000Z",
      reason: "Approved for one governed canary."
    },
    eventDigest: `sha256:${"a".repeat(64)}`
  };
}

function config(): LocalFactoryAuthorityConfig {
  return {
    schemaVersion: "agentlab.local-factory-authority.v1",
    databasePath: "/private/agentlab/agentlab.sqlite",
    operatorId: "maintainer/riad"
  };
}
