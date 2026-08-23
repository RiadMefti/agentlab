import { resolveAppearance, themeBackgroundColors, type Appearance } from "@orchestrator/contracts";

import {
  isAppearanceCookieChangeForUrl,
  synchronizeNativeWindowTheme
} from "./initial-window-theme.js";

interface AppearanceCookie {
  readonly domain?: string;
  readonly name: string;
  readonly path?: string;
}

interface AppearanceCookieEvents {
  get(filter: {
    readonly name: string;
    readonly url: string;
  }): Promise<readonly { readonly value: string }[]>;
  on(event: "changed", listener: (event: unknown, cookie: AppearanceCookie) => void): unknown;
  removeListener(
    event: "changed",
    listener: (event: unknown, cookie: AppearanceCookie) => void
  ): unknown;
}

interface NativeThemeEvents {
  readonly shouldUseDarkColors: boolean;
  themeSource: "system" | "light" | "dark";
  on(event: "updated", listener: () => void): unknown;
  removeListener(event: "updated", listener: () => void): unknown;
}

interface NativeWindowCollection {
  getAllWindows(): readonly { setBackgroundColor(color: string): void }[];
}

export function registerNativeThemeSynchronization(
  cookies: AppearanceCookieEvents,
  nativeTheme: NativeThemeEvents,
  windows: NativeWindowCollection,
  serverUrl: string,
  initialAppearance: Appearance,
  onError: (error: unknown) => void
): () => void {
  let synchronization = Promise.resolve();
  // A named theme keeps its own background, so the window follows the stored appearance
  // rather than the native scheme alone.
  let appearance: Appearance = initialAppearance;
  const updateWindowBackgrounds = (): void => {
    const resolvedTheme = resolveAppearance(
      appearance,
      nativeTheme.shouldUseDarkColors ? "dark" : "light"
    );
    for (const window of windows.getAllWindows()) {
      window.setBackgroundColor(themeBackgroundColors[resolvedTheme]);
    }
  };
  const onCookieChanged = (_event: unknown, cookie: AppearanceCookie): void => {
    if (!isAppearanceCookieChangeForUrl(cookie, serverUrl)) return;
    synchronization = synchronization
      .then(() => synchronizeNativeWindowTheme(cookies, nativeTheme, serverUrl))
      .then((theme) => {
        appearance = theme.appearance;
        updateWindowBackgrounds();
      })
      .catch(onError);
  };

  cookies.on("changed", onCookieChanged);
  nativeTheme.on("updated", updateWindowBackgrounds);
  return () => {
    cookies.removeListener("changed", onCookieChanged);
    nativeTheme.removeListener("updated", updateWindowBackgrounds);
  };
}
