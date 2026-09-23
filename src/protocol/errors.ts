import { getErrorMessage } from "@rodrigo-barraza/utilities-library";
import { ProviderError } from "#src/utils/errors";
import {
  isTransientProviderError,
  parseContextOverflowError,
} from "#src/utils/ProviderStreamResilience";
import type { ErrorEvent, ProtocolErrorCode } from "./events.ts";

/**
 * The one place a thrown error becomes a protocol `error` event.
 *
 * Provider SDKs report the same failure in different shapes: Anthropic puts
 * `rate_limit_error` in `error.error.type`; OpenAI puts `rate_limit_exceeded`
 * in `code` and `insufficient_quota` in `type`; @google/genai only has an
 * HTTP status and a JSON body in `message` (`"status":"RESOURCE_EXHAUSTED"`);
 * the OpenAI-compatible runtimes (vLLM, SGLang, llama.cpp) send a status and
 * free text. Most of our providers also wrap the SDK error in a
 * `ProviderError(provider, message, 500, original)`, whose 500 is a
 * placeholder, not a response. So the facts are gathered from every layer of
 * the error (the wrapper, `originalError`, `cause`, the parsed body) before
 * any rule runs, and a real status from an inner layer beats the wrapper's.
 */

interface ErrorFacts {
  statuses: number[];
  types: string[];
  codes: string[];
  names: string[];
  text: string;
  provider?: string;
}

const MAXIMUM_LAYERS = 6;
const PRISM_SERVER_PROVIDER = "server";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function collectFacts(error: unknown): ErrorFacts {
  const facts: ErrorFacts = { statuses: [], types: [], codes: [], names: [], text: "" };
  const messages: string[] = [];
  const queue: unknown[] = [error];
  const seen = new Set<unknown>();

  while (queue.length && seen.size < MAXIMUM_LAYERS) {
    const layer = queue.shift();
    const record = asRecord(layer);
    if (!record || seen.has(record)) continue;
    seen.add(record);

    if (layer instanceof ProviderError) {
      // "server" marks Prism's own request validation, not a model provider.
      if (layer.provider !== PRISM_SERVER_PROVIDER) facts.provider ??= layer.provider;
      if (layer.errorType) facts.types.push(layer.errorType);
    }
    for (const key of ["status", "statusCode"]) {
      const status = record[key];
      if (typeof status === "number" && status >= 100 && status < 600) facts.statuses.push(status);
    }
    if (typeof record.type === "string") facts.types.push(record.type);
    if (typeof record.code === "string") facts.codes.push(record.code);
    if (typeof record.name === "string") facts.names.push(record.name);
    if (typeof record.message === "string") messages.push(record.message);

    queue.push(record.originalError, record.cause, record.error);
  }

  facts.text = messages.join("\n");
  return facts;
}

/** A status from the SDK layer beats the `ProviderError(…, 500, original)` placeholder. */
function mostSpecificStatus(statuses: number[]): number | undefined {
  return statuses.find((status) => status !== 500) ?? statuses[0];
}

const CONTEXT_OVERFLOW_TEXT =
  /prompt is too long|context[_ ]length[_ ]exceeded|exceeds? the (?:maximum number of tokens|context window)|input length and `?max_tokens`? exceed context limit|maximum context length/i;
const REFUSAL_TEXT =
  /\b(?:PROHIBITED_CONTENT|IMAGE_SAFETY|BLOCKLIST|SPII)\b|blocked (?:due to|for) safety|content[_ ]policy|content_filter/i;
const AUTH_TEXT = /\b(?:UNAUTHENTICATED|PERMISSION_DENIED)\b|api[_ ]key not valid|invalid[_ ]api[_ ]key|_API_KEY is not set/i;
const RATE_LIMIT_TEXT = /\bRESOURCE_EXHAUSTED\b|rate[_ ]limit|too many requests/i;
const QUOTA_TEXT = /insufficient[_ ]quota|billing|exceeded your current quota/i;
const OVERLOADED_TEXT = /\boverloaded\b|\bUNAVAILABLE\b/i;
const INVALID_REQUEST_TEXT = /\b(?:INVALID_ARGUMENT|NOT_FOUND|FAILED_PRECONDITION)\b/;

function classify(error: unknown, facts: ErrorFacts, status: number | undefined): {
  code: ProtocolErrorCode;
  retryable: boolean;
} {
  const has = (list: string[], ...values: string[]) => list.some((entry) => values.includes(entry));
  const isAbort = has(facts.names, "AbortError");

  if (
    parseContextOverflowError(error) ||
    has(facts.codes, "context_length_exceeded") ||
    CONTEXT_OVERFLOW_TEXT.test(facts.text)
  ) {
    return { code: "context_overflow", retryable: false };
  }
  if (has(facts.codes, "content_policy_violation", "content_filter") || REFUSAL_TEXT.test(facts.text)) {
    return { code: "refusal", retryable: false };
  }
  if (
    status === 401 ||
    status === 403 ||
    has(facts.types, "authentication_error", "permission_error") ||
    has(facts.codes, "invalid_api_key") ||
    AUTH_TEXT.test(facts.text)
  ) {
    return { code: "auth", retryable: false };
  }
  // A spent quota or an unpaid bill is a rate limit that waiting does not lift.
  if (
    status === 402 ||
    has(facts.types, "billing_error", "insufficient_quota") ||
    has(facts.codes, "insufficient_quota") ||
    (status === 429 && QUOTA_TEXT.test(facts.text))
  ) {
    return { code: "rate_limited", retryable: false };
  }
  if (
    status === 429 ||
    has(facts.types, "rate_limit_error") ||
    has(facts.codes, "rate_limit_exceeded") ||
    RATE_LIMIT_TEXT.test(facts.text)
  ) {
    return { code: "rate_limited", retryable: true };
  }
  if (status === 529 || status === 503 || has(facts.types, "overloaded_error") || OVERLOADED_TEXT.test(facts.text)) {
    return { code: "overloaded", retryable: true };
  }
  if (
    (status !== undefined && status >= 400 && status < 500 && status !== 408) ||
    has(facts.types, "invalid_request_error", "not_found_error") ||
    INVALID_REQUEST_TEXT.test(facts.text)
  ) {
    return { code: "invalid_request", retryable: false };
  }
  return { code: "internal", retryable: !isAbort && isTransientProviderError(error) };
}

export interface ErrorEventContext {
  /** The provider the turn was using, when the error does not name one. */
  provider?: string | null;
  /** Force the code when the call site knows better than the error (e.g. a tool). */
  code?: ProtocolErrorCode;
  /** The HTTP status that goes with a forced code (e.g. 409 for a turn already running). */
  status?: number;
  /** Override the message (defaults to the error's own). */
  message?: string;
}

/**
 * Build the protocol `error` event for a thrown error (or a bare message).
 * `provider` and `status` are included only when known.
 */
export function toErrorEvent(error: unknown, context: ErrorEventContext = {}): ErrorEvent {
  const facts = collectFacts(error);
  const status = context.status ?? mostSpecificStatus(facts.statuses);
  const classified = context.code
    ? { code: context.code, retryable: false }
    : classify(error, facts, status);
  const provider = facts.provider ?? context.provider ?? undefined;
  const message = context.message ?? (typeof error === "string" ? error : getErrorMessage(error));

  return {
    type: "error",
    code: classified.code,
    message: message || "Unknown error",
    retryable: classified.retryable,
    ...(provider ? { provider } : {}),
    ...(status !== undefined ? { status } : {}),
  };
}
