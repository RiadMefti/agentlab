/** @jsxImportSource @opentui/react */

import { createRef } from "react";

import { testRender } from "@opentui/react/test-utils";
import { afterEach, describe, expect, test } from "bun:test";

import type { EmbeddedTerminalRenderable } from "@opentui/core";
import { sessionHistoryLimit } from "@agentlab/contracts";

import "../../apps/tui/src/terminal/embedded-terminal.js";
import { paintTerminalDefaults } from "../../apps/tui/src/terminal/terminal-appearance.js";
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
      <agent-terminal
        ref={terminal}
        renderAfter={paintTerminalDefaults}
        style={{ width: 20, height: 3 }}
      />,
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

  test("parses sustained ANSI output within the interactive throughput budget", async () => {
    const terminal = createRef<EmbeddedTerminalRenderable>();
    const setup = await testRender(
      <agent-terminal
        ref={terminal}
        maxScrollback={sessionHistoryLimit}
        renderAfter={paintTerminalDefaults}
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
