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
 * retry it. The final flag is false only when a repository constructor may have retained an
 * untracked database handle; closing every previously tracked repository cannot prove that handle
 * absent.
 */
export function cleanupFailedRuntimeConstruction(
  repository: RuntimeConstructionRepository | null,
  writerLease: WriterLease,
  allDatabaseHandlesAccountedFor = true
): readonly unknown[] {
  const failures: unknown[] = [];
  let repositoryClosed = repository === null && allDatabaseHandlesAccountedFor;
  if (repository !== null) {
    try {
      repository.close();
      repositoryClosed = allDatabaseHandlesAccountedFor;
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
