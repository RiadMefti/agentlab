import { describe, expect, it, vi } from "vitest";

import {
  appearanceCookieName,
  themeBackgroundColors,
  type ColorScheme
} from "@orchestrator/contracts";

import { registerNativeThemeSynchronization } from "../../apps/desktop/src/native-theme-synchronizer.js";

const serverUrl = "http://127.0.0.1:59382";

interface CookieChange {
  readonly domain?: string;
  readonly name: string;
  readonly path?: string;
}

class FakeCookies {
  readonly get = vi.fn().mockResolvedValue([{ value: "dark" }]);
  readonly on = vi.fn(
    (_event: "changed", listener: (event: unknown, cookie: CookieChange) => void) => {
      this.listener = listener;
    }
  );
  readonly removeListener = vi.fn();
  private listener: ((event: unknown, cookie: CookieChange) => void) | null = null;

  emit(cookie: CookieChange): void {
    this.listener?.({}, cookie);
  }
}

class FakeNativeTheme {
  readonly on = vi.fn((_event: "updated", listener: () => void) => {
    this.listener = listener;
  });
  readonly removeListener = vi.fn();
  systemDark = false;
  private listener: (() => void) | null = null;
  private source: ColorScheme | "system" = "system";

  get shouldUseDarkColors(): boolean {
    return this.source === "system" ? this.systemDark : this.source === "dark";
  }

  get themeSource(): ColorScheme | "system" {
    return this.source;
  }

  set themeSource(scheme: ColorScheme | "system") {
    this.source = scheme;
    this.listener?.();
  }
}

describe("Electron native theme synchronization", () => {
  it("ignores unrelated cookies and applies exact appearance-cookie changes", async () => {
    const cookies = new FakeCookies();
    const nativeTheme = new FakeNativeTheme();
    const window = { setBackgroundColor: vi.fn() };
    const windows = { getAllWindows: () => [window] };
    const onError = vi.fn();
    const dispose = registerNativeThemeSynchronization(
      cookies,
      nativeTheme,
      windows,
      serverUrl,
      "system",
      onError
    );

    cookies.emit(cookie({ name: "other" }));
    expect(cookies.get).not.toHaveBeenCalled();

    cookies.emit(cookie({ name: appearanceCookieName }));
    await vi.waitFor(() => {
      expect(nativeTheme.themeSource).toBe("dark");
    });

    expect(cookies.get).toHaveBeenCalledWith({ name: appearanceCookieName, url: serverUrl });
    expect(window.setBackgroundColor).toHaveBeenLastCalledWith(themeBackgroundColors.dark);
    expect(onError).not.toHaveBeenCalled();

    dispose();
    expect(cookies.removeListener).toHaveBeenCalledWith("changed", expect.any(Function));
    expect(nativeTheme.removeListener).toHaveBeenCalledWith("updated", expect.any(Function));
  });

  it("gives native windows the background of the selected named theme", async () => {
    const cookies = new FakeCookies();
    cookies.get.mockResolvedValue([{ value: "tokyo-night" }]);
    const nativeTheme = new FakeNativeTheme();
    const window = { setBackgroundColor: vi.fn() };
    registerNativeThemeSynchronization(
      cookies,
      nativeTheme,
      { getAllWindows: () => [window] },
      serverUrl,
      "system",
      vi.fn()
    );

    cookies.emit(cookie({ name: appearanceCookieName }));

    await vi.waitFor(() => {
      expect(window.setBackgroundColor).toHaveBeenLastCalledWith(
        themeBackgroundColors["tokyo-night"]
      );
    });
    expect(nativeTheme.themeSource).toBe("dark");
  });

  it("keeps the persisted named theme when the native scheme updates before any cookie change", () => {
    const cookies = new FakeCookies();
    const nativeTheme = new FakeNativeTheme();
    const window = { setBackgroundColor: vi.fn() };
    registerNativeThemeSynchronization(
      cookies,
      nativeTheme,
      { getAllWindows: () => [window] },
      serverUrl,
      "tokyo-night",
      vi.fn()
    );

    nativeTheme.themeSource = "dark";

    expect(window.setBackgroundColor).toHaveBeenLastCalledWith(
      themeBackgroundColors["tokyo-night"]
    );
  });

  it("updates native window backgrounds when the System scheme changes", () => {
    const cookies = new FakeCookies();
    const nativeTheme = new FakeNativeTheme();
    const window = { setBackgroundColor: vi.fn() };
    registerNativeThemeSynchronization(
      cookies,
      nativeTheme,
      { getAllWindows: () => [window] },
      serverUrl,
      "system",
      vi.fn()
    );

    nativeTheme.systemDark = true;
    nativeTheme.themeSource = "system";

    expect(window.setBackgroundColor).toHaveBeenLastCalledWith(themeBackgroundColors.dark);
  });
});

function cookie(overrides: Partial<CookieChange>): CookieChange {
  return {
    name: appearanceCookieName,
    domain: ".127.0.0.1",
    path: "/",
    ...overrides
  };
}
