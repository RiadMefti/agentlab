/** A spawned or opened runtime resource whose shutdown must be positively confirmed. */
export interface ManagedRuntimeResource {
  closeAndWait(): Promise<void>;
}

/** Retains fallibly constructed resources until their adapters confirm cleanup. */
export interface ManagedRuntimeResourceOwner {
  track(resource: ManagedRuntimeResource): void;
  release(resource: ManagedRuntimeResource): void;
}
