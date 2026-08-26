/** Expected application failure safe to present at a user boundary. */
export class ApplicationError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
    public readonly details?: unknown
  ) {
    super(message);
    this.name = "ApplicationError";
  }
}

export class NotFoundError extends ApplicationError {
  public constructor(message: string) {
    super("NOT_FOUND", message);
    this.name = "NotFoundError";
  }
}

export class ConflictError extends ApplicationError {
  public constructor(message: string) {
    super("CONFLICT", message);
    this.name = "ConflictError";
  }
}

export class ProviderUnavailableError extends ApplicationError {
  public constructor(message: string) {
    super("PROVIDER_UNAVAILABLE", message);
    this.name = "ProviderUnavailableError";
  }
}
