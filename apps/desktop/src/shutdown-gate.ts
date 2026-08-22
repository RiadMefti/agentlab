export class ShutdownGate {
  #started = false;

  public get started(): boolean {
    return this.#started;
  }

  public begin(): boolean {
    if (this.#started) return false;
    this.#started = true;
    return true;
  }

  public shouldQuitAfterWindowsClose(platform: NodeJS.Platform): boolean {
    return platform !== "darwin" && !this.#started;
  }
}
