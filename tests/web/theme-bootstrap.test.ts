// @vitest-environment node

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { CookieJar, JSDOM } from "jsdom";
import { describe, expect, it, vi } from "vitest";

import { appearanceCookieName } from "@orchestrator/contracts";

import { uiPalettes } from "../../apps/web/src/theme/theme-palette.js";

const indexHtml = readFileSync(new URL("../../apps/web/index.html", import.meta.url), "utf8");
const bootstrapMatch = /<script id="theme-bootstrap">([\s\S]*?)<\/script>/u.exec(indexHtml);
if (bootstrapMatch?.[1] === undefined) throw new Error("Theme bootstrap script is missing.");
const bootstrap = bootstrapMatch[1];

function runBootstrap(cookie: string | null, systemDark: boolean): Document {
  const cookieJar = new CookieJar();
  if (cookie !== null) cookieJar.setCookieSync(cookie, "http://127.0.0.1:4321/");

  return new JSDOM(
    `<!doctype html><html><head><meta name="color-scheme" content="light"><meta name="theme-color" content="#fff"><script>${bootstrap}</script></head></html>`,
    {
      beforeParse(window) {
        window.matchMedia = vi.fn().mockReturnValue({ matches: systemDark });
      },
      cookieJar,
      runScripts: "dangerously",
      url: "http://127.0.0.1:4321/"
    }
  ).window.document;
}

describe("first-paint theme bootstrap", () => {
  it("has an exact CSP hash so bootstrap edits cannot drift silently", () => {
    const digest = createHash("sha256").update(bootstrap).digest("base64");
    expect(indexHtml).toContain(`script-src 'self' 'sha256-${digest}'`);
  });

  it("synchronously applies a persisted appearance before the application module", () => {
    const document = runBootstrap(`${appearanceCookieName}=dark`, false);

    expect(document.documentElement.dataset).toMatchObject({
      appearance: "dark",
      theme: "dark"
    });
    expect(document.querySelector('meta[name="color-scheme"]')?.getAttribute("content")).toBe(
      "dark"
    );
    expect(document.querySelector('meta[name="theme-color"]')?.getAttribute("content")).toBe(
      uiPalettes.dark.canvas
    );
  });

  it("applies a named theme and its underlying scheme", () => {
    const document = runBootstrap(`${appearanceCookieName}=tokyo-night`, false);

    expect(document.documentElement.dataset).toMatchObject({
      appearance: "tokyo-night",
      theme: "tokyo-night"
    });
    expect(document.querySelector('meta[name="color-scheme"]')?.getAttribute("content")).toBe(
      "dark"
    );
    expect(document.querySelector('meta[name="theme-color"]')?.getAttribute("content")).toBe(
      uiPalettes["tokyo-night"].canvas
    );
  });

  it("rejects inherited object keys as stored appearances", () => {
    for (const key of ["__proto__", "constructor"]) {
      const document = runBootstrap(`${appearanceCookieName}=${key}`, false);

      expect(document.documentElement.dataset).toMatchObject({
        appearance: "system",
        theme: "light"
      });
      expect(document.querySelector('meta[name="theme-color"]')?.getAttribute("content")).toBe(
        uiPalettes.light.canvas
      );
    }
  });

  it("uses the system scheme for missing or invalid preferences", () => {
    const missing = runBootstrap(null, true);
    const invalid = runBootstrap(`${appearanceCookieName}=sepia`, false);

    expect(missing.documentElement.dataset).toMatchObject({
      appearance: "system",
      theme: "dark"
    });
    expect(invalid.documentElement.dataset).toMatchObject({
      appearance: "system",
      theme: "light"
    });
    expect(missing.querySelector('meta[name="theme-color"]')?.getAttribute("content")).toBe(
      uiPalettes.dark.canvas
    );
    expect(invalid.querySelector('meta[name="theme-color"]')?.getAttribute("content")).toBe(
      uiPalettes.light.canvas
    );
  });
});
