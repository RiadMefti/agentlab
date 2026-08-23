import { describe, expect, it, vi } from "vitest";

import {
  appearanceCookieName,
  themeBackgroundColors,
  type ColorScheme
} from "@orchestrator/contracts";

import {
  isAppearanceCookieChangeForUrl,
  synchronizeNativeWindowTheme
} from "../../apps/desktop/src/initial-window-theme.js";

const serverUrl = "http://127.0.0.1:59382";

describe("Electron initial window theme", () => {
  it.each([
    { stored: "dark", systemDark: false, scheme: "dark" },
    { stored: "light", systemDark: true, scheme: "light" },
    { stored: "tokyo-night", systemDark: false, scheme: "dark" },
    { stored: "solarized-light", systemDark: true, scheme: "light" }
  ] as const)(
    "uses persisted $stored before BrowserWindow creation",
    async ({ stored, systemDark, scheme }) => {
      const cookies = {
        get: vi.fn().mockResolvedValue([{ value: stored }])
      };
      const nativeTheme = fakeNativeTheme(systemDark);

      await expect(synchronizeNativeWindowTheme(cookies, nativeTheme, serverUrl)).resolves.toEqual({
        appearance: stored,
        resolvedTheme: stored,
        backgroundColor: themeBackgroundColors[stored]
      });
      // Electron only understands the two schemes; the theme keeps its own background.
      expect(nativeTheme.themeSource).toBe(scheme);
      expect(cookies.get).toHaveBeenCalledWith({ name: appearanceCookieName, url: serverUrl });
    }
  );

  it.each([
    { stored: "system", systemDark: true, resolvedTheme: "dark" },
    { stored: "system", systemDark: false, resolvedTheme: "light" },
    { stored: "sepia", systemDark: true, resolvedTheme: "dark" },
    { stored: null, systemDark: false, resolvedTheme: "light" }
  ] as const)(
    "uses the $resolvedTheme system background for stored value $stored",
    async ({ stored, systemDark, resolvedTheme }) => {
      const cookies = {
        get: vi.fn().mockResolvedValue(stored === null ? [] : [{ value: stored }])
      };
      const nativeTheme = fakeNativeTheme(systemDark);

      await expect(synchronizeNativeWindowTheme(cookies, nativeTheme, serverUrl)).resolves.toEqual({
        appearance: "system",
        resolvedTheme,
        backgroundColor: themeBackgroundColors[resolvedTheme]
      });
      expect(nativeTheme.themeSource).toBe("system");
    }
  );

  it("falls back to the current system scheme when the persistent session is unavailable", async () => {
    const cookies = {
      get: vi.fn().mockRejectedValue(new Error("session unavailable"))
    };
    const nativeTheme = fakeNativeTheme(true);

    await expect(synchronizeNativeWindowTheme(cookies, nativeTheme, serverUrl)).resolves.toEqual({
      appearance: "system",
      resolvedTheme: "dark",
      backgroundColor: themeBackgroundColors.dark
    });
  });

  it("accepts only the exact host/root appearance cookie change", () => {
    expect(
      isAppearanceCookieChangeForUrl(
        { name: appearanceCookieName, domain: ".127.0.0.1", path: "/" },
        serverUrl
      )
    ).toBe(true);
    expect(
      isAppearanceCookieChangeForUrl({ name: "other", domain: ".127.0.0.1", path: "/" }, serverUrl)
    ).toBe(false);
    expect(
      isAppearanceCookieChangeForUrl(
        { name: appearanceCookieName, domain: ".localhost", path: "/" },
        serverUrl
      )
    ).toBe(false);
    expect(
      isAppearanceCookieChangeForUrl(
        { name: appearanceCookieName, domain: ".127.0.0.1", path: "/nested" },
        serverUrl
      )
    ).toBe(false);
  });
});

function fakeNativeTheme(systemUsesDarkColors: boolean) {
  let source: ColorScheme | "system" = "system";
  return {
    get shouldUseDarkColors() {
      return source === "system" ? systemUsesDarkColors : source === "dark";
    },
    get themeSource() {
      return source;
    },
    set themeSource(scheme: ColorScheme | "system") {
      source = scheme;
    }
  };
}
