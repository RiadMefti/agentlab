/** @jsxImportSource @opentui/react */

import { useState, type ReactNode } from "react";

import { afterEach, describe, expect, mock, test } from "bun:test";
import { useKeyboard } from "@opentui/react";
import { testRender } from "@opentui/react/test-utils";

import type { AgentSession, Conversation, ProviderCapability } from "@agentlab/contracts";
import {
  maximumTerminalDimension,
  type LocalAgentLabRuntime,
  type OpenSessionTerminalInput,
  type AgentLabCommandPort,
  type SessionTerminal
} from "@agentlab/runtime";

import { App } from "../../apps/tui/src/app.js";
import {
  boundTerminalDimensions,
  TerminalPanel
} from "../../apps/tui/src/components/terminal-panel.js";
import { RuntimeContext } from "../../apps/tui/src/runtime-context.js";
import { maximumQueuedTerminalBytes } from "../../apps/tui/src/terminal/terminal-ingestion-pump.js";
import { allowOpenTuiAsyncUpdates } from "./test-renderer.js";

const renderers: { destroy(): void }[] = [];

afterEach(() => {
  for (const renderer of renderers.splice(0)) renderer.destroy();
});

describe("terminal workspace", () => {
  test("renders the three-column workspace and opens its keyboard-first dialog", async () => {
    const runtime = fakeRuntime();
    const setup = await testRender(
      <RuntimeContext value={runtime}>
        <App />
      </RuntimeContext>,
      { height: 35, width: 120 }
    );
    allowOpenTuiAsyncUpdates();
    renderers.push(setup.renderer);
    await setup.waitForFrame((frame) => frame.includes("Choose a project"));

    const initial = setup.captureCharFrame();
    expect(initial).toContain("Projects · 0");
    expect(initial).toContain("Agents · 0");
    expect(initial).toContain("Workers · 0");

    setup.mockInput.pressKey("n", { ctrl: true });
    await setup.waitForFrame((frame) => frame.includes("Add project"));

    expect(setup.captureCharFrame()).toContain("Choose the project folder");
    setup.mockInput.pressEscape();
    await setup.waitForFrame((frame) => !frame.includes("Add project"));
  });

  test("accepts a project folder from anywhere before configuring its captain", async () => {
    const runtime = fakeRuntime();
    const setup = await testRender(
      <RuntimeContext value={runtime}>
        <App />
      </RuntimeContext>,
      { height: 35, width: 120 }
    );
    allowOpenTuiAsyncUpdates();
    renderers.push(setup.renderer);
    await setup.waitForFrame((frame) => frame.includes("Choose a project"));

    setup.mockInput.pressKey("n", { ctrl: true });
    await setup.waitForFrame((frame) => frame.includes("Choose the project folder"));
    await setup.mockInput.typeText("/tmp/anywhere/project folder");
    await allowStateUpdate(setup);
    setup.mockInput.pressEnter();
    await allowStateUpdate(setup);
    expect(calls(runtime.commands.prepareWorkspace)).toContainEqual([
      "/tmp/anywhere/project folder"
    ]);
    await setup.waitForFrame(
      (frame) => frame.includes("Captain") && frame.includes("/tmp/anywhere/project folder")
    );
  });

  test("creates with trimmed canonical provider-default input", async () => {
    const createConversation = mock(() => deferred(conversation));
    const runtime = fakeRuntime({
      commandOverrides: {
        prepareWorkspace: mock(() =>
          Promise.resolve({
            workspacePath: "/canonical/project",
            suggestedName: "  Canonical title  "
          })
        ),
        discoverWorkspaceProviders: mock(() => Promise.resolve(availableProviders)),
        createConversation
      }
    });
    const setup = await testRender(
      <RuntimeContext value={runtime}>
        <App />
      </RuntimeContext>,
      { height: 18, width: 90 }
    );
    allowOpenTuiAsyncUpdates();
    renderers.push(setup.renderer);
    await setup.waitForFrame((frame) => frame.includes("Choose a project"));

    setup.mockInput.pressKey("n", { ctrl: true });
    await setup.waitForFrame((frame) => frame.includes("Choose the project folder"));
    await setup.mockInput.typeText("/requested/project");
    await allowStateUpdate(setup);
    setup.mockInput.pressEnter();
    await allowStateUpdate(setup);
    await setup.waitForFrame((frame) => frame.includes("Codex: ready"));
    setup.mockInput.pressEnter({ ctrl: true });
    await setup.waitFor(() => callCount(createConversation) === 1);

    expect(calls(createConversation)[0]).toEqual([
      {
        title: "Canonical title",
        workspacePath: "/canonical/project",
        provider: "codex",
        model: null,
        reasoning: null,
        prompt: null
      }
    ]);
  });

  test("allows a replacement inspection while the edited-path request is still pending", async () => {
    const first = deferredRequest<{ workspacePath: string; suggestedName: string }>();
    const second = deferredRequest<{ workspacePath: string; suggestedName: string }>();
    let preparation = 0;
    const prepareWorkspace = mock(() => (preparation++ === 0 ? first.promise : second.promise));
    const runtime = fakeRuntime({ commandOverrides: { prepareWorkspace } });
    const setup = await testRender(
      <RuntimeContext value={runtime}>
        <App />
      </RuntimeContext>,
      { height: 18, width: 90 }
    );
    allowOpenTuiAsyncUpdates();
    renderers.push(setup.renderer);
    await setup.waitForFrame((frame) => frame.includes("Choose a project"));

    setup.mockInput.pressKey("n", { ctrl: true });
    await setup.waitForFrame((frame) => frame.includes("Add project · 1/2"));
    await setup.mockInput.typeText("/first");
    await allowStateUpdate(setup);
    setup.mockInput.pressEnter();
    await setup.waitFor(() => callCount(prepareWorkspace) === 1);
    await setup.mockInput.typeText("-edited");
    await allowStateUpdate(setup);
    setup.mockInput.pressEnter();
    await setup.waitFor(() => callCount(prepareWorkspace) === 2);
    second.resolve({ workspacePath: "/first-edited", suggestedName: "first-edited" });
    await setup.waitForFrame((frame) => frame.includes("first-edited"));
    first.resolve({ workspacePath: "/stale", suggestedName: "stale" });
    await allowStateUpdate(setup);

    expect(setup.captureCharFrame()).not.toContain("/stale");
  });

  test("suppresses stale autocomplete and accepts its highlighted result with the keyboard", async () => {
    const first = deferredRequest<readonly { value: string; label: string; symlink: boolean }[]>();
    const second = deferredRequest<readonly { value: string; label: string; symlink: boolean }[]>();
    let completion = 0;
    const completeFolders = mock(() => (completion++ === 0 ? first.promise : second.promise));
    const runtime = fakeRuntime({ commandOverrides: { completeFolders } });
    const setup = await testRender(
      <RuntimeContext value={runtime}>
        <App />
      </RuntimeContext>,
      { height: 18, width: 90 }
    );
    allowOpenTuiAsyncUpdates();
    renderers.push(setup.renderer);
    await setup.waitForFrame((frame) => frame.includes("Choose a project"));
    setup.mockInput.pressKey("n", { ctrl: true });
    await setup.waitForFrame((frame) => frame.includes("Add project · 1/2"));
    await setup.mockInput.typeText("a");
    await waitMilliseconds(90);
    await setup.mockInput.typeText("b");
    await waitMilliseconds(90);
    await setup.waitFor(() => callCount(completeFolders) === 2);
    second.resolve([
      { value: "about/", label: "about/", symlink: false },
      { value: "absolute/", label: "absolute/", symlink: false }
    ]);
    await allowStateUpdate(setup);
    await setup.waitForFrame((frame) => frame.includes("absolute/"));
    first.resolve([{ value: "ancient/", label: "ancient/", symlink: false }]);
    await allowStateUpdate(setup);
    expect(setup.captureCharFrame()).not.toContain("ancient/");

    setup.mockInput.pressArrow("down");
    await allowStateUpdate(setup);
    setup.mockInput.pressTab();
    await allowStateUpdate(setup);
    setup.mockInput.pressEnter();
    await setup.waitFor(() => callCount(runtime.commands.prepareWorkspace) === 1);
    expect(calls(runtime.commands.prepareWorkspace)[0]).toEqual(["absolute/"]);
  });

  test("degrades visibly when folder completion misses its filesystem deadline", async () => {
    const slow = deferredRequest<readonly { value: string; label: string; symlink: boolean }[]>();
    const runtime = fakeRuntime({
      commandOverrides: { completeFolders: mock(() => slow.promise) }
    });
    const setup = await testRender(
      <RuntimeContext value={runtime}>
        <App />
      </RuntimeContext>,
      { height: 18, width: 90 }
    );
    allowOpenTuiAsyncUpdates();
    renderers.push(setup.renderer);
    await setup.waitForFrame((frame) => frame.includes("Choose a project"));
    setup.mockInput.pressKey("n", { ctrl: true });
    await setup.waitForFrame((frame) => frame.includes("Add project · 1/2"));
    await setup.mockInput.typeText("/slow-mount");
    await waitMilliseconds(270);
    await allowStateUpdate(setup);
    expect(setup.captureCharFrame()).toContain("Suggestions paused");

    slow.resolve([{ value: "/late/", label: "/late/", symlink: false }]);
    await allowStateUpdate(setup);
    expect(setup.captureCharFrame()).not.toContain("/late/");
  });

  test("accepts a folder suggestion with the mouse and fits both steps at exactly 90x18", async () => {
    const completeFolders = mock(() =>
      Promise.resolve([{ value: "mouse folder/", label: "mouse folder/", symlink: false }])
    );
    const runtime = fakeRuntime({
      commandOverrides: {
        completeFolders,
        discoverWorkspaceProviders: mock(() => Promise.resolve(availableProviders))
      }
    });
    const setup = await testRender(
      <RuntimeContext value={runtime}>
        <App />
      </RuntimeContext>,
      { height: 18, width: 90 }
    );
    allowOpenTuiAsyncUpdates();
    renderers.push(setup.renderer);
    await setup.waitForFrame((frame) => frame.includes("Choose a project"));
    setup.mockInput.pressKey("n", { ctrl: true });
    await setup.waitForFrame((frame) => frame.includes("Add project · 1/2"));
    await setup.mockInput.typeText("m");
    await waitMilliseconds(90);
    await setup.waitForFrame((frame) => frame.includes("mouse folder/"));
    const frame = setup.captureCharFrame();
    const suggestionRow = frame.split("\n").findIndex((line) => line.includes("mouse folder/"));
    const suggestionColumn = frame.split("\n")[suggestionRow]?.indexOf("mouse folder/") ?? -1;
    expect(suggestionRow).toBeGreaterThanOrEqual(0);
    await setup.mockMouse.click(suggestionColumn + 2, suggestionRow);
    await allowStateUpdate(setup);
    expect(setup.captureCharFrame()).toContain("mouse folder/");

    const compactSetup = await testRender(
      <RuntimeContext value={runtime}>
        <App />
      </RuntimeContext>,
      { height: 18, width: 90 }
    );
    allowOpenTuiAsyncUpdates();
    renderers.push(compactSetup.renderer);
    await compactSetup.waitForFrame((next) => next.includes("Choose a project"));
    compactSetup.mockInput.pressKey("n", { ctrl: true });
    await compactSetup.waitForFrame((next) => next.includes("Add project · 1/2"));
    await compactSetup.mockInput.typeText("/compact");
    await allowStateUpdate(compactSetup);
    compactSetup.mockInput.pressEnter();
    await allowStateUpdate(compactSetup);
    await compactSetup.waitForFrame((next) => next.includes("Captain") && next.includes("change"));

    const compact = compactSetup.captureCharFrame();
    expect(compact).toContain("Captain runs commands and edits this folder without approval");
    expect(compact).toContain("prompts. Provider safeguards vary.");
    expect(compact).toContain("Ctrl+Enter start");
    expect(compact).not.toContain("Terminal too small");
  });

  test("shows provider discovery progress and recovers through inline retry", async () => {
    const discovery = deferredRequest<readonly ProviderCapability[]>();
    let discoveryAttempt = 0;
    const discoverWorkspaceProviders = mock(() =>
      discoveryAttempt++ === 0 ? discovery.promise : Promise.resolve(availableProviders)
    );
    const runtime = fakeRuntime({ commandOverrides: { discoverWorkspaceProviders } });
    const setup = await testRender(
      <RuntimeContext value={runtime}>
        <App />
      </RuntimeContext>,
      { height: 18, width: 90 }
    );
    allowOpenTuiAsyncUpdates();
    renderers.push(setup.renderer);
    await setup.waitForFrame((frame) => frame.includes("Choose a project"));
    setup.mockInput.pressKey("n", { ctrl: true });
    await setup.waitForFrame((frame) => frame.includes("Add project · 1/2"));
    await setup.mockInput.typeText("/providers");
    await allowStateUpdate(setup);
    setup.mockInput.pressEnter();
    await allowStateUpdate(setup);
    await setup.waitForFrame((frame) => frame.includes("Checking captain providers"));
    discovery.reject(new Error("provider discovery broke"));
    await allowStateUpdate(setup);
    await setup.waitForFrame(
      (frame) => frame.includes("provider discovery broke") && frame.includes("retry")
    );
    const lines = setup.captureCharFrame().split("\n");
    const row = lines.findIndex((line) => line.includes("provider discovery broke"));
    const column = lines[row]?.indexOf("provider discovery broke") ?? -1;
    await setup.mockMouse.click(column + 2, row);
    await setup.waitForFrame((frame) => frame.includes("Codex: ready"));

    expect(callCount(discoverWorkspaceProviders)).toBe(2);
  });

  test("retains captain values when changing and revalidating the folder", async () => {
    let preparation = 0;
    const prepareWorkspace = mock((path: unknown) =>
      Promise.resolve({
        workspacePath: String(path),
        suggestedName: preparation++ === 0 ? "first-name" : "replacement-default"
      })
    );
    const runtime = fakeRuntime({
      commandOverrides: {
        prepareWorkspace,
        discoverWorkspaceProviders: mock(() => Promise.resolve(availableProviders))
      }
    });
    const setup = await testRender(
      <RuntimeContext value={runtime}>
        <App />
      </RuntimeContext>,
      { height: 18, width: 90 }
    );
    allowOpenTuiAsyncUpdates();
    renderers.push(setup.renderer);
    await setup.waitForFrame((frame) => frame.includes("Choose a project"));
    setup.mockInput.pressKey("n", { ctrl: true });
    await setup.waitForFrame((frame) => frame.includes("Add project · 1/2"));
    await setup.mockInput.typeText("/retained");
    await allowStateUpdate(setup);
    setup.mockInput.pressEnter();
    await allowStateUpdate(setup);
    await setup.waitForFrame((frame) => frame.includes("Codex: ready"));
    await setup.mockInput.typeText("-custom");
    await setup.waitForFrame((frame) => frame.includes("first-name-custom"));

    const captainFrame = setup.captureCharFrame().split("\n");
    const folderRow = captainFrame.findIndex((line) => line.includes("Folder /retained"));
    const changeColumn = captainFrame[folderRow]?.indexOf("change") ?? -1;
    await setup.mockMouse.click(changeColumn + 2, folderRow);
    await setup.waitForFrame((frame) => frame.includes("Add project · 1/2"));
    setup.mockInput.pressEnter();
    await allowStateUpdate(setup);
    await setup.waitForFrame(
      (frame) => frame.includes("Codex: ready") && frame.includes("first-name-custom")
    );

    expect(setup.captureCharFrame()).not.toContain("replacement-default");
  });

  test("retains failed creation values, deduplicates retry, and honestly locks Starting", async () => {
    const retry = deferredRequest<Conversation>();
    let attempt = 0;
    const createConversation = mock(() =>
      attempt++ === 0 ? Promise.reject(new Error("captain launch failed")) : retry.promise
    );
    const runtime = fakeRuntime({
      commandOverrides: {
        discoverWorkspaceProviders: mock(() => Promise.resolve(availableProviders)),
        createConversation
      }
    });
    const setup = await testRender(
      <RuntimeContext value={runtime}>
        <App />
      </RuntimeContext>,
      { height: 18, width: 90 }
    );
    allowOpenTuiAsyncUpdates();
    renderers.push(setup.renderer);
    await setup.waitForFrame((frame) => frame.includes("Choose a project"));
    setup.mockInput.pressKey("n", { ctrl: true });
    await setup.waitForFrame((frame) => frame.includes("Add project · 1/2"));
    await setup.mockInput.typeText("/recoverable");
    await allowStateUpdate(setup);
    setup.mockInput.pressEnter();
    await allowStateUpdate(setup);
    await setup.waitForFrame((frame) => frame.includes("Codex: ready"));

    setup.mockInput.pressEnter({ ctrl: true });
    await allowStateUpdate(setup);
    await setup.waitForFrame((frame) => frame.includes("captain launch failed"));
    expect(setup.captureCharFrame()).toContain("/recoverable");
    expect(setup.captureCharFrame()).toContain("recoverable");

    setup.mockInput.pressEnter({ ctrl: true });
    setup.mockInput.pressEnter({ ctrl: true });
    await allowStateUpdate(setup);
    expect(callCount(createConversation)).toBe(2);
    expect(setup.captureCharFrame()).toContain("Starting · fields are locked");
    expect(setup.captureCharFrame()).not.toContain("Esc close");
    retry.resolve(conversation);
    await allowStateUpdate(setup);
    await setup.waitForFrame(
      (frame) => frame.includes(conversation.title) && !frame.includes("Add project")
    );
  });

  test("asks for space instead of crushing the three-pane layout", async () => {
    const setup = await testRender(
      <RuntimeContext value={fakeRuntime()}>
        <App />
      </RuntimeContext>,
      { height: 14, width: 70 }
    );
    allowOpenTuiAsyncUpdates();
    renderers.push(setup.renderer);
    await setup.waitForFrame((frame) => frame.includes("Terminal too small"));

    const frame = setup.captureCharFrame();
    expect(frame).toContain("Resize to at least 90×18");
    expect(frame).not.toContain("Projects");
  });

  test("pins the captain, renders workers, and owns exactly one PTY attachment", async () => {
    const terminal = fakeTerminal();
    const runtime = fakeRuntime({
      conversations: [conversation],
      sessions,
      terminal
    });
    const setup = await testRender(
      <RuntimeContext value={runtime}>
        <App />
      </RuntimeContext>,
      { height: 36, width: 130 }
    );
    allowOpenTuiAsyncUpdates();
    renderers.push(setup.renderer);
    await setup.waitForFrame((frame) => frame.includes("Ship the terminal port"));
    setup.mockInput.pressKey("1", { meta: true });
    await allowStateUpdate(setup);
    setup.mockInput.pressArrow("down");
    await allowStateUpdate(setup);
    await setup.waitForFrame((frame) => frame.includes("Captain") && frame.includes("Test Writer"));
    await setup.waitFor(() => callCount(runtime.openTerminal) === 1);
    await allowStateUpdate(setup);
    await setup.waitForFrame((frame) => frame.includes("history"));

    const frame = setup.captureCharFrame();
    expect(frame).toContain("Captain");
    expect(frame).toContain("Workers · 1");
    expect(frame).toContain("history");

    setup.mockInput.pressEnter();
    await allowStateUpdate(setup);
    await setup.mockInput.typeText("hello");
    await setup.flush();
    expect(callCount(terminal.write)).toBeGreaterThan(0);
    expect(callCount(runtime.openTerminal)).toBe(1);

    const writesBeforeControlKey = callCount(terminal.write);
    setup.mockInput.pressKey("n", { ctrl: true });
    await allowStateUpdate(setup);
    expect(callCount(terminal.write)).toBeGreaterThan(writesBeforeControlKey);
    expect(setup.captureCharFrame()).not.toContain("Add project");

    const writesBeforeFlowControl = callCount(terminal.write);
    setup.mockInput.pressKey("q", { ctrl: true });
    await allowStateUpdate(setup);
    expect(callCount(terminal.write)).toBeGreaterThan(writesBeforeFlowControl);
    expect(setup.captureCharFrame()).toContain("Ship the terminal port");
  });

  test("keeps the old frame visible until the selected agent is ready, then swaps atomically", async () => {
    const captainTerminal = fakeTerminal();
    const workerTerminal = fakeTerminal();
    const workerAttachment = deferredValue({
      history: "worker-only-history\n",
      terminal: workerTerminal,
      releaseBufferedOutput: mock(() => undefined)
    });
    const base = fakeRuntime({ conversations: [conversation], sessions });
    const runtime: LocalAgentLabRuntime = {
      ...base,
      openTerminal: mock((input: OpenSessionTerminalInput) =>
        input.sessionName === sessions[0]?.name
          ? Promise.resolve({
              history: "captain-only-history\n",
              terminal: captainTerminal,
              releaseBufferedOutput: mock(() => undefined)
            })
          : workerAttachment.promise
      )
    };
    let selectAgent: (index: number) => void = () => {
      throw new Error("Terminal switch harness did not render.");
    };
    const setup = await testRender(
      <RuntimeContext value={runtime}>
        <TerminalSwitchHarness
          onReady={(select) => {
            selectAgent = select;
          }}
        />
      </RuntimeContext>,
      { height: 30, width: 100 }
    );
    allowOpenTuiAsyncUpdates();
    renderers.push(setup.renderer);
    await setup.waitForFrame((frame) => frame.includes("captain-only-history"));

    selectAgent(1);
    await allowStateUpdate(setup);
    await setup.waitFor(() => callCount(runtime.openTerminal) === 2);

    const pendingFrame = setup.captureCharFrame();
    expect(pendingFrame).toContain("captain-only-history");
    expect(pendingFrame).toContain("switching");
    expect(pendingFrame).not.toContain("worker-only-history");

    workerAttachment.resolve();
    await allowStateUpdate(setup);
    await allowStateUpdate(setup);
    await setup.waitForFrame((frame) => frame.includes("worker-only-history"));

    expect(setup.captureCharFrame()).not.toContain("captain-only-history");
    expect(callCount(captainTerminal.close)).toBe(1);
    expect(callCount(workerTerminal.close)).toBe(0);
  });

  test("uses the full center pane instead of retaining the terminal's 80-column default", async () => {
    const runtime = fakeRuntime({ conversations: [conversation], sessions });
    const setup = await testRender(
      <RuntimeContext value={runtime}>
        <App />
      </RuntimeContext>,
      { height: 42, width: 220 }
    );
    allowOpenTuiAsyncUpdates();
    renderers.push(setup.renderer);
    await setup.waitForFrame((frame) => frame.includes("Ship the terminal port"));
    setup.mockInput.pressKey("1", { meta: true });
    await allowStateUpdate(setup);
    setup.mockInput.pressArrow("down");
    await allowStateUpdate(setup);
    await setup.waitFor(() => callCount(runtime.openTerminal) === 1);

    const request = calls(runtime.openTerminal)[0]?.[0] as OpenSessionTerminalInput | undefined;
    expect(request?.columns).toBeGreaterThan(140);
    expect(request?.rows).toBeGreaterThan(30);
  });

  test("does not reattach when polling only refreshes session metadata", async () => {
    const runtime = fakeRuntime({ conversations: [conversation], sessions });
    let refreshMetadata: () => void = () => {
      throw new Error("Metadata harness did not render.");
    };
    const setup = await testRender(
      <RuntimeContext value={runtime}>
        <TerminalMetadataHarness
          onReady={(refresh) => {
            refreshMetadata = refresh;
          }}
        />
      </RuntimeContext>,
      { height: 30, width: 120 }
    );
    allowOpenTuiAsyncUpdates();
    renderers.push(setup.renderer);
    await setup.waitFor(() => callCount(runtime.openTerminal) === 1);

    refreshMetadata();
    await allowStateUpdate(setup);

    expect(callCount(runtime.openTerminal)).toBe(1);
  });

  test("handles pane shortcuts before forwarding input to the focused agent", async () => {
    const observed: { readonly meta: boolean; readonly name: string }[] = [];
    const terminal = fakeTerminal();
    const runtime = fakeRuntime({ conversations: [conversation], sessions, terminal });
    const setup = await testRender(
      <RuntimeContext value={runtime}>
        <KeyboardCapture
          onKey={(key) => {
            observed.push(key);
          }}
        >
          <App />
        </KeyboardCapture>
      </RuntimeContext>,
      { height: 36, width: 130 }
    );
    allowOpenTuiAsyncUpdates();
    renderers.push(setup.renderer);
    await setup.waitForFrame((frame) => frame.includes("Ship the terminal port"));
    setup.mockInput.pressKey("1", { meta: true });
    await allowStateUpdate(setup);
    setup.mockInput.pressArrow("down");
    await allowStateUpdate(setup);
    await setup.waitFor(() => callCount(runtime.openTerminal) === 1);

    setup.mockInput.pressKey("3", { meta: true });
    await allowStateUpdate(setup);
    expect(observed).toContainEqual({ meta: true, name: "3" });
    expect(callCount(terminal.write)).toBe(0);
    setup.mockInput.pressArrow("down");
    await allowStateUpdate(setup);

    expect(callCount(runtime.openTerminal)).toBe(2);
    setup.mockInput.pressKey("w", { meta: true });
    await allowStateUpdate(setup);
    await setup.waitForFrame((frame) => frame.includes("New worker"));
  });

  test("deletes a worker through the conversation identity carried by the session", async () => {
    const runtime = fakeRuntime({ conversations: [conversation], sessions });
    const setup = await testRender(
      <RuntimeContext value={runtime}>
        <App />
      </RuntimeContext>,
      { height: 36, width: 130 }
    );
    allowOpenTuiAsyncUpdates();
    renderers.push(setup.renderer);
    await setup.waitForFrame((frame) => frame.includes("Ship the terminal port"));
    setup.mockInput.pressKey("1", { meta: true });
    await allowStateUpdate(setup);
    setup.mockInput.pressArrow("down");
    await allowStateUpdate(setup);
    await setup.waitFor(() => callCount(runtime.openTerminal) === 1);

    setup.mockInput.pressKey("3", { meta: true });
    await allowStateUpdate(setup);
    setup.mockInput.pressArrow("down");
    await allowStateUpdate(setup);
    setup.mockInput.pressKey("DELETE");
    await allowStateUpdate(setup);
    await setup.waitForFrame((frame) => frame.includes("Delete Test Writer?"));
    setup.mockInput.pressEnter();
    setup.mockInput.pressEnter();
    await allowStateUpdate(setup);

    expect(calls(runtime.commands.deleteWorker)).toContainEqual([
      sessions[1]?.conversationId,
      sessions[1]?.name
    ]);
    expect(callCount(runtime.commands.deleteWorker)).toBe(1);
  });

  test("seeds terminal history before releasing output captured during synchronous attach", async () => {
    const base = fakeRuntime({ conversations: [conversation], sessions });
    const terminal = fakeTerminal();
    const runtime: LocalAgentLabRuntime = {
      ...base,
      openTerminal: mock((input: OpenSessionTerminalInput) => {
        const outputCapturedDuringAttach = ["newer-live-output\r\n"];
        return Promise.resolve({
          history: "older-history-output\n",
          terminal,
          releaseBufferedOutput() {
            for (const data of outputCapturedDuringAttach) input.callbacks.onData(data);
          }
        });
      })
    };
    const setup = await testRender(
      <RuntimeContext value={runtime}>
        <App />
      </RuntimeContext>,
      { height: 36, width: 130 }
    );
    allowOpenTuiAsyncUpdates();
    renderers.push(setup.renderer);
    await setup.waitForFrame((frame) => frame.includes("Ship the terminal port"));
    setup.mockInput.pressKey("1", { meta: true });
    await allowStateUpdate(setup);
    setup.mockInput.pressArrow("down");
    await allowStateUpdate(setup);
    await setup.waitForFrame(
      (frame) => frame.includes("older-history-output") && frame.includes("newer-live-output")
    );

    const frame = setup.captureCharFrame();
    expect(frame.indexOf("older-history-output")).toBeLessThan(frame.indexOf("newer-live-output"));
  });

  test("switches a clicked sidebar attachment once while history and live output are saturated", async () => {
    const captainTerminal = fakeTerminal();
    const workerTerminal = fakeTerminal();
    let captainInput: OpenSessionTerminalInput | null = null;
    let workerInput: OpenSessionTerminalInput | null = null;
    const base = fakeRuntime({ conversations: [conversation], sessions });
    const historyLine = "seed 👩🏽‍💻 界 é 0123456789abcdefghijklmnopqrstuvwxyz\n";
    const runtime: LocalAgentLabRuntime = {
      ...base,
      openTerminal: mock((input: OpenSessionTerminalInput) => {
        if (input.sessionName === sessions[0]?.name) {
          captainInput = input;
          return Promise.resolve({
            history: historyLine.repeat(4_096),
            terminal: captainTerminal,
            releaseBufferedOutput: mock(() => undefined)
          });
        }
        workerInput = input;
        return Promise.resolve({
          history: "worker-ready\n",
          terminal: workerTerminal,
          releaseBufferedOutput: mock(() => undefined)
        });
      })
    };
    const setup = await testRender(
      <RuntimeContext value={runtime}>
        <App />
      </RuntimeContext>,
      { height: 36, width: 130 }
    );
    allowOpenTuiAsyncUpdates();
    renderers.push(setup.renderer);
    await setup.waitForFrame((frame) => frame.includes("Ship the terminal port"));
    setup.mockInput.pressKey("1", { meta: true });
    await allowStateUpdate(setup);
    setup.mockInput.pressArrow("down");
    await waitForApp(setup, () => callCount(runtime.openTerminal) === 1, 500);
    await allowStateUpdate(setup);

    setup.resize(140, 40);
    await setup.flush();
    const liveChunk = "\x1b[36mlive 👩🏽‍💻 界 é\x1b[0m\r\n".repeat(256);
    const selectedCaptainInput = captainInput as OpenSessionTerminalInput | null;
    if (selectedCaptainInput === null)
      throw new Error("Captain attachment input was not captured.");
    for (let index = 0; index < 256; index += 1) {
      selectedCaptainInput.callbacks.onData(liveChunk);
    }

    const frame = setup.captureCharFrame();
    const lines = frame.split("\n");
    const workerRow = lines.findIndex((line, index) => index > 2 && line.includes("Test Writer"));
    const workerColumn = lines[workerRow]?.lastIndexOf("Test Writer") ?? -1;
    expect(workerRow).toBeGreaterThan(2);
    expect(workerColumn).toBeGreaterThan(0);
    const startedAt = performance.now();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await setup.mockMouse.click(workerColumn + 2, workerRow);
    await waitForApp(setup, () => callCount(runtime.openTerminal) === 2, 500);

    expect(performance.now() - startedAt).toBeLessThan(500);
    expect(callCount(runtime.openTerminal)).toBe(2);
    expect(callCount(captainTerminal.close)).toBe(1);
    expect(callCount(captainTerminal.resize)).toBeGreaterThan(0);
    const staleCaptainInput = captainInput as OpenSessionTerminalInput | null;
    staleCaptainInput?.callbacks.onData("stale-captain-row\r\n");
    staleCaptainInput?.callbacks.onExit(9);
    await waitForApp(setup, () => setup.captureCharFrame().includes("worker-ready"), 500);
    expect(setup.captureCharFrame()).not.toContain("stale-captain-row");

    const selectedWorkerInput = workerInput as OpenSessionTerminalInput | null;
    if (selectedWorkerInput === null) throw new Error("Worker attachment input was not captured.");
    selectedWorkerInput.callbacks.onExit(7);
    selectedWorkerInput.callbacks.onExit(7);
    await waitForApp(
      setup,
      () => setup.captureCharFrame().includes("session client exited 7"),
      500
    );
    expect(setup.captureCharFrame().split("session client exited 7")).toHaveLength(2);
  });

  test("stops an overrun attachment visibly without dropping an arbitrary terminal tail", async () => {
    const terminal = fakeTerminal();
    let attachmentInput: OpenSessionTerminalInput | null = null;
    const base = fakeRuntime({ conversations: [conversation], sessions, terminal });
    const runtime: LocalAgentLabRuntime = {
      ...base,
      openTerminal: mock((input: OpenSessionTerminalInput) => {
        attachmentInput = input;
        return Promise.resolve({
          history: "ready\n",
          terminal,
          releaseBufferedOutput: mock(() => undefined)
        });
      })
    };
    const setup = await testRender(
      <RuntimeContext value={runtime}>
        <App />
      </RuntimeContext>,
      { height: 36, width: 130 }
    );
    allowOpenTuiAsyncUpdates();
    renderers.push(setup.renderer);
    await setup.waitForFrame((frame) => frame.includes("Ship the terminal port"));
    setup.mockInput.pressKey("1", { meta: true });
    await allowStateUpdate(setup);
    setup.mockInput.pressArrow("down");
    await waitForApp(setup, () => setup.captureCharFrame().includes("ready"), 500);

    const selectedInput = attachmentInput as OpenSessionTerminalInput | null;
    if (selectedInput === null) throw new Error("Attachment input was not captured.");
    selectedInput.callbacks.onData("x".repeat(maximumQueuedTerminalBytes + 1));
    await waitForApp(setup, () => setup.captureCharFrame().includes("outran the renderer"), 500);

    expect(callCount(terminal.close)).toBe(1);
    expect(setup.captureCharFrame()).toContain("reconnect");
  });

  test("keeps keyboard-selected conversations and workers visible in long sidebars", async () => {
    const conversations = Array.from({ length: 24 }, (_, index) => conversationAt(index));
    const firstConversation = conversations[0];
    if (firstConversation === undefined) throw new Error("Conversation fixture is empty.");
    const workers = Array.from({ length: 20 }, (_, index) => workerAt(firstConversation, index));
    const listedSessions = [captainFor(firstConversation), ...workers];
    const runtime = fakeRuntime({ conversations, sessions: listedSessions });
    const setup = await testRender(
      <RuntimeContext value={runtime}>
        <App />
      </RuntimeContext>,
      { height: 30, width: 120 }
    );
    allowOpenTuiAsyncUpdates();
    renderers.push(setup.renderer);
    await setup.waitForFrame((frame) => frame.includes("Conversation 00"));

    setup.mockInput.pressKey("1", { meta: true });
    await allowStateUpdate(setup);
    setup.mockInput.pressArrow("down");
    await allowStateUpdate(setup);
    for (let index = 0; index < 15; index += 1) {
      setup.mockInput.pressArrow("down");
      await allowStateUpdate(setup);
    }
    await setup.waitForFrame((frame) => (frame.match(/Conversation 15/gu) ?? []).length >= 2);
    expect(setup.captureCharFrame()).not.toContain("Conversation 00");

    // Return to the first conversation, whose fixture owns the long worker list.
    for (let index = 0; index < 9; index += 1) {
      setup.mockInput.pressArrow("down");
      await allowStateUpdate(setup);
    }
    setup.mockInput.pressKey("3", { meta: true });
    await allowStateUpdate(setup);
    for (let index = 0; index < 13; index += 1) {
      setup.mockInput.pressArrow("down");
      await allowStateUpdate(setup);
    }
    await setup.waitForFrame((frame) => (frame.match(/Worker 12/gu) ?? []).length >= 2);
    expect(setup.captureCharFrame()).not.toContain("Worker 00");
  });

  test("waits for runtime draining before destroying the renderer", async () => {
    let finishClose: () => void = () => undefined;
    const closePending = new Promise<void>((resolve) => {
      finishClose = resolve;
    });
    const base = fakeRuntime({ conversations: [conversation], sessions });
    const runtime: LocalAgentLabRuntime = {
      ...base,
      close: mock(() => closePending)
    };
    const setup = await testRender(
      <RuntimeContext value={runtime}>
        <App />
      </RuntimeContext>,
      { height: 36, width: 130 }
    );
    allowOpenTuiAsyncUpdates();
    const destroyRenderer = setup.renderer.destroy.bind(setup.renderer);
    const destroy = mock(() => undefined);
    setup.renderer.destroy = destroy;
    renderers.push({ destroy: destroyRenderer });
    await setup.waitForFrame((frame) => frame.includes("Ship the terminal port"));
    setup.mockInput.pressKey("1", { meta: true });
    await allowStateUpdate(setup);
    setup.mockInput.pressArrow("down");
    await allowStateUpdate(setup);
    await setup.waitFor(() => callCount(runtime.openTerminal) === 1);

    setup.mockInput.pressKey("q", { meta: true });
    await allowStateUpdate(setup);

    expect(callCount(runtime.close)).toBe(1);
    expect(callCount(destroy)).toBe(0);
    expect(setup.captureCharFrame()).toContain("finishing current operation");

    finishClose();
    await setup.waitFor(() => callCount(destroy) === 1);
  });

  test("bounds PTY dimensions at the presentation edge on very wide terminals", () => {
    expect(boundTerminalDimensions(1_300, 2_000)).toEqual({
      columns: maximumTerminalDimension,
      rows: maximumTerminalDimension
    });
  });
});

