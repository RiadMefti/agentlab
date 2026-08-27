export interface TimeoutOptions {
  readonly timeoutMs: number;
  readonly message: string;
}

/** Bounds a promise without blocking the event loop. */
export async function withTimeout<Value>(
  operation: PromiseLike<Value>,
  options: TimeoutOptions
): Promise<Value> {
  assertPositiveTimeout(options.timeoutMs);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      reject(new Error(options.message));
    }, options.timeoutMs);
  });
  try {
    return await Promise.race([Promise.resolve(operation), deadline]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

export function assertPositiveTimeout(timeoutMs: number): void {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("Timeout must be a positive integer.");
  }
}
