// @vitest-environment node

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { terminalThemes, uiPalettes } from "../../apps/web/src/theme/theme-palette.js";

const ansiColors = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "brightBlack",
  "brightRed",
  "brightGreen",
  "brightYellow",
  "brightBlue",
  "brightMagenta",
  "brightCyan",
  "brightWhite"
] as const;

const uiBackgrounds = ["canvas", "surface", "surfaceHover"] as const;
const controlIndicators = ["borderControl", "borderControlHover", "focusRing"] as const;

describe("theme palettes", () => {
  it("keeps normal and secondary UI text above WCAG AA contrast", () => {
    for (const palette of Object.values(uiPalettes)) {
      expect(contrast(palette.text, palette.canvas)).toBeGreaterThanOrEqual(7);
      expect(contrast(palette.focusRing, palette.canvas)).toBeGreaterThanOrEqual(3);
    }
  });

  // Muted text labels sit on the canvas, on dialog surfaces, and on a hovered tab;
  // quiet text (tab subtitles at rest, field placeholders) never sits on a hover surface.
  it("keeps secondary text readable on every background it is actually painted on", () => {
    const textBackgrounds = {
      textMuted: ["canvas", "surface", "surfaceHover"],
      textQuiet: ["canvas", "surface"]
    } as const;

    for (const [theme, palette] of Object.entries(uiPalettes)) {
      for (const [token, backgrounds] of Object.entries(textBackgrounds)) {
        for (const background of backgrounds) {
          expect(
            contrast(palette[token as keyof typeof palette], palette[background]),
            `${theme} ${token} against ${background}`
          ).toBeGreaterThanOrEqual(4.5);
        }
      }
    }
  });

  it("keeps every control boundary distinguishable from its adjacent backgrounds", () => {
    for (const [theme, palette] of Object.entries(uiPalettes)) {
      for (const indicator of controlIndicators) {
        for (const background of uiBackgrounds) {
          expect(
            contrast(palette[indicator], palette[background]),
            `${theme} ${indicator} against ${background}`
          ).toBeGreaterThanOrEqual(3);
        }
      }

      expect(
        contrast(palette.scrollbar, palette.canvas),
        `${theme} scrollbar against canvas`
      ).toBeGreaterThanOrEqual(3);
    }
  });

  it("keeps decorative separators quieter than control boundaries", () => {
    for (const [theme, palette] of Object.entries(uiPalettes)) {
      for (const background of uiBackgrounds) {
        expect(
          contrast(palette.borderSubtle, palette[background]),
          `${theme} subtle border against ${background}`
        ).toBeLessThan(contrast(palette.borderControl, palette[background]));
      }
    }
  });

  it("defines a complete, readable xterm palette for every theme", () => {
    for (const theme of Object.values(terminalThemes)) {
      // AA, matching the minimumContrastRatio floor TerminalPane applies at paint time.
      // Solarized Light is built on deliberately low-contrast body text and cannot meet AAA.
      expect(contrast(theme.foreground, theme.background)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(theme.cursor, theme.background)).toBeGreaterThanOrEqual(3);
      expect(theme.cursorAccent).toBeTruthy();
      expect(theme.selectionBackground).toBeTruthy();
      expect(theme.selectionForeground).toBeTruthy();
      expect(theme.selectionInactiveBackground).toBeTruthy();
      for (const color of ansiColors) expect(theme[color]).toMatch(/^#[0-9a-f]{6}$/iu);
    }
  });

  it("keeps literal UI colors inside the semantic token palette", () => {
    const stylesRoot = new URL("../../apps/web/src/styles/", import.meta.url);
    const semanticTheme = readFileSync(new URL("theme.css", stylesRoot), "utf8");
    const implementationStyles = ["base.css", "workspace.css", "dialog.css", "responsive.css"]
      .map((file) => readFileSync(new URL(file, stylesRoot), "utf8"))
      .join("\n");

    for (const palette of Object.values(uiPalettes)) {
      for (const color of Object.values(palette)) expect(semanticTheme).toContain(color);
    }
    expect(implementationStyles).not.toMatch(/#[0-9a-f]{3,8}|rgb\(/iu);
  });

  it("seats the terminal in a well that is a visible step off the app canvas", () => {
    for (const [theme, palette] of Object.entries(uiPalettes)) {
      const terminal = terminalThemes[theme as keyof typeof terminalThemes];
      expect(palette.terminalCanvas, `${theme} well matches the xterm background`).toBe(
        terminal.background
      );
      expect(terminal.cursorAccent, `${theme} cursor accent matches the well`).toBe(
        terminal.background
      );

      // Perceptible as a change of plane, far below anything that reads as banding.
      const step = contrast(palette.terminalCanvas, palette.canvas);
      expect(step, `${theme} well against canvas`).toBeGreaterThan(1.02);
      expect(step, `${theme} well against canvas`).toBeLessThan(1.6);
    }
  });

  it("styles the terminal well and its focused state from semantic tokens", () => {
    const mount = terminalMountRule(".terminal-mount");

    expect(mount).toContain("background: var(--color-terminal-canvas);");
    expect(mount).toContain("inset 0 0 0 1px var(--color-border-subtle)");
    expect(terminalMountRule(".terminal-mount:has(.xterm.focus)")).toContain(
      "inset 0 0 0 1px var(--color-focus-ring)"
    );
  });

  // FitAddon derives rows and columns from the mount's border-box size minus the padding
  // on .xterm itself, so inner spacing on the mount would be invisible to it and the
  // terminal would be sized larger than the space it has.
  it("keeps the terminal well free of geometry xterm cannot measure", () => {
    const mount = terminalMountRule(".terminal-mount");

    expect(mount).not.toMatch(/(^|[^-])padding:/u);
    expect(mount).not.toMatch(/(^|[^-])border:/u);
    expect(terminalMountRule(".terminal-mount .xterm")).toContain("padding:");
  });

  it("gives native selector popups an opaque themed surface", () => {
    const stylesRoot = new URL("../../apps/web/src/styles/", import.meta.url);
    const base = readFileSync(new URL("base.css", stylesRoot), "utf8");
    const dialog = readFileSync(new URL("dialog.css", stylesRoot), "utf8");

    expect(base).toMatch(
      /select option\s*\{[^}]*background-color:\s*var\(--color-surface\);[^}]*color:\s*var\(--color-text\);[^}]*\}/su
    );
    expect(dialog).toMatch(
      /\.field select\s*\{[^}]*background-color:\s*var\(--color-surface\);[^}]*\}/su
    );
  });
});

function terminalMountRule(selector: string): string {
  const workspace = readFileSync(
    new URL("../../apps/web/src/styles/workspace.css", import.meta.url),
    "utf8"
  );
  const start = workspace.indexOf(`\n${selector} {`);
  const end = workspace.indexOf("}", start);
  if (start === -1 || end === -1) throw new Error(`Missing CSS rule for ${selector}.`);
  return workspace.slice(start + selector.length + 3, end);
}

function contrast(first: string, second: string): number {
  const light = Math.max(luminance(first), luminance(second));
  const dark = Math.min(luminance(first), luminance(second));
  return (light + 0.05) / (dark + 0.05);
}

function luminance(hex: string): number {
  const channels = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/iu.exec(hex)?.slice(1);
  if (channels === undefined) throw new Error(`Expected an opaque hex color, received ${hex}.`);
  const [red, green, blue] = channels.map((channel) => {
    const value = Number.parseInt(channel, 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  if (red === undefined || green === undefined || blue === undefined) {
    throw new Error(`Unable to parse ${hex}.`);
  }
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}
