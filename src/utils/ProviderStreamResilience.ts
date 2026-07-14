import { getErrorMessage } from "@rodrigo-barraza/utilities-library";
import logger from "./logger.ts";
import { ProviderError } from "./errors.ts";
import { HARNESS } from "#src/constants";

/**
 * ProviderStreamResilience — shared transient-error retry and stall-watchdog
 * wrappers for provider streams.
 *
 * Applied at the harness level (BaseAgenticHarness.createProviderStream /
 * consumeStream) so EVERY provider gets the same behavior — previously only
 * Anthropic retried (overloaded-only, fixed delay, no jitter) and the
 * fetch-based providers (Ollama, vLLM, llama-cpp, LM Studio) had no transient
 * retry and no idle timeout at all: a provider that stalled without closing
 * the socket hung the turn forever.
 */

const RETRYABLE_STATUS_CODES = new Set([408, 429, 500, 502, 503, 504, 529]);

const RETRYABLE_ERROR_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EPIPE",
  "EAI_AGAIN",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
]);

const RETRYABLE_ERROR_TYPES = new Set([
  "overloaded_error",
  "api_error",
  "rate_limit_error",
]);

/** Classify an error as a transient provider failure worth retrying. */
export function isTransientProviderError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const errorRecord = error as Record<string, unknown>;

  // Deliberate aborts are never retryable
  if (errorRecord.name === "AbortError") return false;

  const statusCode =
    error instanceof ProviderError
      ? error.statusCode
      : ((errorRecord.status ?? errorRecord.statusCode) as number | undefined);
  if (typeof statusCode === "number" && RETRYABLE_STATUS_CODES.has(statusCode))
    return true;

  const errorType =
    error instanceof ProviderError
      ? error.errorType
      : ((errorRecord.type ??
          (errorRecord.error as Record<string, unknown> | undefined)
            ?.type) as string | undefined);
  if (typeof errorType === "string" && RETRYABLE_ERROR_TYPES.has(errorType))
    return true;

  // Node/undici network errors (also nested under cause for fetch failures)
  const code = (errorRecord.code ??
    (errorRecord.cause as Record<string, unknown> | undefined)?.code) as
    | string
    | undefined;
  if (typeof code === "string" && RETRYABLE_ERROR_CODES.has(code)) return true;

  const message = String(errorRecord.message || "");
  if (/fetch failed|socket hang up|network|terminated/i.test(message))
    return true;

  // Wrapped provider errors: inspect the original error one level down
  if (error instanceof ProviderError && error.originalError) {
    return isTransientProviderError(error.originalError);
  }

  return false;
}

/** Exponential backoff with full jitter, honoring a provider Retry-After when present. */
export function computeRetryDelayMilliseconds(
  attempt: number,
  baseDelayMilliseconds: number,
  error?: unknown,
): number {
  const retryAfterSeconds = extractRetryAfterSeconds(error);
  if (retryAfterSeconds != null) {
    return Math.min(retryAfterSeconds * 1000, 60_000);
  }
  const exponential = baseDelayMilliseconds * 2 ** (attempt - 1);
  const capped = Math.min(exponential, 30_000);
  // Full jitter: [0.5x, 1.5x]
  return Math.round(capped * (0.5 + Math.random()));
}

