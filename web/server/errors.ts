export class WebError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: Record<string, unknown>;

  constructor(code: string, message: string, status = 400, details?: Record<string, unknown>) {
    super(message);
    this.name = "WebError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export function asWebError(error: unknown): WebError {
  if (error instanceof WebError) return error;
  return new WebError("INTERNAL_ERROR", error instanceof Error ? error.message : String(error), 500);
}