const conversation: Conversation = {
  id: "11111111-1111-4111-8111-111111111111",
  title: "Ship the terminal port",
  workspacePath: "/work/project",
  provider: "codex",
  model: null,
  reasoning: null,
  captainSessionName: "agentlab__11111111-1111-4111-8111-111111111111__captain__codex",
  createdAt: "2026-08-25T12:00:00.000Z",
  updatedAt: "2026-08-25T12:00:00.000Z"
};

const sessions: readonly AgentSession[] = [
  {
    name: conversation.captainSessionName,
    conversationId: conversation.id,
    role: "captain",
    provider: "codex",
    label: "Captain",
    status: "running",
    attached: false,
    startedAt: "2026-08-25T12:00:00.000Z"
  },
  {
    name: "agentlab__11111111-1111-4111-8111-111111111111__worker__claude__test-writer",
    conversationId: conversation.id,
    role: "worker",
    provider: "claude",
    label: "Test Writer",
    status: "running",
    attached: false,
    startedAt: "2026-08-25T12:01:00.000Z"
  }
];

const providers: readonly ProviderCapability[] = [];
const availableProviders: readonly ProviderCapability[] = [
  {
    id: "codex",
    label: "Codex",
    available: true,
    version: "1.0.0",
    reason: null,
    source: "live",
    discoveredAt: "2026-08-25T12:00:00.000Z",
    defaultModel: "gpt-test",
    models: [
      {
        id: "gpt-test",
        label: "GPT Test",
        description: null,
        defaultReasoning: "high",
        reasoningOptions: [{ id: "high", label: "High" }]
      }
    ],
    customModelPolicy: "allowed"
  }
];

