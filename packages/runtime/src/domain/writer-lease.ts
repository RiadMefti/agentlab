/** Exclusive ownership of one canonical application database for one runtime lifetime. */
export interface WriterLease {
  readonly databasePath: string;
  close(): void;
}
