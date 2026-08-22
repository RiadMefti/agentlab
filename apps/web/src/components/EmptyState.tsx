interface EmptyStateProps {
  readonly onCreate: () => void;
  readonly error?: string | null;
}

export function EmptyState({ onCreate, error = null }: EmptyStateProps) {
  if (error !== null) {
    return (
      <main className="empty-state">
        <div>
          <h1>Unable to connect.</h1>
          <p>{error}</p>
        </div>
      </main>
    );
  }

  return (
    <main className="empty-state">
      <div>
        <h1>One captain. The rest delegated.</h1>
        <p>Start with a task and choose who should supervise it.</p>
        <button type="button" className="text-action" onClick={onCreate}>
          New conversation
        </button>
      </div>
    </main>
  );
}
