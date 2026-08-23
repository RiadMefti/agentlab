export type ColorScheme = "light" | "dark";

export const themeIds = ["light", "solarized-light", "dark", "tokyo-night"] as const;

export type ResolvedTheme = (typeof themeIds)[number];

export const appearances = ["system", ...themeIds] as const;

export type Appearance = (typeof appearances)[number];

export const appearanceCookieName = "ao-appearance";

export const themeSchemes = {
  light: "light",
  "solarized-light": "light",
  dark: "dark",
  "tokyo-night": "dark"
} as const satisfies Record<ResolvedTheme, ColorScheme>;

export const themeBackgroundColors = {
  light: "#f8fafc",
  "solarized-light": "#fdf6e3",
  dark: "#15191e",
  "tokyo-night": "#16161e"
} as const satisfies Record<ResolvedTheme, string>;

export function parseAppearance(value: unknown): Appearance | null {
  return typeof value === "string" && appearances.some((appearance) => appearance === value)
    ? (value as Appearance)
    : null;
}

// The two scheme names are also the ids of the themes System falls back to.
export function resolveAppearance(
  appearance: Appearance,
  systemScheme: ColorScheme
): ResolvedTheme {
  return appearance === "system" ? systemScheme : appearance;
}
