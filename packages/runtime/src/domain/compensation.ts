/** Keeps the triggering failure primary while retaining cleanup diagnostics for logs and tests. */
export function preservePrimaryFailure(primary: unknown, compensation: unknown): unknown {
  if (!(primary instanceof Error)) {
    return new AggregateError(
      [primary, compensation],
      "The operation and its compensation failed."
    );
  }
  const previousCause = primary.cause;
  const failures = previousCause === undefined ? [compensation] : [previousCause, compensation];
  Object.defineProperty(primary, "cause", {
    configurable: true,
    value: new AggregateError(failures, "Compensation failed after the primary failure.")
  });
  return primary;
}
