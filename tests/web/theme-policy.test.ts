import { describe, expect, it, vi } from "vitest";

import {
  appearances,
  parseAppearance,
  resolveAppearance,
  type Appearance,
  type ResolvedTheme
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

  constructor(private theme: ResolvedTheme) {}

  getTheme(): ResolvedTheme {
    return this.theme;
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  set(theme: ResolvedTheme): void {
    this.theme = theme;
    for (const listener of this.#listeners) listener();
  }
}

describe("theme policy", () => {
  it("accepts only the three built-in appearances", () => {
    expect(appearances).toEqual(["system", "light", "dark"]);
    expect(parseAppearance("system")).toBe("system");
    expect(parseAppearance("light")).toBe("light");
    expect(parseAppearance("dark")).toBe("dark");
    expect(parseAppearance("sepia")).toBeNull();
    expect(parseAppearance({ appearance: "dark" })).toBeNull();
  });

  it("resolves System from the operating-system preference", () => {
    expect(resolveAppearance("system", "dark")).toBe("dark");
    expect(resolveAppearance("system", "light")).toBe("light");
    expect(resolveAppearance("light", "dark")).toBe("light");
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

    expect(store.setAppearance("dark")).toBe(true);
    expect(store.setAppearance("sepia")).toBe(false);
    system.set("dark");
    system.set("light");

    expect(storage.value).toBe("dark");
    expect(store.getSnapshot()).toEqual({ appearance: "dark", resolvedTheme: "dark" });
    expect(listener).toHaveBeenCalledOnce();
  });
});
