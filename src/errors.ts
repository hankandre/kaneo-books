export class AppError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function asAppError(error: unknown, code = "unexpected_error"): AppError {
  return error instanceof AppError ? error : new AppError(code, errorMessage(error), error);
}
