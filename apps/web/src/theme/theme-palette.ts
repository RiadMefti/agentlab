import type { ITheme } from "@xterm/xterm";
import { themeBackgroundColors } from "@orchestrator/contracts";

import type { ResolvedTheme } from "./theme-policy.js";

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
  }
} as const satisfies Record<ResolvedTheme, ITheme>;

export function terminalThemeFor(theme: ResolvedTheme): ITheme {
  return terminalThemes[theme];
}
