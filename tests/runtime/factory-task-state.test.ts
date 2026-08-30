import { describe, expect, it } from "vitest";

import { factoryTaskStateSchema } from "@agentlab/contracts";

import {
  allowedFactoryTaskTransitions,
  isFactoryTaskTransitionAllowed,
  isTerminalFactoryTaskState
} from "../../packages/runtime/src/domain/factory-task-state.js";

describe("factory task state machine", () => {
  it("has an explicit transition entry for every public state", () => {
    for (const state of factoryTaskStateSchema.options) {
      expect(allowedFactoryTaskTransitions(state)).toBeDefined();
    }
  });

  it("admits only intake as the initial state", () => {
    expect(isFactoryTaskTransitionAllowed(null, "intake")).toBe(true);
    expect(isFactoryTaskTransitionAllowed(null, "queued")).toBe(false);
  });

  it("supports verification and repair without bypassing review", () => {
    expect(isFactoryTaskTransitionAllowed("executing", "verifying")).toBe(true);
    expect(isFactoryTaskTransitionAllowed("verifying", "repairing")).toBe(true);
    expect(isFactoryTaskTransitionAllowed("repairing", "verifying")).toBe(true);
    expect(isFactoryTaskTransitionAllowed("verifying", "pr-proposed")).toBe(false);
    expect(isFactoryTaskTransitionAllowed("reviewing", "pr-proposed")).toBe(true);
  });

  it("makes attention, incident, and completion outcomes terminal", () => {
    for (const state of [
      "completed",
      "needs-attention",
      "rejected",
      "cancelled",
      "expired",
      "failed",
      "quarantined",
      "rolled-back"
    ] as const) {
      expect(isTerminalFactoryTaskState(state)).toBe(true);
      expect(allowedFactoryTaskTransitions(state)).toEqual([]);
    }
  });
});
