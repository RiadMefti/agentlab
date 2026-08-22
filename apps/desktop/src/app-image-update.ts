import type { AvailableUpdate, DesktopUpdateApi } from "@orchestrator/contracts";

import { compareStableVersions } from "./release-update.js";

interface UpdateCheckResult {
  readonly isUpdateAvailable: boolean;
  readonly updateInfo: {
    readonly version: string;
  };
}

export interface AppImageUpdater {
  allowDowngrade: boolean;
  allowPrerelease: boolean;
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  autoRunAppAfterInstall: boolean;
  checkForUpdates(): Promise<UpdateCheckResult | null>;
  downloadUpdate(): Promise<readonly string[]>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
}

interface AppImageUpdateOptions {
  readonly beforeRestart: () => void;
  readonly currentVersion: string;
  readonly onCheckError?: (error: unknown) => void;
  readonly openLatestRelease: () => Promise<void>;
  readonly updater: AppImageUpdater;
}

export function createAppImageUpdateApi(options: AppImageUpdateOptions): DesktopUpdateApi {
  let availableVersion: string | null = null;
  let downloadedVersion: string | null = null;
  let checkPromise: Promise<AvailableUpdate | null> | null = null;
  let downloadPromise: Promise<void> | null = null;

  options.updater.autoDownload = false;
  options.updater.autoInstallOnAppQuit = false;
  options.updater.autoRunAppAfterInstall = true;
  options.updater.allowPrerelease = false;
  options.updater.allowDowngrade = false;

  const availableUpdate = (version: string): AvailableUpdate => ({
    installation: "in-app",
    version
  });

  return {
    async checkForUpdate() {
      if (downloadedVersion !== null) return availableUpdate(downloadedVersion);
      if (checkPromise !== null) return checkPromise;

      checkPromise = (async () => {
        try {
          const result = await options.updater.checkForUpdates();
          if (
            result === null ||
            !result.isUpdateAvailable ||
            compareStableVersions(result.updateInfo.version, options.currentVersion) <= 0
          ) {
            availableVersion = null;
            return null;
          }

          availableVersion = result.updateInfo.version;
          return availableUpdate(availableVersion);
        } catch (error) {
          options.onCheckError?.(error);
          return availableVersion === null ? null : availableUpdate(availableVersion);
        }
      })().finally(() => {
        checkPromise = null;
      });

      return checkPromise;
    },
    async downloadUpdate() {
      if (downloadedVersion !== null) return;
      if (availableVersion === null) {
        throw new Error("No AppImage update is available to download.");
      }
      if (downloadPromise !== null) return downloadPromise;

      const version = availableVersion;
      downloadPromise = options.updater
        .downloadUpdate()
        .then(() => {
          downloadedVersion = version;
        })
        .finally(() => {
          downloadPromise = null;
        });
      return downloadPromise;
    },
    openLatestRelease: options.openLatestRelease,
    restartToUpdate() {
      if (downloadedVersion === null) {
        return Promise.reject(new Error("The AppImage update has not finished downloading."));
      }

      options.beforeRestart();
      options.updater.quitAndInstall(false, true);
      return Promise.resolve();
    }
  };
}