function conversationAt(index: number): Conversation {
  const suffix = String(index).padStart(12, "0");
  const id = `00000000-0000-4000-8000-${suffix}`;
  return {
    ...conversation,
    id,
    title: `Conversation ${String(index).padStart(2, "0")}`,
    captainSessionName: `agentlab__${id}__captain__codex`
  };
}

function captainFor(owner: Conversation): AgentSession {
  return {
    ...sessionFixture(0),
    name: owner.captainSessionName,
    conversationId: owner.id
  };
}

function workerAt(owner: Conversation, index: number): AgentSession {
  const worker = String(index).padStart(2, "0");
  return {
    ...sessionFixture(1),
    name: `agentlab__${owner.id}__worker__claude__worker-${worker}`,
    conversationId: owner.id,
    label: `Worker ${worker}`
  };
}

function sessionFixture(index: number): AgentSession {
  const session = sessions[index];
  if (session === undefined) throw new Error(`Session fixture ${String(index)} is missing.`);
  return session;
}

function KeyboardCapture({
  children,
  onKey
}: {
  readonly children: ReactNode;
  readonly onKey: (key: { readonly meta: boolean; readonly name: string }) => void;
}) {
  useKeyboard(({ meta, name }) => {
    onKey({ meta, name });
  });
  return children;
}

