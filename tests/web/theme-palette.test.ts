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

  it("paints the terminal on the app canvas so it has no edge of its own", () => {
    for (const [theme, palette] of Object.entries(uiPalettes)) {
      const terminal = terminalThemes[theme as keyof typeof terminalThemes];
      // xterm fills its rect opaquely (allowTransparency is false), so merging with the
      // page means matching the canvas exactly rather than approaching it.
      expect(terminal.background, `${theme} terminal background matches the canvas`).toBe(
        palette.canvas
      );
      expect(terminal.cursorAccent, `${theme} cursor accent matches the canvas`).toBe(
        palette.canvas
      );
    }
  });

  it("leaves the terminal mount without a frame, well, or inner spacing", () => {
    const rules = terminalMountRules();

    expect(rules).not.toMatch(/border[^:]*:|box-shadow:|padding:/u);
    for (const [, background] of rules.matchAll(/background:([^;]+);/gu)) {
      expect(background).toContain("transparent");
    }
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

// Every declaration block whose selector touches the terminal mount or what xterm
// renders inside it.
function terminalMountRules(): string {
  const workspace = readFileSync(
    new URL("../../apps/web/src/styles/workspace.css", import.meta.url),
    "utf8"
  );
  const rules = [...workspace.matchAll(/([^{}]*\.terminal-mount[^{}]*)\{([^}]*)\}/gu)];
  if (rules.length === 0) throw new Error("Missing CSS rules for the terminal mount.");
  return rules.map(([rule]) => rule).join("\n");
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
