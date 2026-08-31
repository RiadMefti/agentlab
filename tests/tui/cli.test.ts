import { describe, expect, it } from "vitest";

import {
  assertSupportedTerminalRuntime,
  helpText,
  parseCliArguments
} from "../../apps/tui/src/cli.js";

describe("terminal CLI", () => {
  it("always opens the project chooser when no arguments are supplied", () => {
    expect(parseCliArguments([])).toEqual({ kind: "run" });
  });

  it("rejects positional workspaces so startup cannot bypass the project chooser", () => {
    expect(() => parseCliArguments(["/tmp/project"])).toThrow("Usage: agentlab");
  });

  it("recognizes informational flags without requiring a TTY", () => {
    expect(parseCliArguments(["--help"])).toEqual({ kind: "help" });
    expect(parseCliArguments(["-v"])).toEqual({ kind: "version" });
  });

  it("recognizes only exact factory readiness commands", () => {
    expect(
      parseCliArguments([
        "factory",
        "broker-preflight",
        "--config",
        "/private/agentlab/broker.json"
      ])
    ).toEqual({
      kind: "factory-broker-preflight",
      configPath: "/private/agentlab/broker.json"
    });
    expect(() =>
      parseCliArguments(["factory", "broker-preflight", "--config", "broker.json"])
    ).toThrow(/Usage/u);
    expect(() =>
      parseCliArguments(["factory", "broker-preflight", "--enable", "/private/broker.json"])
    ).toThrow(/Usage/u);
    expect(
      parseCliArguments([
        "factory",
        "worker-preflight",
        "--config",
        "/private/agentlab/worker.json"
      ])
    ).toEqual({
      kind: "factory-worker-preflight",
      configPath: "/private/agentlab/worker.json"
    });
  });

  it("requires an exact task, policy pin, and confirmation for draft creation", () => {
    const taskId = "0198f005-4ec4-7000-8000-000000000001";
    const policy = `sha256:${"a".repeat(64)}`;
    expect(
      parseCliArguments([
        "factory",
        "broker-open-draft",
        "--config",
        "/private/agentlab/broker.json",
        "--task",
        taskId,
        "--policy",
        policy,
        "--confirm-draft"
      ])
    ).toEqual({
      kind: "factory-broker-open-draft",
      configPath: "/private/agentlab/broker.json",
      taskId,
      expectedPolicyBundleDigest: policy,
      confirmation: "confirm-draft"
    });
    expect(() =>
      parseCliArguments([
        "factory",
        "broker-open-draft",
        "--config",
        "/private/agentlab/broker.json",
        "--task",
        taskId,
        "--policy",
        policy
      ])
    ).toThrow(/Usage/u);
    expect(() =>
      parseCliArguments([
        "factory",
        "broker-open-draft",
        "--config",
        "/private/agentlab/broker.json",
        "--task",
        "not-a-task",
        "--policy",
        policy,
        "--confirm-draft"
      ])
    ).toThrow(/Usage/u);
  });

  it("requires exact compare-and-set state, reason, and matching broker confirmation", () => {
    expect(
      parseCliArguments([
        "factory",
        "authority-status",
        "--config",
        "/private/agentlab/authority.json"
      ])
    ).toEqual({
      kind: "factory-authority-status",
      configPath: "/private/agentlab/authority.json"
    });
    expect(
      parseCliArguments([
        "factory",
        "broker-authority",
        "--config",
        "/private/agentlab/authority.json",
        "--expected",
        "disabled",
        "--to",
        "enabled",
        "--reason",
        "Approved for one governed canary.",
        "--confirm-enable-draft-broker"
      ])
    ).toEqual({
      kind: "factory-broker-authority",
      configPath: "/private/agentlab/authority.json",
      expectedEnabled: false,
      enabled: true,
      reason: "Approved for one governed canary.",
      confirmation: "enable-draft-broker"
    });
    expect(() =>
      parseCliArguments([
        "factory",
        "broker-authority",
        "--config",
        "/private/agentlab/authority.json",
        "--expected",
        "disabled",
        "--to",
        "enabled",
        "--reason",
        "Wrong confirmation.",
        "--confirm-disable-draft-broker"
      ])
    ).toThrow(/Usage/u);
    expect(() =>
      parseCliArguments([
        "factory",
        "broker-authority",
        "--config",
        "/private/agentlab/authority.json",
        "--expected",
        "enabled",
        "--to",
        "enabled",
        "--reason",
        "No-op.",
        "--confirm-enable-draft-broker"
      ])
    ).toThrow(/Usage/u);
  });

  it("documents explicit factory commands and the child-mouse emergency kill switch", () => {
    expect(helpText).toContain("factory broker-preflight --config");
    expect(helpText).toContain("factory worker-preflight --config");
    expect(helpText).toContain("factory broker-open-draft --config");
    expect(helpText).toContain("factory authority-status --config");
    expect(helpText).toContain("factory broker-authority --config");
    expect(helpText).toContain("never enables scheduling or contacts GitHub");
    expect(helpText).toContain("--confirm-draft");
    expect(helpText).toContain("AGENTLAB_DISABLE_MOUSE");
    expect(helpText).toContain("keep mouse input local");
  });

  it("rejects unknown flags and ambiguous arguments", () => {
    expect(() => parseCliArguments(["--listen"])).toThrow("Usage");
    expect(() => parseCliArguments(["one", "two"])).toThrow("Usage");
  });

  it("fails clearly before OpenTUI loads for an unsupported musl build", () => {
    expect(() => {
      assertSupportedTerminalRuntime("linux", { OPENTUI_LIBC: "musl" });
    }).toThrow("requires glibc");
    expect(() => {
      assertSupportedTerminalRuntime("linux", { OPENTUI_LIBC: "glibc" });
    }).not.toThrow();
    expect(() => {
      assertSupportedTerminalRuntime("darwin", { OPENTUI_LIBC: "musl" });
    }).not.toThrow();
  });
});
