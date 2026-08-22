// @vitest-environment node

import { CookieJar, JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";

import {
  appearanceCookieLifetimeSeconds,
  CookieAppearanceStorage,
  applyThemeToDocument
} from "../../apps/web/src/theme/browser-theme.js";
import { uiPalettes } from "../../apps/web/src/theme/theme-palette.js";

describe("browser theme adapters", () => {
  it("persists an appearance across Electron embedded-server port changes", () => {
    const cookieJar = new CookieJar();
    const firstLaunch = new JSDOM("", {
      cookieJar,
      url: "http://127.0.0.1:43117/"
    });
    new CookieAppearanceStorage(firstLaunch.window.document).write("dark");

    const nextLaunch = new JSDOM("", {
      cookieJar,
      url: "http://127.0.0.1:59382/"
    });
    expect(new CookieAppearanceStorage(nextLaunch.window.document).read()).toBe("dark");

    const [cookie] = cookieJar.getCookiesSync("http://127.0.0.1:59382/");
    expect(cookie).toMatchObject({
      key: "ao-appearance",
      path: "/",
      sameSite: "strict",
      value: "dark"
    });
    expect(cookie?.maxAge).toBe(appearanceCookieLifetimeSeconds);
  });

  it("does not leak a host cookie to a different loopback hostname", () => {
    const cookieJar = new CookieJar();
    const document = new JSDOM("", {
      cookieJar,
      url: "http://127.0.0.1:4321/"
    }).window.document;
    new CookieAppearanceStorage(document).write("light");

    const localhostDocument = new JSDOM("", {
      cookieJar,
      url: "http://localhost:4321/"
    }).window.document;
    expect(new CookieAppearanceStorage(localhostDocument).read()).toBeNull();
  });

  it("applies the resolved scheme and browser chrome color", () => {
    const dom = new JSDOM(
      '<meta name="color-scheme" content="light"><meta name="theme-color" content="#fff">'
    );

    applyThemeToDocument(dom.window.document, {
      appearance: "system",
      resolvedTheme: "dark"
    });

    expect(dom.window.document.documentElement.dataset).toMatchObject({
      appearance: "system",
      theme: "dark"
    });
    expect(
      dom.window.document.querySelector('meta[name="color-scheme"]')?.getAttribute("content")
    ).toBe("dark");
    expect(
      dom.window.document.querySelector('meta[name="theme-color"]')?.getAttribute("content")
    ).toBe(uiPalettes.dark.canvas);
  });
});
