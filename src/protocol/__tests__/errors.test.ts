/**
 * errors.test.ts — every provider failure becomes one typed `error` event.
 *
 * The errors are built with the real SDK error classes and wrapped the way
 * our providers wrap them (`ProviderError(provider, message, status|500,
 * original)`), because the wrapping is where the facts used to get lost:
 * the Google and local providers put a placeholder 500 on top of a real 429.
 */
import { describe, it, expect } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { ApiError } from "@google/genai";
import { ProviderError } from "#src/utils/errors";
import { toErrorEvent } from "#src/protocol/errors";
import { validateTurnEvent, type ErrorEvent } from "#src/protocol/events";

function anthropicError(status: number, type: string, message: string) {
  const sdkError = Anthropic.APIError.generate(
    status,
    { type: "error", error: { type, message } },
    undefined,
    new Headers(),
  );
  // anthropic.ts: ProviderError("anthropic", message, error.status || 500, error)
  return new ProviderError("anthropic", sdkError.message, sdkError.status || 500, sdkError);
}

function openAIError(status: number, body: { message: string; type: string; code: string | null }) {
  const sdkError = OpenAI.APIError.generate(status, { error: body }, undefined, new Headers());
  // openai.ts toProviderError: keeps the status.
  return new ProviderError("openai", sdkError.message, sdkError.status ?? 500, sdkError);
}

function googleError(status: number, rpcStatus: string, message: string) {
  const sdkError = new ApiError({
    message: JSON.stringify({ error: { code: status, message, status: rpcStatus } }),
    status,
  });
  // google.ts: ProviderError("google", message, 500, error) — the 500 is a placeholder.
  return new ProviderError("google", sdkError.message, 500, sdkError);
}

function localError(provider: string, status: number, message: string) {
  // openai-compat throws an Error carrying the HTTP status; vllm.ts wraps it as 500.
  const fetchError = Object.assign(new Error(message), { status });
  return new ProviderError(provider, message, 500, fetchError);
}

type Expectation = Pick<ErrorEvent, "code" | "retryable"> & Partial<Pick<ErrorEvent, "provider" | "status">>;

