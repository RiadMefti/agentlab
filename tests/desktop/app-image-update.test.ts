import { describe, expect, it, vi } from "vitest";

import {
  createAppImageUpdateApi,
  type AppImageUpdater
} from "../../apps/desktop/src/app-image-update.js";

function createUpdater(version = "0.2.0") {
  const checkForUpdates = vi.fn(() =>
    Promise.resolve({
      isUpdateAvailable: true,
      updateInfo: { version }
    })
  );
  const downloadUpdate = vi.fn(() => Promise.resolve(["/tmp/Orchestrator.AppImage"]));
  const quitAndInstall = vi.fn();
  const updater: AppImageUpdater = {
    allowDowngrade: true,
    allowPrerelease: true,
    autoDownload: true,
    autoInstallOnAppQuit: true,
    autoRunAppAfterInstall: false,
    checkForUpdates,
    downloadUpdate,
    quitAndInstall
  };
  return { checkForUpdates, downloadUpdate, quitAndInstall, updater };
}

describe("AppImage updates", () => {
  it("checks, downloads, and restarts into a newer stable AppImage", async () => {
    const { downloadUpdate, quitAndInstall, updater } = createUpdater();
    const beforeRestart = vi.fn();
    const openLatestRelease = vi.fn(() => Promise.resolve());
    const updates = createAppImageUpdateApi({
      beforeRestart,
      currentVersion: "0.1.0",
      openLatestRelease,
      updater
    });

    expect(updater).toMatchObject({
      allowDowngrade: false,
      allowPrerelease: false,
      autoDownload: false,
      autoInstallOnAppQuit: false,
      autoRunAppAfterInstall: true
    });
    await expect(updates.checkForUpdate()).resolves.toEqual({
      installation: "in-app",
      version: "0.2.0"
    });

    await updates.downloadUpdate();
    await updates.restartToUpdate();
    await updates.openLatestRelease();

    expect(downloadUpdate).toHaveBeenCalledOnce();
    expect(beforeRestart).toHaveBeenCalledOnce();
    expect(quitAndInstall).toHaveBeenCalledWith(false, true);
    expect(openLatestRelease).toHaveBeenCalledOnce();
  });

  it("does not install before a validated update finishes downloading", async () => {
    const { downloadUpdate, quitAndInstall, updater } = createUpdater();
    const updates = createAppImageUpdateApi({
      beforeRestart: vi.fn(),
      currentVersion: "0.1.0",
      openLatestRelease: vi.fn(() => Promise.resolve()),
      updater
    });

    await expect(updates.downloadUpdate()).rejects.toThrow("No AppImage update");
    await expect(updates.restartToUpdate()).rejects.toThrow("has not finished");
    expect(downloadUpdate).not.toHaveBeenCalled();
    expect(quitAndInstall).not.toHaveBeenCalled();
  });

  it("keeps update checks quiet when metadata is invalid or unavailable", async () => {
    const invalidUpdater = createUpdater("0.2.0-beta.1").updater;
    const unavailable = createUpdater();
    unavailable.updater.checkForUpdates = vi.fn(() => Promise.reject(new Error("offline")));
    const onCheckError = vi.fn();
    const common = {
      beforeRestart: vi.fn(),
      currentVersion: "0.1.0",
      onCheckError,
      openLatestRelease: vi.fn(() => Promise.resolve())
    };

    await expect(
      createAppImageUpdateApi({ ...common, updater: invalidUpdater }).checkForUpdate()
    ).resolves.toBeNull();
    await expect(
      createAppImageUpdateApi({ ...common, updater: unavailable.updater }).checkForUpdate()
    ).resolves.toBeNull();
    expect(onCheckError).toHaveBeenCalledTimes(2);
  });
});
