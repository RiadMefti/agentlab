export interface CommandSpec {
  readonly executable: string;
  readonly args: readonly string[];
  readonly environment?: Readonly<Record<string, string>>;
}
