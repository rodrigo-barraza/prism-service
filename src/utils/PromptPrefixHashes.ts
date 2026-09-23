/**
 * PromptPrefixHashes — fingerprints of the prompt a provider adapter
 * actually sent, so a prompt-cache miss can be attributed after the fact.
 *
 * Every adapter reshapes the harness messages before sending them
 * (Anthropic merges tool results into user turns, Gemini converts to
 * `contents`, the Responses API splits tool calls into input items), and
 * caching is decided on what reaches the provider. So each adapter hashes
 * its own payload just before send — system, tools, and one hash per
 * message — and yields the result as a `requestTelemetry` stream chunk
 * when the caller asked for it (`ProviderOptions.cacheTelemetry`).
 *
 * Hashes are SHA-256 (hex) over canonical JSON: object keys sorted,
 * `undefined` dropped, and `cache_control` markers removed — a breakpoint
 * marks where the cache is written, not what the prompt says, and it moves
 * to the newest message on every Anthropic request.
 */
import { createHash } from "node:crypto";

export interface PromptPrefixHashes {
  /** The system prompt as sent, or null when the request had none. */
  system: string | null;
  /** The tool definitions (with schemas) in the order sent, or null. */
  tools: string | null;
  /**
   * The same tool definitions in canonical (sorted) order. When `tools`
   * changed but `toolSet` did not, only the ORDER moved — still a cache
   * miss, but a different fix than a changed catalog.
   */
  toolSet: string | null;
  /** One hash per message (or Responses input item), in the order sent. */
  messages: string[];
}

/** Provider cache diagnostics, normalized across OpenAI and Anthropic. */
export interface ProviderCacheDiagnostics {
  source: "openai" | "anthropic";
  /**
   * `cache_hit`, `cache_miss`, `pending` (Anthropic answered before its
   * background comparison finished), `no_miss` (Anthropic returned
   * `diagnostics: null` — nothing to explain), `comparison_not_found` or
   * `unavailable`.
   */
  status: string;
  /** Provider reason for a miss, e.g. `tools_changed`, `input_changed`. */
  reason: string | null;
  /** Tokens the provider says it could not reuse, when reported. */
  missedTokens: number | null;
  /** The earlier response id the provider compared against. */
  comparedResponseId: string | null;
  /** The provider's own diagnostics object, verbatim. */
  raw: unknown;
}

/** One `requestTelemetry` stream chunk, yielded at the end of a stream. */
export interface RequestTelemetryChunk {
  type: "requestTelemetry";
  prefixHashes: PromptPrefixHashes | null;
  providerResponseId?: string;
  cacheDiagnostics?: ProviderCacheDiagnostics;
  /** Anthropic, with the thinking-binding beta: blocks the API dropped (empty = none). */
  inputTransformations?: unknown[];
}

/** Keys that mark cache breakpoints rather than prompt content. */
const CACHE_NEUTRAL_KEYS = new Set(["cache_control"]);

/** Roles that open a chat-style payload as its system prompt. */
const SYSTEM_ROLES = new Set(["system", "developer"]);

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  const withJson = value as { toJSON?: () => unknown };
  if (typeof withJson.toJSON === "function") {
    return canonicalize(withJson.toJSON());
  }
  if (Array.isArray(value)) {
    return value.map((item) => (item === undefined ? null : canonicalize(item)));
  }
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    if (CACHE_NEUTRAL_KEYS.has(key)) continue;
    const entry = (value as Record<string, unknown>)[key];
    if (entry === undefined || typeof entry === "function") continue;
    sorted[key] = canonicalize(entry);
  }
  return sorted;
}

/** Canonical JSON: sorted keys, no `undefined`, no cache breakpoints. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value)) ?? "null";
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function hashValue(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}

function isEmpty(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    value === "" ||
    (Array.isArray(value) && value.length === 0)
  );
}

/**
 * Hash the three cache-relevant sections of a provider payload.
 * `tools` must be a flat list with one entry per tool (Gemini callers
 * flatten `functionDeclarations`), so `toolSet` can tell a reorder from a
 * changed catalog. Never throws: telemetry must not fail a request.
 */
export function hashPromptPrefix({
  system,
  tools,
  messages,
}: {
  system?: unknown;
  tools?: unknown[] | null;
  messages?: unknown[] | null;
}): PromptPrefixHashes | null {
  try {
    const toolList = Array.isArray(tools) && tools.length > 0 ? tools : null;
    return {
      system: isEmpty(system) ? null : hashValue(system),
      tools: toolList ? hashValue(toolList) : null,
      toolSet: toolList
        ? sha256Hex(JSON.stringify(toolList.map(canonicalJson).sort()))
        : null,
      messages: (messages ?? []).map(hashValue),
    };
  } catch {
    return null;
  }
}

/**
 * Chat-style payloads (OpenAI, vLLM, llama.cpp, Kimi) carry the system
 * prompt as their leading message(s). Split those off so `system` and
 * `messages` mean the same thing on every provider.
 */
export function hashChatPrefix(
  chatMessages: unknown[] | null | undefined,
  tools: unknown[] | null | undefined,
  { roleKey = "role" }: { roleKey?: string } = {},
): PromptPrefixHashes | null {
  const list = Array.isArray(chatMessages) ? chatMessages : [];
  let leadingSystemCount = 0;
  while (
    leadingSystemCount < list.length &&
    SYSTEM_ROLES.has(
      String(
        (list[leadingSystemCount] as Record<string, unknown> | null)?.[roleKey],
      ),
    )
  ) {
    leadingSystemCount++;
  }
  return hashPromptPrefix({
    system: leadingSystemCount > 0 ? list.slice(0, leadingSystemCount) : null,
    tools: tools ?? null,
    messages: list.slice(leadingSystemCount),
  });
}

export function requestTelemetryChunk(
  prefixHashes: PromptPrefixHashes | null,
  extra: {
    providerResponseId?: string | null;
    cacheDiagnostics?: ProviderCacheDiagnostics | null;
    inputTransformations?: unknown[] | null;
  } = {},
): RequestTelemetryChunk {
  return {
    type: "requestTelemetry",
    prefixHashes,
    ...(extra.providerResponseId && {
      providerResponseId: extra.providerResponseId,
    }),
    ...(extra.cacheDiagnostics && { cacheDiagnostics: extra.cacheDiagnostics }),
    ...(Array.isArray(extra.inputTransformations) && {
      inputTransformations: extra.inputTransformations,
    }),
  };
}

// ── Provider diagnostics support (per process) ───────────────

/**
 * Models whose provider rejected the diagnostics field this process. A
 * rejected request is retried once without it (zero-chunk only), and the
 * model is not asked again until restart — telemetry never costs a turn.
 */
const diagnosticsRejected = new Set<string>();

export function isProviderDiagnosticsRejected(
  provider: string,
  model: string,
): boolean {
  return diagnosticsRejected.has(`${provider}:${model}`);
}

export function markProviderDiagnosticsRejected(
  provider: string,
  model: string,
): void {
  diagnosticsRejected.add(`${provider}:${model}`);
}

/** A 4xx whose message names the diagnostics field we added. */
export function isDiagnosticsRejection(
  error: unknown,
  fieldPatterns: RegExp,
): boolean {
  const record = error as { status?: number; message?: string } | null;
  const status = record?.status;
  if (typeof status === "number" && (status < 400 || status >= 500)) {
    return false;
  }
  const message =
    error instanceof Error ? error.message : String(record?.message ?? "");
  return fieldPatterns.test(message);
}

/** Test hook. */
export function _resetProviderDiagnosticsSupport(): void {
  diagnosticsRejected.clear();
}
