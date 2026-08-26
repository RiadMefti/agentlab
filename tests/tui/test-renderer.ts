/**
 * OpenTUI's renderer flush/input helpers are asynchronous, outside its initial synchronous act().
 * Disable React's browser-oriented act warning after mounting; frame predicates still await every
 * observable terminal update before assertions.
 */
export function allowOpenTuiAsyncUpdates(): void {
  const testGlobal = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };
  testGlobal.IS_REACT_ACT_ENVIRONMENT = false;
}
