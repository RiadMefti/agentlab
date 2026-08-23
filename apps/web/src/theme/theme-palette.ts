import type { ITheme } from "@xterm/xterm";
import { themeBackgroundColors } from "@orchestrator/contracts";

import type { ResolvedTheme } from "./theme-policy.js";

// The terminal has no frame of its own: xterm paints an opaque rect
// (allowTransparency is false), so every terminal background below is the theme's canvas
// and the session merges into the page.
//
// Solarized and Tokyo Night use their upstream 16-colour ANSI palettes verbatim. Cursor
// and selection colours are adapted: each cursor is the theme's own accent so the caret
// marks the input point. Their UI tokens below are derived too, because each project's
// chrome colours sit under the contrast floors enforced in
// tests/web/theme-palette.test.ts.
export const uiPalettes = {
  light: {
    canvas: themeBackgroundColors.light,
    surface: "#ffffff",
    surfaceHover: "#eef2f6",
    text: "#18202a",
    textMuted: "#596574",
    textQuiet: "#667382",
    borderSubtle: "#d8dee6",
    borderControl: "#7a8796",
    borderControlHover: "#667484",
    focusRing: "#1d4ed8",
    scrollbar: "#7a8796",
    backdrop: "rgb(248 250 252 / 88%)",
    shadow: "rgb(15 23 42 / 10%)"
  },
  "solarized-light": {
    canvas: themeBackgroundColors["solarized-light"],
    surface: "#eee8d5",
    surfaceHover: "#e8e1cd",
    text: "#073642",
    textMuted: "#3f5560",
    textQuiet: "#4e646c",
    borderSubtle: "#ddd6c3",
    borderControl: "#657b83",
    borderControlHover: "#586e75",
    // Solarized blue stays the terminal cursor; the UI ring is darkened so it clears
    // 3:1 against the hover surface as well as the canvas.
    focusRing: "#1c6ca8",
    scrollbar: "#657b83",
    backdrop: "rgb(253 246 227 / 90%)",
    shadow: "rgb(101 123 131 / 22%)"
  },
  dark: {
    canvas: themeBackgroundColors.dark,
    surface: "#1c2229",
    surfaceHover: "#242b33",
    text: "#edf1f5",
    textMuted: "#aeb8c4",
    textQuiet: "#919daa",
    borderSubtle: "#333b45",
    borderControl: "#74808d",
    borderControlHover: "#8995a2",
    focusRing: "#75a7ff",
    scrollbar: "#74808d",
    backdrop: "rgb(21 25 30 / 90%)",
    shadow: "rgb(0 0 0 / 36%)"
  },
  "tokyo-night": {
    canvas: themeBackgroundColors["tokyo-night"],
    surface: "#1a1b26",
    surfaceHover: "#292e42",
    text: "#c0caf5",
    textMuted: "#a9b1d6",
    textQuiet: "#8189b3",
    borderSubtle: "#292e42",
    borderControl: "#7f88b8",
    borderControlHover: "#98a0c9",
    focusRing: "#7aa2f7",
    scrollbar: "#7f88b8",
    backdrop: "rgb(22 22 30 / 92%)",
    shadow: "rgb(0 0 0 / 45%)"
  }
} as const satisfies Record<ResolvedTheme, Record<string, string>>;

export const terminalThemes = {
  light: {
    background: themeBackgroundColors.light,
    foreground: "#25313d",
    cursor: "#1d4ed8",
    cursorAccent: themeBackgroundColors.light,
    selectionBackground: "#bfdbfe",
    selectionForeground: "#172033",
    selectionInactiveBackground: "#dbeafe",
    black: "#25313d",
    red: "#a82b20",
    green: "#18794e",
    yellow: "#7a5100",
    blue: "#155eef",
    magenta: "#9333a8",
    cyan: "#087b83",
    white: "#465362",
    brightBlack: "#52606d",
    brightRed: "#c4322b",
    brightGreen: "#238636",
    brightYellow: "#8a5c00",
    brightBlue: "#1d4ed8",
    brightMagenta: "#a53bb3",
    brightCyan: "#0e7490",
    brightWhite: "#111827"
  },
  // Solarized (Ethan Schoonover). base01 is the foreground rather than base00: base00
  // sits at 4.1:1 on base3, under the 4.5 minimumContrastRatio floor, so xterm would
  // rescale it at paint time anyway.
  "solarized-light": {
    background: themeBackgroundColors["solarized-light"],
    foreground: "#586e75",
    cursor: "#268bd2",
    cursorAccent: themeBackgroundColors["solarized-light"],
    selectionBackground: "#d6e2ea",
    selectionForeground: "#073642",
    selectionInactiveBackground: "#e6eaea",
    black: "#073642",
    red: "#dc322f",
    green: "#859900",
    yellow: "#b58900",
    blue: "#268bd2",
    magenta: "#d33682",
    cyan: "#2aa198",
    white: "#eee8d5",
    brightBlack: "#002b36",
    brightRed: "#cb4b16",
    brightGreen: "#586e75",
    brightYellow: "#657b83",
    brightBlue: "#839496",
    brightMagenta: "#6c71c4",
    brightCyan: "#93a1a1",
    brightWhite: "#fdf6e3"
  },
  dark: {
    background: themeBackgroundColors.dark,
    foreground: "#e6edf3",
    cursor: "#75a7ff",
    cursorAccent: themeBackgroundColors.dark,
    selectionBackground: "#294a72",
    selectionForeground: "#ffffff",
    selectionInactiveBackground: "#263747",
    black: "#8b949e",
    red: "#ff7b72",
    green: "#7ee787",
    yellow: "#d3a83f",
    blue: "#79c0ff",
    magenta: "#d2a8ff",
    cyan: "#56d4dd",
    white: "#d0d7de",
    brightBlack: "#a5afba",
    brightRed: "#ffa198",
    brightGreen: "#aff5b4",
    brightYellow: "#f2cc60",
    brightBlue: "#a5d6ff",
    brightMagenta: "#e2c5ff",
    brightCyan: "#8be9f0",
    brightWhite: "#ffffff"
  },
  // Tokyo Night (folke), night variant.
  "tokyo-night": {
    background: themeBackgroundColors["tokyo-night"],
    foreground: "#c0caf5",
    cursor: "#7aa2f7",
    cursorAccent: themeBackgroundColors["tokyo-night"],
    selectionBackground: "#283457",
    selectionForeground: "#c0caf5",
    selectionInactiveBackground: "#222b45",
    black: "#15161e",
    red: "#f7768e",
    green: "#9ece6a",
    yellow: "#e0af68",
    blue: "#7aa2f7",
    magenta: "#bb9af7",
    cyan: "#7dcfff",
    white: "#a9b1d6",
    brightBlack: "#414868",
    brightRed: "#ff899d",
    brightGreen: "#9fe044",
    brightYellow: "#faba4a",
    brightBlue: "#8db0ff",
    brightMagenta: "#c7a9ff",
    brightCyan: "#a4daff",
    brightWhite: "#c0caf5"
  }
} as const satisfies Record<ResolvedTheme, ITheme>;

export function terminalThemeFor(theme: ResolvedTheme): ITheme {
  return terminalThemes[theme];
}
