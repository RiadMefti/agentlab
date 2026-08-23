import { describe, expect, it, vi } from "vitest";

import {
  appearances,
  parseAppearance,
  resolveAppearance,
  type Appearance,
  type ColorScheme
} from "../../apps/web/src/theme/theme-policy.js";
import {
  ThemeStore,
  type AppearanceStorage,
  type SystemThemeSource
} from "../../apps/web/src/theme/theme-store.js";

class MemoryAppearanceStorage implements AppearanceStorage {
  readonly writes: Appearance[] = [];

  constructor(public value: string | null) {}

  read(): string | null {
    return this.value;
  }

  write(appearance: Appearance): void {
    this.value = appearance;
    this.writes.push(appearance);
  }
}

class MutableSystemTheme implements SystemThemeSource {
  readonly #listeners = new Set<() => void>();

  constructor(private scheme: ColorScheme) {}

  getScheme(): ColorScheme {
    return this.scheme;
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  set(scheme: ColorScheme): void {
    this.scheme = scheme;
    for (const listener of this.#listeners) listener();
  }
}

describe("theme policy", () => {
  it("accepts only the built-in appearances", () => {
    expect(appearances).toEqual(["system", "light", "solarized-light", "dark", "tokyo-night"]);
    expect(parseAppearance("system")).toBe("system");
    expect(parseAppearance("tokyo-night")).toBe("tokyo-night");
    expect(parseAppearance("sepia")).toBeNull();
    expect(parseAppearance({ appearance: "dark" })).toBeNull();
  });

  it("resolves System to the default of the operating-system scheme", () => {
    expect(resolveAppearance("system", "dark")).toBe("dark");
    expect(resolveAppearance("system", "light")).toBe("light");
  });

  it("keeps a named theme regardless of the operating-system scheme", () => {
    expect(resolveAppearance("tokyo-night", "light")).toBe("tokyo-night");
    expect(resolveAppearance("solarized-light", "dark")).toBe("solarized-light");
  });
});

describe("ThemeStore", () => {
  it("canonicalizes invalid persisted input and follows live system changes", () => {
    const storage = new MemoryAppearanceStorage("sepia");
    const system = new MutableSystemTheme("light");
    const store = new ThemeStore(storage, system);
    const listener = vi.fn();
    store.subscribe(listener);

    expect(store.getSnapshot()).toEqual({ appearance: "system", resolvedTheme: "light" });
    expect(storage.writes).toEqual(["system"]);

    system.set("dark");
    expect(store.getSnapshot()).toEqual({ appearance: "system", resolvedTheme: "dark" });
    expect(listener).toHaveBeenCalledOnce();
  });

  it("persists explicit choices and ignores both invalid input and unrelated system changes", () => {
    const storage = new MemoryAppearanceStorage("system");
    const system = new MutableSystemTheme("light");
    const store = new ThemeStore(storage, system);
    const listener = vi.fn();
    store.subscribe(listener);

    expect(store.setAppearance("tokyo-night")).toBe(true);
    expect(store.setAppearance("sepia")).toBe(false);
    system.set("dark");
    system.set("light");

    expect(storage.value).toBe("tokyo-night");
    expect(store.getSnapshot()).toEqual({
      appearance: "tokyo-night",
      resolvedTheme: "tokyo-night"
    });
    expect(listener).toHaveBeenCalledOnce();
  });
});