function TerminalSwitchHarness({
  onReady
}: {
  readonly onReady: (select: (index: number) => void) => void;
}) {
  const [index, setIndex] = useState(0);
  onReady(setIndex);
  return (
    <TerminalPanel
      conversationId={conversation.id}
      session={sessions[index] ?? null}
      active
      onActivate={() => undefined}
    />
  );
}

function TerminalMetadataHarness({ onReady }: { readonly onReady: (refresh: () => void) => void }) {
  const [revision, setRevision] = useState(0);
  onReady(() => {
    setRevision((current) => current + 1);
  });
  const captain = sessions[0];
  if (captain === undefined) throw new Error("Captain fixture is missing.");
  return (
    <TerminalPanel
      conversationId={conversation.id}
      session={{ ...captain, attached: revision % 2 === 1 }}
      active
      onActivate={() => undefined}
    />
  );
}

function fakeRuntime(
  options: {
    readonly conversations?: readonly Conversation[];
    readonly sessions?: readonly AgentSession[];
    readonly terminal?: SessionTerminal;
    readonly attachments?: ReadonlyMap<
      string,
      { readonly history: string; readonly terminal: SessionTerminal }
    >;
    readonly commandOverrides?: Partial<AgentLabCommandPort>;
  } = {}
): LocalAgentLabRuntime {
  const conversations = options.conversations ?? [];
  const listedSessions = options.sessions ?? [];
  const terminal = options.terminal ?? fakeTerminal();
  const commands: AgentLabCommandPort = {
    listConversations: mock(() => deferred(conversations)),
    inspectWorkspace: mock((workspacePath) =>
      deferred({
        workspacePath: String(workspacePath),
        suggestedName: String(workspacePath).split("/").filter(Boolean).at(-1) ?? "project",
        providers
      })
    ),
    prepareWorkspace: mock((workspacePath) =>
      deferred({
        workspacePath: String(workspacePath),
        suggestedName: String(workspacePath).split("/").filter(Boolean).at(-1) ?? "project"
      })
    ),
    discoverWorkspaceProviders: mock(() => deferred(providers)),
    completeFolders: mock(() => deferred([])),
    listProviders: mock(() => deferred(providers)),
    createConversation: mock(() => deferred(conversation)),
    deleteConversation: mock(() => deferred(undefined)),
    listSessions: mock(() => deferred(listedSessions)),
    createWorker: mock(() => deferred(sessions[1]?.name ?? "")),
    deleteWorker: mock(() => deferred(undefined)),
    requireAttachableSession: mock((conversationId, sessionName) =>
      deferred({
        conversationId: String(conversationId),
        sessionName: String(sessionName),
        workspacePath: "/work/project"
      })
    ),
    ...options.commandOverrides
  };
  return {
    commands,
    openTerminal: mock((input: OpenSessionTerminalInput) =>
      deferred({
        ...(options.attachments?.get(String(input.sessionName)) ?? {
          history: "history\n",
          terminal
        }),
        releaseBufferedOutput: mock(() => undefined)
      })
    ),
    close: mock(() => Promise.resolve())
  };
}

