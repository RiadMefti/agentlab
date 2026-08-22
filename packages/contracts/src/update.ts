export interface AvailableUpdate {
  readonly installation: "in-app" | "manual";
  readonly version: string;
}

export interface DesktopUpdateApi {
  checkForUpdate(): Promise<AvailableUpdate | null>;
  downloadUpdate(): Promise<void>;
  openLatestRelease(): Promise<void>;
  restartToUpdate(): Promise<void>;
}
