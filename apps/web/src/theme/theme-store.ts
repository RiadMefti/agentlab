import {
  parseAppearance,
  resolveAppearance,
  type Appearance,
  type ResolvedTheme
} from "./theme-policy.js";

export interface AppearanceStorage {
  read(): string | null;
  write(appearance: Appearance): void;
}

export interface SystemThemeSource {
  getTheme(): ResolvedTheme;
  subscribe(listener: () => void): () => void;
}

export interface ThemeSnapshot {
  readonly appearance: Appearance;
  readonly resolvedTheme: ResolvedTheme;
}

export class ThemeStore {
  readonly #storage: AppearanceStorage;
  readonly #systemTheme: SystemThemeSource;
  readonly #listeners = new Set<() => void>();
  readonly #unsubscribeSystem: () => void;
  #snapshot: ThemeSnapshot;

  constructor(storage: AppearanceStorage, systemTheme: SystemThemeSource) {
    this.#storage = storage;
    this.#systemTheme = systemTheme;

    const storedAppearance = parseAppearance(storage.read());
    const appearance = storedAppearance ?? "system";
    if (storedAppearance === null) storage.write(appearance);

    this.#snapshot = {
      appearance,
      resolvedTheme: resolveAppearance(appearance, systemTheme.getTheme())
    };
    this.#unsubscribeSystem = systemTheme.subscribe(() => {
      this.#refreshSystemTheme();
    });
  }

  readonly getSnapshot = (): ThemeSnapshot => this.#snapshot;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  setAppearance(value: unknown): boolean {
    const appearance = parseAppearance(value);
    if (appearance === null) return false;
    if (appearance === this.#snapshot.appearance) return true;

    this.#storage.write(appearance);
    this.#update({
      appearance,
      resolvedTheme: resolveAppearance(appearance, this.#systemTheme.getTheme())
    });
    return true;
  }

  dispose(): void {
    this.#unsubscribeSystem();
    this.#listeners.clear();
  }

  #refreshSystemTheme(): void {
    if (this.#snapshot.appearance !== "system") return;
    const resolvedTheme = this.#systemTheme.getTheme();
    if (resolvedTheme === this.#snapshot.resolvedTheme) return;
    this.#update({ appearance: "system", resolvedTheme });
  }

  #update(snapshot: ThemeSnapshot): void {
    this.#snapshot = snapshot;
    for (const listener of this.#listeners) listener();
  }
}
