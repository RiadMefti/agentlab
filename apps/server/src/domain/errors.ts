export class ApplicationError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode: number,
    public readonly details?: unknown
  ) {
    super(message);
    this.name = "ApplicationError";
  }
}

export class NotFoundError extends ApplicationError {
  public constructor(message: string) {
    super("NOT_FOUND", message, 404);
    this.name = "NotFoundError";
  }
}

export class ConflictError extends ApplicationError {
  public constructor(message: string) {
    super("CONFLICT", message, 409);
    this.name = "ConflictError";
  }
}

export class ProviderUnavailableError extends ApplicationError {
  public constructor(message: string) {
    super("PROVIDER_UNAVAILABLE", message, 503);
    this.name = "ProviderUnavailableError";
  }
}
