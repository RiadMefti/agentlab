export const appearances = ["system", "light", "dark"] as const;

export type Appearance = (typeof appearances)[number];
export type ResolvedTheme = Exclude<Appearance, "system">;

export const appearanceCookieName = "ao-appearance";

export const themeBackgroundColors = {
  light: "#f8fafc",
  dark: "#15191e"
} as const satisfies Record<ResolvedTheme, string>;

export function parseAppearance(value: unknown): Appearance | null {
  return typeof value === "string" && appearances.some((appearance) => appearance === value)
    ? (value as Appearance)
    : null;
}

export function resolveAppearance(
  appearance: Appearance,
  systemTheme: ResolvedTheme
): ResolvedTheme {
  return appearance === "system" ? systemTheme : appearance;
}
