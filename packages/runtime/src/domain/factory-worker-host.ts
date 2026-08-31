export interface FactoryWorkerHostInspection {
  readonly status: "ready" | "blocked";
  readonly reasonCodes: readonly string[];
}

/** Read-only local host inspection; it grants no task, scheduler, or remote authority. */
export interface FactoryWorkerHostInspector {
  inspect(): Promise<FactoryWorkerHostInspection>;
}
