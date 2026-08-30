import type { WriterLease } from "../domain/writer-lease.js";

export interface RuntimeConstructionRepository {
  close(): void;
}

// A failed construction has no runtime object through which cleanup can be retried. Keep a strong
// reference so garbage collection cannot silently release ambiguous single-writer authority.
const retainedFailedConstructionLeases = new Set<WriterLease>();

/**
 * Cleans a failed composition attempt without releasing single-writer authority before the
 * application database is confirmed closed. A failed repository close intentionally leaves the
 * lease held until process exit because there is no safely constructed runtime through which to
 * retry it.
 */
export function cleanupFailedRuntimeConstruction(
  repository: RuntimeConstructionRepository | null,
  writerLease: WriterLease,
  repositoryConstructionClosed = repository === null
): readonly unknown[] {
  const failures: unknown[] = [];
  let repositoryClosed = repository === null && repositoryConstructionClosed;
  if (repository !== null) {
    try {
      repository.close();
      repositoryClosed = true;
    } catch (error: unknown) {
      failures.push(error);
    }
  }
  if (repositoryClosed) {
    try {
      writerLease.close();
    } catch (error: unknown) {
      failures.push(error);
      retainedFailedConstructionLeases.add(writerLease);
    }
  } else {
    retainedFailedConstructionLeases.add(writerLease);
  }
  return failures;
}
