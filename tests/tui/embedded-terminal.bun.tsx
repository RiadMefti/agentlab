/** @jsxImportSource @opentui/react */

import { createRef } from "react";

import { parseKeypress, type KeyEvent } from "@opentui/core";
import { testRender } from "@opentui/react/test-utils";
import { afterEach, describe, expect, test } from "bun:test";

import { terminalScrollbackBytes } from "@agentlab/contracts";

import "../../apps/tui/src/terminal/embedded-terminal.js";
import {
  EmbeddedTerminalRenderable,
  terminalChildMouseInputEnabled
} from "../../apps/tui/src/terminal/embedded-terminal.js";
import { palette } from "../../apps/tui/src/theme.js";
import { allowOpenTuiAsyncUpdates } from "./test-renderer.js";

const renderers: { destroy(): void }[] = [];

afterEach(() => {
  for (const renderer of renderers.splice(0)) {
    renderer.destroy();
  }
});

describe("embedded agent terminal", () => {
  test("renders ANSI output and preserves cursor state", async () => {
    const terminal = createRef<EmbeddedTerminalRenderable>();
    const setup = await testRender(
      <agent-terminal ref={terminal} style={{ width: 16, height: 4 }} />,
      { height: 4, width: 16 }
    );
    allowOpenTuiAsyncUpdates();
    renderers.push(setup.renderer);

    terminal.current?.write("plain\r\n\x1b[31mred\x1b[0m");
    await setup.flush();

    expect(terminal.current?.screen()).toMatchObject({
      columns: 16,
      cursor: { visible: true, x: 3, y: 1 },
      rows: 4
    });
    expect(setup.captureCharFrame()).toContain("plain");
    expect(setup.captureCharFrame()).toContain("red");
  });

  test("encodes focused keyboard input for the attached PTY", async () => {
    const terminal = createRef<EmbeddedTerminalRenderable>();
    const received: string[] = [];
    const setup = await testRender(
      <agent-terminal
        ref={terminal}
        onData={(data: Uint8Array, source: "input" | "response") => {
          if (source === "input") {
            received.push(new TextDecoder().decode(data));
          }
        }}
        style={{ width: 20, height: 5 }}
      />,
      { height: 5, width: 20 }
    );
    allowOpenTuiAsyncUpdates();
    renderers.push(setup.renderer);

    terminal.current?.focus();
    await setup.mockInput.typeText("hello");
    setup.mockInput.pressEnter();
    await setup.flush();

    expect(received.join("")).toBe("hello\r");
  });

  test("normalizes legacy navigation and function key codes", async () => {
    const terminal = createRef<EmbeddedTerminalRenderable>();
    const setup = await testRender(
      <agent-terminal ref={terminal} style={{ width: 20, height: 5 }} />,
      {
        height: 5,
        width: 20
      }
    );
    allowOpenTuiAsyncUpdates();
    renderers.push(setup.renderer);

    const cases = [
      ["\x1b[A", "\x1b[A"],
      ["\x1b[H", "\x1b[H"],
      ["\x1b[F", "\x1b[F"],
      ["\x1b[5~", "\x1b[5~"],
      ["\x1b[6~", "\x1b[6~"],
      ["\x1b[3~", "\x1b[3~"],
      ["\x1bOP", "\x1bOP"],
      ["\x1b[15~", "\x1b[15~"],
      ["\x1b[1;2A", "\x1b[1;2A"],
      ["\x1b[1;3D", "\x1b[1;3D"],
      ["\x1b[1;6H", "\x1b[1;6H"],
      ["\x1b[3;5~", "\x1b[3;5~"],
      ["\x1b[15;3~", "\x1b[15;3~"],
      ["\x1b[1;5P", "\x1b[1;5P"]
    ] as const;
    for (const [input, output] of cases) {
      expect(decode(terminal.current?.encodeKey(parsedKey(input)))).toBe(output);
    }

    terminal.current?.write("\x1b[?1h");
    expect(decode(terminal.current?.encodeKey(parsedKey("\x1b[A")))).toBe("\x1bOA");
  });

  test("encodes raw ESC-prefixed Alt as terminal Alt", async () => {
    const terminal = createRef<EmbeddedTerminalRenderable>();
    const setup = await testRender(
      <agent-terminal ref={terminal} style={{ width: 20, height: 5 }} />,
      { height: 5, width: 20 }
    );
    allowOpenTuiAsyncUpdates();
    renderers.push(setup.renderer);

    const cases = [
      ["\x1bb", [27, 98]],
      ["\x1bf", [27, 102]],
      ["\x1b\x7f", [27, 127]],
      ["\x1b\r", [27, 13]],
      ["\x1b\x02", [27, 2]]
    ] as const;
    for (const [input, output] of cases) {
      expect(Array.from(terminal.current?.encodeKey(parsedKey(input)) ?? [])).toEqual([...output]);
    }

    terminal.current?.write("\x1b[>1u");
    expect(Array.from(terminal.current?.encodeKey(parsedKey("\x1b\r")) ?? [])).toEqual([
      27, 91, 49, 51, 59, 51, 117
    ]);
  });

  test("preserves Kitty semantics, Ctrl, UTF-8, Enter, and bracketed paste", async () => {
    const terminal = createRef<EmbeddedTerminalRenderable>();
    const received: string[] = [];
    const setup = await testRender(
      <agent-terminal
        ref={terminal}
        onData={(data: Uint8Array, source: "input" | "response") => {
          if (source === "input") received.push(decode(data));
        }}
        style={{ width: 20, height: 5 }}
      />,
      { height: 5, kittyKeyboard: true, width: 20 }
    );
    allowOpenTuiAsyncUpdates();
    renderers.push(setup.renderer);
    terminal.current?.focus();

    expect(decode(terminal.current?.encodeKey(parsedKey("\x1b[57352u", true)))).toBe("\x1b[A");
    expect(decode(terminal.current?.encodeKey(parsedKey("\x1b[97;5u", true)))).toBe("\x01");
    expect(decode(terminal.current?.encodeKey(parsedKey("\x01")))).toBe("\x01");
    expect(Array.from(terminal.current?.encodeKey(parsedKey("\n")) ?? [])).toEqual([10]);
    expect(Array.from(terminal.current?.encodeKey(parsedKey("\r")) ?? [])).toEqual([13]);
    expect(decode(terminal.current?.encodeKey(parsedKey("é")))).toBe("é");

    const kittyAltCases = [
      ["\x1b[98;3u", [27, 98]],
      ["\x1b[102;3u", [27, 102]],
      ["\x1b[127;3u", [27, 127]],
      ["\x1b[13;3u", [27, 13]],
      ["\x1b[98;7u", [27, 2]]
    ] as const;
    for (const [input, output] of kittyAltCases) {
      expect(Array.from(terminal.current?.encodeKey(parsedKey(input, true)) ?? [])).toEqual([
        ...output
      ]);
    }

    terminal.current?.write("\x1b[>1u");
    expect(Array.from(terminal.current?.encodeKey(parsedKey("\x1b[13;3u", true)) ?? [])).toEqual([
      27, 91, 49, 51, 59, 51, 117
    ]);
    expect(Array.from(terminal.current?.encodeKey(parsedKey("\x1b[13;9u", true)) ?? [])).toEqual([
      27, 91, 49, 51, 59, 57, 117
    ]);

    terminal.current?.write("\x1b[?2004h");
    await setup.mockInput.pasteBracketedText("one\ntwo");
    await setup.flush();
    expect(received.join("")).toContain("\x1b[200~one\ntwo\x1b[201~");
  });

  test("arbitrates local selection, clicks, child mouse reporting, and Shift drag", async () => {
    const terminal = createRef<EmbeddedTerminalRenderable>();
    const received: string[] = [];
    const setup = await testRender(
      <agent-terminal
        ref={terminal}
        onData={(data: Uint8Array, source: "input" | "response") => {
          if (source === "input") received.push(decode(data));
        }}
        style={{ width: 20, height: 5 }}
      />,
      { height: 5, width: 20 }
    );
    allowOpenTuiAsyncUpdates();
    renderers.push(setup.renderer);
    terminal.current?.write("select this text");
    await setup.flush();

    await setup.mockMouse.click(2, 0);
    await setup.flush();
    expect(terminal.current?.getSelectedText()).toBe("");

    await setup.mockMouse.drag(0, 0, 5, 0);
    await setup.flush();
    expect(terminal.current?.getSelectedText()).not.toBe("");
    expect(received.join("")).toBe("");

    terminal.current?.write("\x1b[?1002;1006h");
    received.length = 0;
    await setup.mockMouse.drag(1, 1, 4, 1);
    await setup.flush();
    expect(received.join("")).toContain("\x1b[<0;2;2M");
    expect(received.join("")).toContain("\x1b[<32;5;2M");

    received.length = 0;
    await setup.mockMouse.drag(0, 0, 6, 0, 0, { modifiers: { shift: true } });
    await setup.flush();
    expect(received.join("")).toBe("");
    expect(terminal.current?.getSelectedText()).not.toBe("");

    terminal.current?.clearLocalSelection();
    await setup.mockMouse.pressDown(0, 0, 0, { modifiers: { shift: true } });
    await setup.mockMouse.moveTo(6, 0);
    await setup.mockMouse.release(6, 0);
    await setup.flush();
    expect(received.join("")).toBe("");
    expect(terminal.current?.getSelectedText()).not.toBe("");
  });

  test("forwards the first normal child click after a Shift drag releases on a sibling", async () => {
    const terminal = createRef<EmbeddedTerminalRenderable>();
    const received: string[] = [];
    const setup = await testRender(
      <box style={{ flexDirection: "row", height: 5, width: 20 }}>
        <agent-terminal
          ref={terminal}
          onData={(data: Uint8Array, source: "input" | "response") => {
            if (source === "input") received.push(decode(data));
          }}
          style={{ height: 5, width: 10 }}
        />
        <box style={{ height: 5, width: 10 }} />
      </box>,
      { height: 5, width: 20 }
    );
    allowOpenTuiAsyncUpdates();
    renderers.push(setup.renderer);
    terminal.current?.write("\x1b[?1002;1006h");

    await setup.mockMouse.pressDown(1, 1, 0, { modifiers: { shift: true } });
    await setup.mockMouse.moveTo(15, 1);
    await setup.mockMouse.release(15, 1);
    received.length = 0;
    await setup.mockMouse.click(1, 1);
    await setup.flush();

    expect(received.join("")).toBe("\x1b[<0;2;2m");
  });

  test("keeps an unfocused terminal focused after starting a local Shift selection", async () => {
    const terminal = createRef<EmbeddedTerminalRenderable>();
    const sibling = createRef<EmbeddedTerminalRenderable>();
    const received: string[] = [];
    const setup = await testRender(
      <box
        onMouseDown={() => sibling.current?.focus()}
        style={{ flexDirection: "column", height: 5, width: 20 }}
      >
        <agent-terminal
          ref={terminal}
          onData={(data: Uint8Array, source: "input" | "response") => {
            if (source === "input") received.push(decode(data));
          }}
          style={{ height: 3, width: 20 }}
        />
        <agent-terminal ref={sibling} style={{ height: 2, width: 20 }} />
      </box>,
      { height: 5, width: 20 }
    );
    allowOpenTuiAsyncUpdates();
    renderers.push(setup.renderer);
    terminal.current?.write("select this text\x1b[?1002;1006h");
    sibling.current?.focus();
    await setup.flush();
    expect(terminal.current?.focused).toBe(false);

    await setup.mockMouse.drag(0, 0, 6, 0, 0, { modifiers: { shift: true } });
    await setup.flush();

    expect(terminal.current?.focused).toBe(true);
    expect(sibling.current?.focused).toBe(false);
    expect(terminal.current?.getSelectedText()).not.toBe("");
    expect(received.join("")).toBe("");
  });

  test("routes wheel to local scrollback unless child tracking owns it, with Shift override", async () => {
    const terminal = createRef<EmbeddedTerminalRenderable>();
    const received: string[] = [];
    const setup = await testRender(
      <agent-terminal
        ref={terminal}
        onData={(data: Uint8Array, source: "input" | "response") => {
          if (source === "input") received.push(decode(data));
        }}
        style={{ width: 20, height: 3 }}
      />,
      { height: 3, width: 20 }
    );
    allowOpenTuiAsyncUpdates();
    renderers.push(setup.renderer);
    terminal.current?.write(
      Array.from({ length: 10 }, (_, index) => `line-${String(index)}\r\n`).join("")
    );
    await setup.flush();
    const bottom = terminal.current?.screen().text;

    await setup.mockMouse.scroll(1, 1, "up");
    await setup.flush();
    expect(terminal.current?.screen().text).not.toBe(bottom);
    expect(received.join("")).toBe("");

    terminal.current?.write("\x1b[?1000;1006h");
    received.length = 0;
    await setup.mockMouse.scroll(1, 1, "down");
    await setup.flush();
    expect(received.join("")).toContain("\x1b[<65;2;2M");

    received.length = 0;
    const beforeShiftScroll = terminal.current?.screen().text;
    await setup.mockMouse.scroll(1, 1, "down", { modifiers: { shift: true } });
    await setup.flush();
    expect(received.join("")).toBe("");
    expect(terminal.current?.screen().text).not.toBe(beforeShiftScroll);
  });

  test("disables only child mouse forwarding with the production kill switch", async () => {
    expect(terminalChildMouseInputEnabled({ AGENTLAB_DISABLE_MOUSE: "1" })).toBe(false);
    expect(terminalChildMouseInputEnabled({ AGENTLAB_DISABLE_MOUSE: "0" })).toBe(true);

    const terminal = createRef<EmbeddedTerminalRenderable>();
    const received: string[] = [];
    let sidebarClicks = 0;
    const setup = await testRender(
      <box style={{ flexDirection: "row", height: 5, width: 30 }}>
        <agent-terminal
          ref={terminal}
          childMouseInput={false}
          onData={(data: Uint8Array, source: "input" | "response") => {
            if (source === "input") received.push(decode(data));
          }}
          style={{ height: 5, width: 20 }}
        />
        <box onMouseDown={() => (sidebarClicks += 1)} style={{ height: 5, width: 10 }} />
      </box>,
      { height: 5, width: 30 }
    );
    allowOpenTuiAsyncUpdates();
    renderers.push(setup.renderer);
    terminal.current?.write("select me\x1b[?1002;1006h");
    await setup.flush();

    await setup.mockMouse.drag(0, 0, 6, 0);
    await setup.flush();
    expect(received.join("")).toBe("");
    expect(terminal.current?.getSelectedText()).not.toBe("");

    await setup.mockMouse.click(25, 1);
    await setup.flush();

    expect(received.join("")).toBe("");
    expect(sidebarClicks).toBe(1);
  });

  test("shows the child cursor only while focused and clears stale selection on blur", async () => {
    const terminal = createRef<EmbeddedTerminalRenderable>();
    const cursorVisibility: boolean[] = [];
    const setup = await testRender(
      <agent-terminal ref={terminal} style={{ width: 20, height: 3 }} />,
      {
        height: 3,
        width: 20
      }
    );
    allowOpenTuiAsyncUpdates();
    renderers.push(setup.renderer);
    const setCursorPosition = setup.renderer.setCursorPosition.bind(setup.renderer);
    setup.renderer.setCursorPosition = (x, y, visible = true) => {
      cursorVisibility.push(visible);
      setCursorPosition(x, y, visible);
    };
    terminal.current?.write("selectable text");
    terminal.current?.focus();
    await setup.flush();
    expect(cursorVisibility.at(-1)).toBe(true);

    await setup.mockMouse.drag(0, 0, 5, 0);
    await setup.flush();
    expect(terminal.current?.getSelectedText()).not.toBe("");
    terminal.current?.blur();
    await setup.flush();
    expect(terminal.current?.getSelectedText()).toBe("");
    expect(cursorVisibility.at(-1)).toBe(false);
  });

  test("cannot expose a cursor while its session is disconnected", async () => {
    const terminal = createRef<EmbeddedTerminalRenderable>();
    const cursorVisibility: boolean[] = [];
    const setup = await testRender(
      <agent-terminal ref={terminal} sessionConnected={false} style={{ width: 20, height: 3 }} />,
      { height: 3, width: 20 }
    );
    allowOpenTuiAsyncUpdates();
    renderers.push(setup.renderer);
    const setCursorPosition = setup.renderer.setCursorPosition.bind(setup.renderer);
    setup.renderer.setCursorPosition = (x, y, visible = true) => {
      cursorVisibility.push(visible);
      setCursorPosition(x, y, visible);
    };

    terminal.current?.write("cursor");
    terminal.current?.focus();
    await setup.flush();
    expect(terminal.current?.focused).toBe(false);
    expect(cursorVisibility).not.toContain(true);

    if (terminal.current !== null) terminal.current.sessionConnected = true;
    terminal.current?.focus();
    await setup.flush();
    expect(terminal.current?.focused).toBe(true);
    expect(cursorVisibility.at(-1)).toBe(true);
  });

  test("resizes its terminal grid with its layout", async () => {
    const terminal = createRef<EmbeddedTerminalRenderable>();
    const sizes: [number, number][] = [];
    const setup = await testRender(
      <agent-terminal
        ref={terminal}
        onTerminalResize={(columns: number, rows: number) => sizes.push([columns, rows])}
        style={{ height: "100%", width: "100%" }}
      />,
      { height: 6, width: 24 }
    );
    allowOpenTuiAsyncUpdates();
    renderers.push(setup.renderer);
    await setup.flush();

    setup.resize(40, 10);
    await setup.flush();

    expect(terminal.current?.screen()).toMatchObject({ columns: 40, rows: 10 });
    expect(sizes).toContainEqual([40, 10]);
  });

  test("matches the workspace surface while preserving explicit ANSI backgrounds", async () => {
    const terminal = createRef<EmbeddedTerminalRenderable>();
    const setup = await testRender(
      <agent-terminal ref={terminal} style={{ width: 20, height: 3 }} />,
      { height: 3, width: 20 }
    );
    allowOpenTuiAsyncUpdates();
    renderers.push(setup.renderer);

    terminal.current?.write("surface \x1b[41mexplicit\x1b[0m");
    await setup.flush();

    const spans = setup.captureSpans().lines.flatMap(({ spans }) => spans);
    const surface = spans.find(({ text }) => text.includes("surface"));
    const explicit = spans.find(({ text }) => text.includes("explicit"));
    expect(surface?.bg.toInts()).toEqual([10, 17, 24, 255]);
    expect(surface?.fg.toInts()).toEqual([232, 240, 245, 255]);
    expect(explicit?.bg.toInts()).toEqual([204, 102, 102, 255]);
    expect(palette.terminalBackground).not.toBe("#000000");
  });

  test("does not full-invalidate or rescan appearance on unchanged renderer frames", async () => {
    const terminal = createRef<EmbeddedTerminalRenderable>();
    const setup = await testRender(
      <agent-terminal ref={terminal} style={{ width: 20, height: 3 }} />,
      { height: 3, width: 20 }
    );
    allowOpenTuiAsyncUpdates();
    renderers.push(setup.renderer);
    terminal.current?.write("idle defaults");
    await setup.flush();

    const renderedTerminal = terminal.current;
    if (renderedTerminal === null) throw new Error("Embedded terminal did not mount.");
    const internals = renderedTerminal as unknown as {
      readonly handle: unknown;
      readonly lib: { embeddedTerminalInvalidate(handle: unknown): void };
    };
    const originalInvalidate = internals.lib.embeddedTerminalInvalidate;
    let invalidations = 0;
    internals.lib.embeddedTerminalInvalidate = (handle) => {
      invalidations += 1;
      originalInvalidate(handle);
    };
    const appearanceApplications = renderedTerminal.appearanceApplicationCount;
    try {
      for (let frame = 0; frame < 4; frame += 1) {
        setup.renderer.requestRender();
        await setup.flush();
      }
    } finally {
      internals.lib.embeddedTerminalInvalidate = originalInvalidate;
    }

    expect(renderedTerminal.renderBefore).toBeUndefined();
    expect(renderedTerminal.renderAfter).toBeUndefined();
    expect(invalidations).toBe(0);
    expect(renderedTerminal.appearanceApplicationCount).toBe(appearanceApplications);
    const defaultSpan = setup
      .captureSpans()
      .lines.flatMap(({ spans }) => spans)
      .find(({ text }) => text.includes("idle defaults"));
    expect(defaultSpan?.fg.toInts()).toEqual([232, 240, 245, 255]);
    expect(defaultSpan?.bg.toInts()).toEqual([10, 17, 24, 255]);
  });

  test("reapplies themed defaults after an explicit post-history full invalidation", async () => {
    const terminal = createRef<EmbeddedTerminalRenderable>();
    const setup = await testRender(
      <agent-terminal ref={terminal} style={{ width: 24, height: 3 }} />,
      { height: 3, width: 24 }
    );
    allowOpenTuiAsyncUpdates();
    renderers.push(setup.renderer);
    terminal.current?.write("history \x1b[41mexplicit\x1b[0m");
    await setup.flush();
    const applicationsBeforeInvalidation = terminal.current?.appearanceApplicationCount ?? 0;

    terminal.current?.invalidate();
    await setup.flush();

    expect(terminal.current?.appearanceApplicationCount).toBe(applicationsBeforeInvalidation + 1);
    const spans = setup.captureSpans().lines.flatMap(({ spans }) => spans);
    const themed = spans.find(({ text }) => text.includes("history"));
    const explicit = spans.find(({ text }) => text.includes("explicit"));
    expect(themed?.fg.toInts()).toEqual([232, 240, 245, 255]);
    expect(themed?.bg.toInts()).toEqual([10, 17, 24, 255]);
    expect(explicit?.bg.toInts()).toEqual([204, 102, 102, 255]);
  });

  test("preserves wide Unicode, truecolor, erase, and alternate-screen state", async () => {
    const terminal = createRef<EmbeddedTerminalRenderable>();
    const setup = await testRender(
      <agent-terminal ref={terminal} style={{ width: 20, height: 4 }} />,
      { height: 4, width: 20 }
    );
    allowOpenTuiAsyncUpdates();
    renderers.push(setup.renderer);

    terminal.current?.write("界🙂\x1b[38;2;12;34;56mcolor\x1b[0m");
    await setup.flush();
    expect(terminal.current?.screen().cursor.x).toBe(9);
    expect(
      setup
        .captureSpans()
        .lines.flatMap(({ spans }) => spans)
        .find(({ text }) => text.includes("color"))
        ?.fg.toInts()
    ).toEqual([12, 34, 56, 255]);

    terminal.current?.write("\r\x1b[2Kmain\x1b[?1049halt\x1b[2J\x1b[Hscreen");
    await setup.flush();
    expect(terminal.current?.screen().text).toContain("screen");
    expect(terminal.current?.screen().text).not.toContain("main");
    terminal.current?.write("\x1b[?1049l");
    await setup.flush();
    expect(terminal.current?.screen().text).toContain("main");
    expect(terminal.current?.screen().text).not.toContain("screen");
  });

  test("reflows logical lines across resize", async () => {
    const terminal = createRef<EmbeddedTerminalRenderable>();
    const setup = await testRender(
      <agent-terminal ref={terminal} style={{ width: 16, height: 4 }} />,
      {
        height: 4,
        width: 16
      }
    );
    allowOpenTuiAsyncUpdates();
    renderers.push(setup.renderer);
    terminal.current?.write("0123456789abcdefghij");
    await setup.flush();

    setup.resize(10, 4);
    await setup.flush();
    expect(terminal.current?.screen().lines.join("")).toContain("0123456789abcdefghij");
  });

  test("parses sustained ANSI output within the interactive throughput budget", async () => {
    const terminal = createRef<EmbeddedTerminalRenderable>();
    const setup = await testRender(
      <agent-terminal
        ref={terminal}
        maxScrollback={terminalScrollbackBytes}
        style={{ height: 40, width: 120 }}
      />,
      { height: 40, width: 120 }
    );
    allowOpenTuiAsyncUpdates();
    renderers.push(setup.renderer);

    const line = "\x1b[36mworker\x1b[0m output · 0123456789abcdefghijklmnopqrstuvwxyz\r\n";
    const chunk = line.repeat(256);
    const targetBytes = 5 * 1024 * 1024;
    const chunkBytes = Buffer.byteLength(chunk);
    const startedAt = performance.now();
    let writtenBytes = 0;
    while (writtenBytes < targetBytes) {
      terminal.current?.write(chunk);
      writtenBytes += chunkBytes;
    }
    await setup.flush();
    const elapsedMilliseconds = performance.now() - startedAt;

    expect(elapsedMilliseconds).toBeLessThan(2_500);
    expect((writtenBytes / Math.max(elapsedMilliseconds, 1)) * 1_000).toBeGreaterThan(
      2 * 1024 * 1024
    );
    expect(terminal.current?.screen().lines.some((value) => value.includes("worker output"))).toBe(
      true
    );
  });
});

function parsedKey(input: string, kitty = false): KeyEvent {
  const key = parseKeypress(input, { useKittyKeyboard: kitty });
  if (key === null) throw new Error(`Could not parse test key ${JSON.stringify(input)}.`);
  return key as KeyEvent;
}

function decode(data: Uint8Array | undefined): string {
  return data === undefined ? "" : new TextDecoder().decode(data);
}
