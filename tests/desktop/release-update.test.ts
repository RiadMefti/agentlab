import { describe, expect, it, vi } from "vitest";

import type { ReleaseRequest } from "../../apps/desktop/src/release-update.js";
import {
  checkLatestRelease,
  compareStableVersions,
  createDesktopUpdateApi,
  LATEST_RELEASE_API_URL,
  LATEST_RELEASE_PAGE_URL
} from "../../apps/desktop/src/release-update.js";

function releaseResponse(tag: string) {
  return {
    ok: true,
    status: 200,
    json() {
      return Promise.resolve({ draft: false, prerelease: false, tag_name: tag });
    }
  };
}

describe("desktop GitHub release updates", () => {
  it("reports only a newer validated stable release", async () => {
    const request: ReleaseRequest = vi.fn(() => Promise.resolve(releaseResponse("v0.2.0")));

    await expect(checkLatestRelease({ currentVersion: "0.1.0", request })).resolves.toEqual({
      version: "0.2.0"
    });
    expect(request).toHaveBeenCalledWith(
      LATEST_RELEASE_API_URL,
      expect.objectContaining({
        headers: expect.objectContaining({
          Accept: "application/vnd.github+json",
          "User-Agent": "agent-orchestrator/0.1.0"
        }),
        signal: expect.any(AbortSignal)
      })
    );
  });

  it.each(["v0.1.0", "v0.0.9"])("hides a non-newer release tagged %s", async (tag) => {
    const request: ReleaseRequest = vi.fn(() => Promise.resolve(releaseResponse(tag)));

    await expect(checkLatestRelease({ currentVersion: "0.1.0", request })).resolves.toBeNull();
  });

  it("treats a repository without a release as up to date", async () => {
    const request: ReleaseRequest = vi.fn(() =>
      Promise.resolve({
        ok: false,
        status: 404,
        json() {
          return Promise.resolve({});
        }
      })
    );

    await expect(checkLatestRelease({ currentVersion: "0.1.0", request })).resolves.toBeNull();
  });

  it.each([
    { draft: true, prerelease: false, tag_name: "v0.2.0" },
    { draft: false, prerelease: true, tag_name: "v0.2.0" },
    { draft: false, prerelease: false, tag_name: "v0.2.0-beta.1" },
    { draft: false, prerelease: false, tag_name: "release" }
  ])("rejects malformed or non-stable GitHub metadata", async (payload) => {
    const request: ReleaseRequest = vi.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json() {
          return Promise.resolve(payload);
        }
      })
    );

    await expect(checkLatestRelease({ currentVersion: "0.1.0", request })).rejects.toThrow(
      /release/u
    );
  });

  it("compares stable versions without numeric precision loss", () => {
    expect(compareStableVersions("9007199254740993.0.0", "9007199254740992.999.999")).toBe(1);
    expect(compareStableVersions("1.10.0", "1.9.99")).toBe(1);
    expect(compareStableVersions("1.0.0", "1.0.0")).toBe(0);
  });

  it("keeps development and failed checks quiet", async () => {
    const request: ReleaseRequest = vi.fn(() => Promise.reject(new Error("offline")));
    const onCheckError = vi.fn();
    const developmentApi = createDesktopUpdateApi({
      currentVersion: "0.1.0",
      isPackaged: false,
      onCheckError,
      openExternal: vi.fn(() => Promise.resolve()),
      request
    });

    await expect(developmentApi.checkForUpdate()).resolves.toBeNull();
    expect(request).not.toHaveBeenCalled();
    expect(onCheckError).not.toHaveBeenCalled();

    const packagedApi = createDesktopUpdateApi({
      currentVersion: "0.1.0",
      isPackaged: true,
      onCheckError,
      openExternal: vi.fn(() => Promise.resolve()),
      request
    });
    await expect(packagedApi.checkForUpdate()).resolves.toBeNull();
    expect(onCheckError).toHaveBeenCalledWith(expect.objectContaining({ message: "offline" }));
  });

  it("opens only the fixed latest-release page", async () => {
    const openExternal = vi.fn(() => Promise.resolve());
    const api = createDesktopUpdateApi({
      currentVersion: "0.1.0",
      isPackaged: true,
      openExternal,
      request: vi.fn(() => Promise.resolve(releaseResponse("v0.1.0")))
    });

    await api.openLatestRelease();

    expect(openExternal).toHaveBeenCalledWith(LATEST_RELEASE_PAGE_URL);
  });
});
