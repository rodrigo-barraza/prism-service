/**
 * The retry policy's view of a failure goes through the wrapper every
 * adapter puts around it: `ProviderError(provider, message, 500, original)`.
 * The 500 is a placeholder, and the original error — not the wrapper —
 * carries the response's status and headers. Read only the wrapper and a
 * wrapped 400 is retried like a server fault, and the provider's Retry-After
 * is lost (the fault suite, tests/providerFaults.test.ts, found both over
 * HTTP; these pin the reading itself).
 */
import { describe, it, expect, vi } from "vitest";
import {
  computeRetryDelayMilliseconds,
  isTransientProviderError,
  streamEndedEarlyError,
  withIdleTimeout,
} from "#src/utils/ProviderStreamResilience";
import { ProviderError } from "#src/utils/errors";
import { toErrorEvent } from "#src/protocol/errors";

const httpError = (status: number, headers: Record<string, string> = {}) =>
  Object.assign(new Error(`API error: ${status}`), {
    status,
    headers: new Headers(headers),
  });
const wrap = (original: Error) =>
  new ProviderError("vllm", original.message, 500, original);

describe("isTransientProviderError reads through the 500 placeholder", () => {
  it("a wrapped 400 is not retried", () => {
    expect(isTransientProviderError(wrap(httpError(400)))).toBe(false);
  });

  it("a wrapped 429 and a wrapped 503 are", () => {
    expect(isTransientProviderError(wrap(httpError(429)))).toBe(true);
    expect(isTransientProviderError(wrap(httpError(503)))).toBe(true);
  });

  it("a wrapper around a status-less transport error keeps its own 500", () => {
    const terminated = Object.assign(new TypeError("terminated"), {
      cause: { code: "UND_ERR_SOCKET" },
    });
    expect(isTransientProviderError(wrap(terminated))).toBe(true);
  });
});

describe("computeRetryDelayMilliseconds honours the provider's Retry-After", () => {
  it("from the headers on the wrapped error", () => {
    const error = wrap(httpError(429, { "retry-after": "7" }));
    expect(computeRetryDelayMilliseconds(1, 1_000, error)).toBe(7_000);
  });

  it("from retry-after-ms, which the SDKs also send", () => {
    const error = wrap(httpError(429, { "retry-after-ms": "250" }));
    expect(computeRetryDelayMilliseconds(1, 1_000, error)).toBe(250);
  });

  it("from an HTTP-date", () => {
    const at = new Date(Date.now() + 5_000).toUTCString();
    const delay = computeRetryDelayMilliseconds(1, 1_000, wrap(httpError(503, { "retry-after": at })));
    expect(delay).toBeGreaterThan(3_000);
    expect(delay).toBeLessThanOrEqual(5_000);
  });

  it("from Gemini's RetryInfo, the only place @google/genai keeps it", () => {
    const body = JSON.stringify({
      error: {
        code: 429,
        status: "RESOURCE_EXHAUSTED",
        details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "17s" }],
      },
    });
    const sdkError = Object.assign(new Error(body), { status: 429 });
    const error = new ProviderError("google", body, 500, sdkError);
    expect(computeRetryDelayMilliseconds(1, 1_000, error)).toBe(17_000);
  });

  it("capped at a minute", () => {
    const error = wrap(httpError(429, { "retry-after": "3600" }));
    expect(computeRetryDelayMilliseconds(1, 1_000, error)).toBe(60_000);
  });

  it("without one: jittered exponential backoff", () => {
    const delay = computeRetryDelayMilliseconds(3, 1_000, wrap(httpError(503)));
    expect(delay).toBeGreaterThanOrEqual(2_000);
    expect(delay).toBeLessThanOrEqual(6_000);
  });
});

describe("streamEndedEarlyError", () => {
  it("is a transient 502 that names the provider", () => {
    const error = streamEndedEarlyError("anthropic", "no message_stop");
    expect(error.statusCode).toBe(502);
    expect(error.message).toBe(
      "The anthropic stream ended before the response completed (no message_stop)",
    );
    expect(isTransientProviderError(error)).toBe(true);
    expect(toErrorEvent(error)).toMatchObject({ retryable: true, status: 502 });
  });
});

describe("withIdleTimeout", () => {
  it("runs onStall once, before the stall error, so the caller can abort the request", async () => {
    const onStall = vi.fn();
    const stalled = (async function* () {
      yield "first";
      await new Promise(() => {});
    })();
    const seen: unknown[] = [];
    let caught: unknown;
    try {
      for await (const chunk of withIdleTimeout(stalled, 50, "test", onStall)) seen.push(chunk);
    } catch (error) {
      caught = error;
    }
    expect(seen).toEqual(["first"]);
    expect(onStall).toHaveBeenCalledTimes(1);
    expect(caught).toBeInstanceOf(ProviderError);
    expect((caught as ProviderError).statusCode).toBe(504);
  });

  it("a stream that keeps talking never stalls", async () => {
    const onStall = vi.fn();
    const talking = (async function* () {
      for (let index = 0; index < 5; index++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        yield index;
      }
    })();
    const seen: unknown[] = [];
    for await (const chunk of withIdleTimeout(talking, 200, "test", onStall)) seen.push(chunk);
    expect(seen).toEqual([0, 1, 2, 3, 4]);
    expect(onStall).not.toHaveBeenCalled();
  });
});