function extractRetryAfterSeconds(error: unknown): number | null {
  if (!error || typeof error !== "object") return null;
  const headers = (error as { headers?: unknown }).headers as
    | Record<string, string>
    | Map<string, string>
    | { get?: (name: string) => string | null }
    | undefined;
  if (!headers) return null;
  let raw: string | null | undefined;
  if (typeof (headers as { get?: unknown }).get === "function") {
    raw = (headers as { get: (name: string) => string | null }).get(
      "retry-after",
    );
  } else {
    raw = (headers as Record<string, string>)["retry-after"];
  }
  if (!raw) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export interface StreamRetryOptions {
  /** Max retry attempts after the initial try. */
  maxRetries?: number;
  /** Base backoff delay (exponential with jitter). */
  baseDelayMilliseconds?: number;
  /** Abort signal — no retries are attempted once aborted. */
  signal?: AbortSignal | null;
  /** Label for log lines (e.g. provider name). */
  label?: string;
}

/**
 * Wrap a stream factory with transient-error retries.
 *
 * CRITICAL INVARIANT: a retry is only attempted when ZERO chunks have been
 * yielded. Once any chunk reached the consumer, retrying would replay text
 * the user already saw and re-emit tool calls that would then EXECUTE TWICE.
 * Mid-stream failures surface as errors instead.
 */
export async function* streamWithRetries<T>(
  createStream: () => AsyncIterable<T> | Promise<AsyncIterable<T>>,
  {
    maxRetries = HARNESS.PROVIDER_STREAM_MAX_RETRIES,
    baseDelayMilliseconds = HARNESS.PROVIDER_STREAM_RETRY_BASE_MILLISECONDS,
    signal,
    label = "provider",
  }: StreamRetryOptions = {},
): AsyncGenerator<T> {
  for (let attempt = 1; ; attempt++) {
    let hasYieldedAnyChunk = false;
    try {
      const stream = await createStream();
      for await (const chunk of stream) {
        hasYieldedAnyChunk = true;
        yield chunk;
      }
      return;
    } catch (error: unknown) {
      const isRetryable =
        !hasYieldedAnyChunk &&
        !signal?.aborted &&
        attempt <= maxRetries &&
        isTransientProviderError(error);
      if (!isRetryable) throw error;

      const delayMilliseconds = computeRetryDelayMilliseconds(
        attempt,
        baseDelayMilliseconds,
        error,
      );
      logger.warn(
        `[StreamRetry] Transient ${label} error on attempt ${attempt}/${maxRetries + 1} ` +
          `(${getErrorMessage(error)}). ` +
          `Retrying in ${Math.round(delayMilliseconds / 100) / 10}s...`,
      );
      await new Promise((resolve) => setTimeout(resolve, delayMilliseconds));
    }
  }
}

/**
 * Chunk-idle watchdog: throws if no chunk arrives within
 * `idleTimeoutMilliseconds`. Guards against providers that stall without
 * closing the socket — previously such a stall hung the turn until the
 * 2-hour housekeeping sweep.
 */
export async function* withIdleTimeout<T>(
  stream: AsyncIterable<T>,
  idleTimeoutMilliseconds: number = HARNESS.STREAM_IDLE_TIMEOUT_MILLISECONDS,
  label = "provider",
): AsyncGenerator<T> {
  const iterator = stream[Symbol.asyncIterator]();
  const STALLED = Symbol("stalled");
  try {
    while (true) {
      let timeoutId: NodeJS.Timeout | undefined;
      const nextPromise = iterator.next();
      const result = await Promise.race([
        nextPromise,
        new Promise<typeof STALLED>((resolve) => {
          timeoutId = setTimeout(() => resolve(STALLED), idleTimeoutMilliseconds);
        }),
      ]).finally(() => {
        if (timeoutId) clearTimeout(timeoutId);
      });

      if (result === STALLED) {
        // The abandoned next() promise may still reject long after we throw
        // (e.g. the user's stop aborts the underlying fetch). Without a
        // rejection handler that becomes an unhandled rejection and kills
        // the process, wiping every in-flight turn.
        nextPromise.catch(() => {
          /* abandoned after stall — rejection is expected on teardown */
        });
        logger.error(
          `[StreamWatchdog] ${label} stream produced no chunk for ${Math.round(idleTimeoutMilliseconds / 1000)}s — aborting pass.`,
        );
        throw new ProviderError(
          label,
          `Provider stream stalled: no data received for ${Math.round(idleTimeoutMilliseconds / 1000)}s`,
          504,
        );
      }
      if (result.done) return;
      yield result.value;
    }
  } finally {
    // Tear down the underlying stream on early exit (stall, consumer break).
    // Fire-and-forget: a STALLED stream's return() may itself never resolve
    // (the generator is stuck mid-await), and awaiting it would hang the
    // very path that exists to escape the hang.
    if (typeof iterator.return === "function") {
      try {
        void Promise.resolve(iterator.return(undefined)).catch(() => {
          /* stream teardown is best-effort */
        });
      } catch {
        /* stream teardown is best-effort */
      }
    }
  }
}
