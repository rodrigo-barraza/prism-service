import type { Request, Response, NextFunction } from "express";
import logger from "./logger.ts";

export class ProviderError extends Error {
  provider: string;
  statusCode: number;
  originalError: Error | object | null | undefined;
  errorType: string | null;
  /** Protocol error code, when the error came from a turn stream's `error` event. */
  code?: string;
  /** Whether sending the same request again later may succeed (with `code`). */
  retryable?: boolean;

  constructor(
    provider: string,
    message: string,
    statusCode: number = 500,
    originalError: Error | object | null | undefined = null,
  ) {
    super(message);
    this.name = "ProviderError";
    this.provider = provider;
    this.statusCode = statusCode;
    this.originalError = originalError;
    // Structured error type from provider SDKs (e.g. Anthropic's "rate_limit_error")
    this.errorType =
      ((originalError as Record<string, unknown> | null)?.type as
        | string
        | null) ?? null;
  }

  toJSON() {
    return {
      error: true,
      provider: this.provider,
      message: this.message,
      statusCode: this.statusCode,
      ...(this.errorType && { errorType: this.errorType }),
      ...(this.code && { code: this.code, retryable: this.retryable ?? false }),
    };
  }
}

export function errorHandler(
  error: ProviderError | Error,
  _req: Request,
  res: Response,
  _next: NextFunction,
) {
  const provider = error instanceof ProviderError ? error.provider : "Server";
  logger.error(`${provider}: ${error.message}`);

  if (error instanceof ProviderError) {
    return res.status(error.statusCode).json(error.toJSON());
  }

  return res.status(500).json({
    error: true,
    message: error.message || "Internal server error",
    statusCode: 500,
  });
}
