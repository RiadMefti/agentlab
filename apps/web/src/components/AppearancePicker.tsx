import { parseAppearance, themeIds, themeSchemes } from "../theme/theme-policy.js";
import { useTheme } from "../theme/use-theme.js";

const themeLabels = {
  light: "Light",
  "solarized-light": "Solarized Light",
  dark: "Dark",
  "tokyo-night": "Tokyo Night"
} as const;

const groups = [
  { label: "Light", scheme: "light" },
  { label: "Dark", scheme: "dark" }
] as const;

export function AppearancePicker() {
  const { appearance, setAppearance } = useTheme();

  return (
    <label className="appearance-picker">
      <span className="visually-hidden">Theme</span>
      <select
        aria-label="Theme"
        value={appearance}
        onChange={(event) => {
          const selected = parseAppearance(event.target.value);
          if (selected !== null) setAppearance(selected);
        }}
      >
        <option value="system">System</option>
        {groups.map(({ label, scheme }) => (
          <optgroup label={label} key={scheme}>
            {themeIds
              .filter((id) => themeSchemes[id] === scheme)
              .map((id) => (
                <option value={id} key={id}>
                  {themeLabels[id]}
                </option>
              ))}
          </optgroup>
        ))}
      </select>
    </label>
  );
}
