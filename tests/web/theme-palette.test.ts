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
      expect(contrast(palette.textMuted, palette.canvas)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(palette.textQuiet, palette.canvas)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(palette.focusRing, palette.canvas)).toBeGreaterThanOrEqual(3);
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

  it("defines a complete, readable xterm palette for both themes", () => {
    for (const theme of Object.values(terminalThemes)) {
      expect(contrast(theme.foreground, theme.background)).toBeGreaterThanOrEqual(7);
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
});

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
