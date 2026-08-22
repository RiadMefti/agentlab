export interface AvailableUpdate {
  readonly version: string;
}

export interface DesktopUpdateApi {
  checkForUpdate(): Promise<AvailableUpdate | null>;
  openLatestRelease(): Promise<void>;
}