const CASES: Array<[string, () => unknown, Expectation]> = [
  [
    "Anthropic 429 rate_limit_error",
    () => anthropicError(429, "rate_limit_error", "Number of request tokens has exceeded your per-minute rate limit"),
    { code: "rate_limited", retryable: true, provider: "anthropic", status: 429 },
  ],
  [
    "Anthropic 529 overloaded_error",
    () => anthropicError(529, "overloaded_error", "Overloaded"),
    { code: "overloaded", retryable: true, provider: "anthropic", status: 529 },
  ],
  [
    "Anthropic 400 prompt is too long",
    () => anthropicError(400, "invalid_request_error", "prompt is too long: 213000 tokens > 200000 maximum"),
    { code: "context_overflow", retryable: false, provider: "anthropic", status: 400 },
  ],
  [
    "Anthropic 401 authentication_error",
    () => anthropicError(401, "authentication_error", "invalid x-api-key"),
    { code: "auth", retryable: false, provider: "anthropic", status: 401 },
  ],
  [
    "Anthropic 400 invalid_request_error",
    () => anthropicError(400, "invalid_request_error", "messages.1.content: field required"),
    { code: "invalid_request", retryable: false, provider: "anthropic", status: 400 },
  ],
  [
    "Anthropic 500 api_error",
    () => anthropicError(500, "api_error", "Internal server error"),
    { code: "internal", retryable: true, provider: "anthropic", status: 500 },
  ],
  [
    "OpenAI 429 rate_limit_exceeded",
    () => openAIError(429, { message: "Rate limit reached for gpt-6 in organization", type: "requests", code: "rate_limit_exceeded" }),
    { code: "rate_limited", retryable: true, provider: "openai", status: 429 },
  ],
  [
    "OpenAI 429 insufficient_quota (waiting does not help)",
    () =>
      openAIError(429, {
        message: "You exceeded your current quota, please check your plan and billing details.",
        type: "insufficient_quota",
        code: "insufficient_quota",
      }),
    { code: "rate_limited", retryable: false, provider: "openai", status: 429 },
  ],
  [
    "OpenAI 400 context_length_exceeded",
    () =>
      openAIError(400, {
        message: "This model's maximum context length is 128000 tokens. However, your messages resulted in 130000 tokens.",
        type: "invalid_request_error",
        code: "context_length_exceeded",
      }),
    { code: "context_overflow", retryable: false, provider: "openai", status: 400 },
  ],
  [
    "OpenAI 400 content_policy_violation",
    () =>
      openAIError(400, {
        message: "Your request was rejected as a result of our safety system.",
        type: "invalid_request_error",
        code: "content_policy_violation",
      }),
    { code: "refusal", retryable: false, provider: "openai", status: 400 },
  ],
  [
    "OpenAI 401 invalid_api_key",
    () => openAIError(401, { message: "Incorrect API key provided", type: "invalid_request_error", code: "invalid_api_key" }),
    { code: "auth", retryable: false, provider: "openai", status: 401 },
  ],
  [
    "Google 429 RESOURCE_EXHAUSTED under a 500 wrapper",
    () => googleError(429, "RESOURCE_EXHAUSTED", "Resource has been exhausted (e.g. check quota)."),
    { code: "rate_limited", retryable: true, provider: "google", status: 429 },
  ],
  [
    "Google 503 UNAVAILABLE (model overloaded)",
    () => googleError(503, "UNAVAILABLE", "The model is overloaded. Please try again later."),
    { code: "overloaded", retryable: true, provider: "google", status: 503 },
  ],
  [
    "Google 400 input token count over the window",
    () =>
      googleError(
        400,
        "INVALID_ARGUMENT",
        "The input token count (1234567) exceeds the maximum number of tokens allowed (1048576).",
      ),
    { code: "context_overflow", retryable: false, provider: "google", status: 400 },
  ],
  [
    "Google 403 PERMISSION_DENIED",
    () => googleError(403, "PERMISSION_DENIED", "Method doesn't allow unregistered callers."),
    { code: "auth", retryable: false, provider: "google", status: 403 },
  ],
  [
    "Google PROHIBITED_CONTENT block",
    () => new ProviderError("google", "Response blocked: PROHIBITED_CONTENT", 500),
    { code: "refusal", retryable: false, provider: "google", status: 500 },
  ],
  [
    "vLLM context overflow (400 under a 500 wrapper)",
    () =>
      localError(
        "vllm-2",
        400,
        "This model's maximum context length is 90000 tokens. However, you requested 58082 output tokens and your prompt contains at least 31919 input tokens.",
      ),
    { code: "context_overflow", retryable: false, provider: "vllm-2", status: 400 },
  ],
  [
    "llama.cpp connection refused",
    () =>
      new ProviderError(
        "llama-cpp",
        "fetch failed",
        500,
        Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } }),
      ),
    { code: "internal", retryable: true, provider: "llama-cpp", status: 500 },
  ],
  [
    "A stalled provider stream (504)",
    () => new ProviderError("anthropic", "Provider stream stalled: no chunk for 120s", 504),
    { code: "internal", retryable: true, provider: "anthropic", status: 504 },
  ],
  [
    "Prism's own validation (provider \"server\" is not a model provider)",
    () => new ProviderError("server", "Missing required field: provider", 400),
    { code: "invalid_request", retryable: false, status: 400 },
  ],
  [
    "A plain bug",
    () => new TypeError("Cannot read properties of undefined (reading 'content')"),
    { code: "internal", retryable: false },
  ],
];

describe("toErrorEvent maps every provider failure in one place", () => {
  it.each(CASES)("%s", (_name, build, expected) => {
    const event = toErrorEvent(build());
    expect(validateTurnEvent(event).success).toBe(true);
    expect(event).toMatchObject(expected);
    if (!("provider" in expected)) expect(event).not.toHaveProperty("provider");
    if (!("status" in expected)) expect(event).not.toHaveProperty("status");
  });

  it("keeps the provider the call site knows when the error does not name one", () => {
    expect(toErrorEvent(new Error("socket hang up"), { provider: "anthropic" })).toMatchObject({
      code: "internal",
      retryable: true,
      provider: "anthropic",
    });
  });

  it("never retries a deliberate abort", () => {
    const abort = Object.assign(new Error("This operation was aborted"), { name: "AbortError" });
    expect(toErrorEvent(abort)).toMatchObject({ code: "internal", retryable: false });
  });

  it("lets the call site force the code and status", () => {
    expect(
      toErrorEvent("A generation is already running for this conversation.", {
        code: "invalid_request",
        status: 409,
      }),
    ).toEqual({
      type: "error",
      code: "invalid_request",
      message: "A generation is already running for this conversation.",
      retryable: false,
      status: 409,
    });
  });
});
