/**
 * Context Length Discovery — shared utility for self-hosted/local providers
 *
 * Queries the provider's model info endpoint to discover the model's
 * maximum context length at runtime, then caches the result for subsequent
 * calls. This enables clampOutputTokens to prevent context window overflow
 * on providers that don't have static model definitions in the registry
 * (vLLM, llama-cpp, Ollama).
 *
 * Each provider has a different API shape:
 *   - vLLM:     GET /v1/models → data[].max_model_len
 *   - llama-cpp: GET /props    → default_params.n_ctx
 *   - Ollama:   POST /api/show → model_info.context_length or parameters
 */
import logger from "./logger.ts";
import type { ProviderOptions } from "../types/provider.ts";

// ── Cache ────────────────────────────────────────────────────
// Maps "providerName:model" → context length (number)
const contextLengthCache = new Map<string, number>();

// Maps "providerName:model" → in-flight promise to dedup concurrent requests
const contextLengthInflight = new Map<string, Promise<number | null>>();

/**
 * Attempt to discover and cache the context window for a model,
 * then set `options._loadedContextLength` if not already set.
 *
 * Safe to call on every request — uses an in-memory cache and
 * deduplicates concurrent queries. If discovery fails (network
 * error, unsupported endpoint), silently returns without setting
 * the option so the clamp falls back to its existing behavior.
 */
export async function discoverContextLength(
  providerName: string,
  baseUrl: string,
  model: string,
  options: ProviderOptions,
): Promise<void> {
  // Already set (by a previous call or by the provider itself)
  if (options._loadedContextLength) return;

  const cacheKey = `${providerName}:${model}`;

  // Check cache first
  const cachedValue = contextLengthCache.get(cacheKey);
  if (cachedValue) {
    options._loadedContextLength = cachedValue;
    return;
  }

  // Deduplicate concurrent requests for the same model
  let inflightPromise = contextLengthInflight.get(cacheKey);
  if (!inflightPromise) {
    inflightPromise = queryContextLength(providerName, baseUrl, model);
    contextLengthInflight.set(cacheKey, inflightPromise);
  }

  try {
    const contextLength = await inflightPromise;
    if (contextLength && contextLength > 0) {
      contextLengthCache.set(cacheKey, contextLength);
      options._loadedContextLength = contextLength;
      logger.info(
        `[ContextDiscovery] ${providerName} model=${model} → contextLength=${contextLength}`,
      );
    }
  } catch {
    // Discovery is best-effort — don't block the request
    logger.warn(
      `[ContextDiscovery] Failed to discover context length for ${providerName}:${model}`,
    );
  } finally {
    contextLengthInflight.delete(cacheKey);
  }
}

/**
 * Query the provider-specific model info endpoint for context length.
 */
async function queryContextLength(
  providerName: string,
  baseUrl: string,
  model: string,
): Promise<number | null> {
  const normalizedProvider = providerName.toLowerCase();

  if (
    normalizedProvider.startsWith("vllm") ||
    normalizedProvider.includes("vllm")
  ) {
    return queryVllmContextLength(baseUrl, model);
  }
  if (
    normalizedProvider.includes("llama") ||
    normalizedProvider.includes("llama-cpp")
  ) {
    return queryLlamaCppContextLength(baseUrl);
  }
  if (normalizedProvider.includes("ollama")) {
    return queryOllamaContextLength(baseUrl, model);
  }

  // Unknown provider type — try vLLM-style /v1/models as a generic fallback
  // since many OpenAI-compatible servers support this endpoint
  return queryVllmContextLength(baseUrl, model);
}

// ── vLLM ─────────────────────────────────────────────────────
// GET /v1/models → { data: [{ id, max_model_len, ... }] }

/**
 * Pure parser for vLLM /v1/models response.
 * Exported for unit testing.
 */
export function parseVllmResponse(
  payload: any,
  model: string,
): number | null {
  if (!payload || !payload.data || !Array.isArray(payload.data)) return null;

  // Find the matching model entry.
  // Priority: exact match → substring match → first entry (single-model servers)
  const modelEntry =
    payload.data.find((entry: any) => entry.id === model) ||
    (model
      ? payload.data.find(
          (entry: any) =>
            model.includes(entry.id) || entry.id.includes(model),
        )
      : undefined) ||
    (payload.data.length === 1 ? payload.data[0] : undefined);

  return typeof modelEntry?.max_model_len === "number"
    ? modelEntry.max_model_len
    : null;
}

async function queryVllmContextLength(
  baseUrl: string,
  model: string,
): Promise<number | null> {
  try {
    const response = await fetch(`${baseUrl}/v1/models`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return null;

    const payload = await response.json();
    return parseVllmResponse(payload, model);
  } catch {
    return null;
  }
}

// ── llama-cpp ────────────────────────────────────────────────
// GET /props → { n_ctx: number } (top-level) or { default_params: { n_ctx: number } }
// Requires --props flag to be enabled on llama-server.
// Fallback: GET /v1/models (OpenAI-compat endpoint always available)

/**
 * Pure parser for llama-cpp /props response.
 * Exported for unit testing.
 */
export function parseLlamaCppResponse(payload: any): number | null {
  if (!payload) return null;
  const contextLength =
    payload.n_ctx ?? payload.default_params?.n_ctx ?? null;
  return typeof contextLength === "number" ? contextLength : null;
}

async function queryLlamaCppContextLength(
  baseUrl: string,
): Promise<number | null> {
  // Try /props first (most accurate, reports runtime context size)
  try {
    const propsResponse = await fetch(`${baseUrl}/props`, {
      signal: AbortSignal.timeout(5000),
    });
    if (propsResponse.ok) {
      const payload = await propsResponse.json();
      const contextLength = parseLlamaCppResponse(payload);
      if (contextLength) return contextLength;
    }
  } catch {
    // /props may not be enabled — fall through to /v1/models
  }

  // Fallback: /v1/models (always available on llama-server)
  return queryVllmContextLength(baseUrl, "");
}

// ── Ollama ───────────────────────────────────────────────────
// POST /api/show { name: model } → { model_info: { ... }, parameters: "..." }
// The context length is in model_info as a key containing "context_length"
// or in the parameters string as "num_ctx <number>"

/**
 * Pure parser for Ollama /api/show response.
 * Exported for unit testing.
 */
export function parseOllamaResponse(
  payload: any,
  model: string,
): number | null {
  if (!payload) return null;

  // Check model_info for context_length keys
  if (payload.model_info) {
    for (const [key, value] of Object.entries(payload.model_info)) {
      if (key.includes("context_length") && typeof value === "number") {
        return value;
      }
    }
  }

  // Parse the parameters string for num_ctx
  if (payload.parameters && typeof payload.parameters === "string") {
    const contextMatch = payload.parameters.match(/num_ctx\s+(\d+)/);
    if (contextMatch) {
      return parseInt(contextMatch[1], 10);
    }
  }

  return null;
}

async function queryOllamaContextLength(
  baseUrl: string,
  model: string,
): Promise<number | null> {
  try {
    const response = await fetch(`${baseUrl}/api/show`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: model }),
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return null;

    const payload = await response.json();
    return parseOllamaResponse(payload, model);
  } catch {
    return null;
  }
}
