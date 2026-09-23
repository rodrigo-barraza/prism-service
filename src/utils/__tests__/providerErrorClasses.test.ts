/**
 * Which provider errors are worth a retry. A 429 is not one thing: OpenAI's
 * `slow_down` (and a plain rate limit) clears with backoff, but a spend cap,
 * an exhausted credit balance or a usage limit stays until a human changes
 * a billing setting — retrying it only burns the turn's retry budget and
 * delays the error the user needs to see. A 503 `server_is_overloaded` is
 * transient.
 */
import { describe, it, expect } from "vitest";
import {
  isTransientProviderError,
  isTerminalQuotaError,
  streamWithRetries,
} from "#src/utils/ProviderStreamResilience";
import { ProviderError } from "#src/utils/errors";
import { classifyStopFailure } from "#src/services/harnesses/lifecycle/TurnHooks";

/** The shape the OpenAI SDK throws (APIError): status, code, type, error body. */
function openAIError(status: number, code: string | null, type: string | null, message: string) {
  return Object.assign(new Error(`${status} ${message}`), {
    status,
    code,
    type,
    error: { code, type, message },
  });
}

/** How openai.ts wraps it (toProviderError). */
function wrapped(status: number, code: string | null, type: string | null, message: string) {
  const original = openAIError(status, code, type, message);
  return new ProviderError("openai", original.message, status, original);
}

/** A Responses WebSocket `error` event, as the WS transport rethrows it. */
function webSocketErrorEvent(status: number, code: string, type: string) {
  return { type: "error", status, error: { type, code, message: code } };
}

const SPEND_CAP_CODES = [
  "insufficient_quota",
  "credit_balance_exhausted",
  "organization_spend_limit_exceeded",
  "project_spend_limit_exceeded",
  "organization_usage_limit_exceeded",
];

describe("provider error classes", () => {
  it.each(SPEND_CAP_CODES)("a %s 429 is terminal — never retried", (code) => {
    const error = wrapped(429, code, "insufficient_quota", "You exceeded your spend limit.");
    expect(isTerminalQuotaError(error)).toBe(true);
    expect(isTransientProviderError(error)).toBe(false);
    expect(isTransientProviderError(openAIError(429, code, null, "limit"))).toBe(false);
  });

  it("recognizes a spend cap arriving as a WebSocket error event", () => {
    const event = webSocketErrorEvent(429, "project_spend_limit_exceeded", "invalid_request_error");
    const error = new ProviderError("openai", "project_spend_limit_exceeded", 429, event);
    expect(isTerminalQuotaError(error)).toBe(true);
    expect(isTransientProviderError(error)).toBe(false);
  });

  it("keeps slow_down and plain rate limits retryable", () => {
    expect(isTransientProviderError(wrapped(429, "slow_down", "rate_limit_error", "Slow down"))).toBe(true);
    expect(isTransientProviderError(wrapped(429, "rate_limit_exceeded", "requests", "Rate limit reached"))).toBe(true);
    expect(isTerminalQuotaError(wrapped(429, "slow_down", "rate_limit_error", "Slow down"))).toBe(false);
  });

  it("keeps a 503 server_is_overloaded retryable", () => {
    expect(
      isTransientProviderError(
        wrapped(503, "server_is_overloaded", "service_unavailable_error", "Model temporarily overloaded"),
      ),
    ).toBe(true);
  });

  it("streamWithRetries surfaces a spend cap on the first attempt", async () => {
    let attempts = 0;
    const stream = streamWithRetries(
      () => {
        attempts++;
        throw wrapped(429, "organization_spend_limit_exceeded", null, "Spend limit reached");
      },
      { maxRetries: 3, baseDelayMilliseconds: 1, label: "openai" },
    );
    await expect(stream.next()).rejects.toMatchObject({ statusCode: 429 });
    expect(attempts).toBe(1);
  });

  it("streamWithRetries retries slow_down", async () => {
    let attempts = 0;
    const stream = streamWithRetries(
      async function* () {
        attempts++;
        if (attempts === 1) throw wrapped(429, "slow_down", "rate_limit_error", "Slow down");
        yield "ok";
      },
      { maxRetries: 3, baseDelayMilliseconds: 1, label: "openai" },
    );
    const chunks: string[] = [];
    for await (const chunk of stream) chunks.push(chunk);
    expect(chunks).toEqual(["ok"]);
    expect(attempts).toBe(2);
  });

  it("a StopFailure hook sees a spend cap as billing_error, slow_down as rate_limit", () => {
    expect(classifyStopFailure(wrapped(429, "credit_balance_exhausted", null, "No credit"))).toBe(
      "billing_error",
    );
    expect(classifyStopFailure(wrapped(429, "slow_down", "rate_limit_error", "Slow down"))).toBe(
      "rate_limit",
    );
  });
});
