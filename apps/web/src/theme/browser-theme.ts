import { appearanceCookieName } from "@orchestrator/contracts";

import { uiPalettes } from "./theme-palette.js";
import type { Appearance, ResolvedTheme } from "./theme-policy.js";
import {
  ThemeStore,
  type AppearanceStorage,
  type SystemThemeSource,
  type ThemeSnapshot
} from "./theme-store.js";

export { appearanceCookieName };
export const appearanceCookieLifetimeSeconds = 60 * 60 * 24 * 400;
const darkSchemeQuery = "(prefers-color-scheme: dark)";

interface CookieDocument {
  cookie: string;
}

export class CookieAppearanceStorage implements AppearanceStorage {
  readonly #document: CookieDocument;

  constructor(document: CookieDocument) {
    this.#document = document;
  }

  read(): string | null {
    for (const rawPart of this.#document.cookie.split(";")) {
      const part = rawPart.trim();
      const separator = part.indexOf("=");
      if (separator === -1 || part.slice(0, separator) !== appearanceCookieName) continue;
      return part.slice(separator + 1);
    }
    return null;
  }

  write(appearance: Appearance): void {
    this.#document.cookie = `${appearanceCookieName}=${appearance}; Path=/; Max-Age=${String(appearanceCookieLifetimeSeconds)}; SameSite=Strict`;
  }
}

export class BrowserSystemThemeSource implements SystemThemeSource {
  readonly #mediaQuery: MediaQueryList;

  constructor(matchMedia: (query: string) => MediaQueryList) {
    this.#mediaQuery = matchMedia(darkSchemeQuery);
  }

  getTheme(): ResolvedTheme {
    return this.#mediaQuery.matches ? "dark" : "light";
  }

  subscribe(listener: () => void): () => void {
    this.#mediaQuery.addEventListener("change", listener);
    return () => {
      this.#mediaQuery.removeEventListener("change", listener);
    };
  }
}

export interface BrowserThemeRuntime {
  readonly store: ThemeStore;
  dispose(): void;
}

export function createBrowserThemeRuntime(window: Window, document: Document): BrowserThemeRuntime {
  const store = new ThemeStore(
    new CookieAppearanceStorage(document),
    new BrowserSystemThemeSource(window.matchMedia.bind(window))
  );
  applyThemeToDocument(document, store.getSnapshot());
  const unsubscribe = store.subscribe(() => {
    applyThemeToDocument(document, store.getSnapshot());
  });

  return {
    store,
    dispose() {
      unsubscribe();
      store.dispose();
    }
  };
}

export function applyThemeToDocument(document: Document, snapshot: ThemeSnapshot): void {
  document.documentElement.dataset.appearance = snapshot.appearance;
  document.documentElement.dataset.theme = snapshot.resolvedTheme;
  setMetaContent(document, "color-scheme", snapshot.resolvedTheme);
  setMetaContent(document, "theme-color", uiPalettes[snapshot.resolvedTheme].canvas);
}

function setMetaContent(document: Document, name: string, content: string): void {
  document.querySelector(`meta[name="${name}"]`)?.setAttribute("content", content);
}