function fakeTerminal(): SessionTerminal {
  return {
    write: mock(() => undefined),
    resize: mock(() => undefined),
    close: mock(() => undefined)
  };
}

function deferred<T>(value: T): Promise<T> {
  return new Promise((resolve) => {
    setTimeout(() => {
      resolve(value);
    }, 0);
  });
}

interface DeferredValue<T> {
  readonly promise: Promise<T>;
  resolve(): void;
}

interface DeferredRequest<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: Error): void;
}

function deferredRequest<T>(): DeferredRequest<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

async function waitMilliseconds(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function deferredValue<T>(value: T): DeferredValue<T> {
  let resolvePromise = (): void => undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = () => {
      resolve(value);
    };
  });
  return { promise, resolve: resolvePromise };
}

async function allowStateUpdate(setup: { flush(): Promise<void> }): Promise<void> {
  allowOpenTuiAsyncUpdates();
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
  await setup.flush();
}

async function waitForApp(
  setup: { flush(): Promise<void> },
  predicate: () => boolean,
  deadlineMilliseconds: number
): Promise<void> {
  const deadline = performance.now() + deadlineMilliseconds;
  while (!predicate()) {
    if (performance.now() >= deadline)
      throw new Error("Timed out waiting for responsive app state.");
    await allowStateUpdate(setup);
  }
}

function callCount(value: unknown): number {
  return calls(value).length;
}

function calls(value: unknown): readonly (readonly unknown[])[] {
  return (value as { readonly mock: { readonly calls: readonly (readonly unknown[])[] } }).mock
    .calls;
}
