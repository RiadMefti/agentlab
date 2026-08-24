import { appearances, parseAppearance } from "../theme/theme-policy.js";
import { useTheme } from "../theme/use-theme.js";

const appearanceLabels = {
  system: "System",
  light: "Light",
  dark: "Dark"
} as const;

export function AppearancePicker() {
  const { appearance, setAppearance } = useTheme();

  return (
    <label className="appearance-picker">
      <span className="visually-hidden">Appearance</span>
      <select
        aria-label="Appearance"
        value={appearance}
        onChange={(event) => {
          const selected = parseAppearance(event.target.value);
          if (selected !== null) setAppearance(selected);
        }}
      >
        {appearances.map((option) => (
          <option value={option} key={option}>
            {appearanceLabels[option]}
          </option>
        ))}
      </select>
    </label>
  );
}
