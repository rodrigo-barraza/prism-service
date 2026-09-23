/**
 * CostCalculator — token estimation and cost calculation utilities.
 *
 * Centralises pricing logic across all provider types:
 * text-to-text, audio-to-text, live API sessions, and image generation.
 */

import type { TokenUsage, ModelTokenUsage } from "#src/types/admin";
import { getModelByName } from "#src/config";

// ── Pricing interfaces ──────────────────────────────────────

export interface TextPricing {
  inputPerMillion?: number;
  outputPerMillion?: number;
  cachedInputPerMillion?: number;
  cacheWriteInputPerMillion?: number;
  /** Cache writes at a 1-hour TTL, where the provider prices them apart. */
  cacheWrite1hInputPerMillion?: number;
  /** A request whose prompt passed LONG_CONTEXT_THRESHOLD_TOKENS bills whole at these (OpenAI). */
  inputOver272kPerMillion?: number;
  cachedInputOver272kPerMillion?: number;
  cacheWriteInputOver272kPerMillion?: number;
  outputOver272kPerMillion?: number;
}

/** Prompt size past which a model with `…Over272kPerMillion` prices bills the whole request at them. */
export const LONG_CONTEXT_THRESHOLD_TOKENS = 272_000;

export interface AudioPricing extends TextPricing {
  perMinute?: number;
  audioInputPerMillion?: number;
  audioOutputPerMillion?: number;
}

export interface ImagePricing extends TextPricing {
  imageInputPerMillion?: number;
  imageOutputPerMillion?: number;
}

// ── Token estimation ────────────────────────────────────────

/**
 * Estimate token count from a text string using the ~4 chars/token heuristic.
 * Accurate enough for budget enforcement without requiring a real tokenizer.
 */
export function estimateTokens(text: string | null | undefined): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

/**
 * Get the total input token count from a usage object.
 * Providers like Anthropic and Google split prompt tokens into
 * new + cache_read + cache_write. This aggregates all three.
 */
export function getTotalInputTokens(
  usage: TokenUsage | null | undefined,
): number {
  if (!usage) return 0;
  return (
    (usage.inputTokens || 0) +
    (usage.cacheReadInputTokens || 0) +
    (usage.cacheCreationInputTokens || 0)
  );
}

/**
 * Return a copy of the usage object with an authoritative, pre-summed
 * `totalInputTokens` field attached. This is the server's single source of
 * truth for prompt-token composition — the client renders `totalInputTokens`
 * directly instead of re-deriving the split (new + cache_read + cache_write),
 * so adding a future cache bucket never silently diverges the two.
 *
 * Applied at every usage emission/persistence boundary (SSE usage_update /
 * done payloads, persisted request-log usage).
 */
export function withTotalInputTokens<T extends TokenUsage>(
  usage: T | null | undefined,
): (T & { totalInputTokens: number }) | null | undefined {
  if (!usage) return usage as null | undefined;
  return { ...usage, totalInputTokens: getTotalInputTokens(usage) };
}

export function createUsageAccumulator(): Required<
  Omit<
    TokenUsage,
    "totalTokens" | "totalInputTokens" | "byModel" | "cacheCreation1hInputTokens" | "longContext"
  >
> {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    reasoningOutputTokens: 0,
    tokensPerSec: 0,
  };
}

/**
 * Merge a provider-reported usage chunk into an accumulator (mutates target).
 * Centralises the `target.X += source.X || 0` pattern that was duplicated
 * across AgenticLoopService, chat.js, and StreamChunkDispatcher.
 */
export function mergeUsage(
  target:
    | Required<Omit<TokenUsage, "totalTokens" | "byModel" | "cacheCreation1hInputTokens" | "longContext">>
    | TokenUsage,
  source: TokenUsage | null | undefined,
):
  | Required<Omit<TokenUsage, "totalTokens" | "byModel" | "cacheCreation1hInputTokens" | "longContext">>
  | TokenUsage {
  if (!source) return target;
  target.inputTokens = (target.inputTokens ?? 0) + (source.inputTokens || 0);
  target.outputTokens = (target.outputTokens ?? 0) + (source.outputTokens || 0);
  target.cacheReadInputTokens =
    (target.cacheReadInputTokens ?? 0) + (source.cacheReadInputTokens || 0);
  target.cacheCreationInputTokens =
    (target.cacheCreationInputTokens ?? 0) +
    (source.cacheCreationInputTokens || 0);
  target.reasoningOutputTokens =
    (target.reasoningOutputTokens ?? 0) + (source.reasoningOutputTokens || 0);
  if (source.longContext) {
    const longTarget = target as TokenUsage;
    const long = (longTarget.longContext ??= {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    });
    long.inputTokens += source.longContext.inputTokens || 0;
    long.outputTokens += source.longContext.outputTokens || 0;
    long.cacheReadInputTokens += source.longContext.cacheReadInputTokens || 0;
    long.cacheCreationInputTokens += source.longContext.cacheCreationInputTokens || 0;
  }
  if (source.cacheCreation1hInputTokens) {
    const oneHourTarget = target as TokenUsage;
    oneHourTarget.cacheCreation1hInputTokens =
      (oneHourTarget.cacheCreation1hInputTokens ?? 0) + source.cacheCreation1hInputTokens;
  }
  if (source.tokensPerSec != null) {
    target.tokensPerSec = source.tokensPerSec;
  }
  if (source.byModel) {
    // Accumulators are typed without byModel (RequestLogger's usage type is
    // numeric-only); the split still rides along for calculateTextCost.
    const splitTarget = target as TokenUsage;
    const byModel = (splitTarget.byModel ??= {});
    for (const [model, part] of Object.entries(source.byModel)) {
      const existing = (byModel[model] ??= {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      });
      existing.inputTokens += part.inputTokens || 0;
      existing.outputTokens += part.outputTokens || 0;
      existing.cacheReadInputTokens += part.cacheReadInputTokens || 0;
      existing.cacheCreationInputTokens += part.cacheCreationInputTokens || 0;
    }
  }
  return target;
}

// ── Cost calculation ────────────────────────────────────────

/**
 * Calculate the estimated cost for a text-to-text request.
 * Supports Anthropic prompt caching: cache reads at reduced rate,
 * cache writes at premium rate.
 */
export function calculateTextCost(
  usage: TokenUsage | null | undefined,
  pricing: TextPricing | null | undefined,
): number | null {
  if (!pricing || !usage) return null;

  // Tokens another model produced (server-side fallback) bill at that
  // model's rates; only the remainder bills at the requested model's.
  if (usage.byModel && Object.keys(usage.byModel).length > 0) {
    const remainder: ModelTokenUsage = {
      inputTokens: usage.inputTokens || 0,
      outputTokens: usage.outputTokens || 0,
      cacheReadInputTokens: usage.cacheReadInputTokens || 0,
      cacheCreationInputTokens: usage.cacheCreationInputTokens || 0,
    };
    let splitCost = 0;
    for (const [model, part] of Object.entries(usage.byModel)) {
      const modelPricing =
        ((getModelByName(model) as { pricing?: TextPricing } | null)
          ?.pricing as TextPricing | undefined) ?? pricing;
      splitCost += calculateTextCost(part, modelPricing) ?? 0;
      remainder.inputTokens -= part.inputTokens || 0;
      remainder.outputTokens -= part.outputTokens || 0;
      remainder.cacheReadInputTokens -= part.cacheReadInputTokens || 0;
      remainder.cacheCreationInputTokens -= part.cacheCreationInputTokens || 0;
    }
    for (const key of Object.keys(remainder) as Array<keyof ModelTokenUsage>) {
      remainder[key] = Math.max(0, remainder[key]);
    }
    splitCost += calculateTextCost(remainder, pricing) ?? 0;
    return parseFloat(splitCost.toFixed(8));
  }

  // Requests past the long-context threshold bill at the long-context
  // rates; the rest of the counts at the base ones.
  if (usage.longContext && pricing.inputOver272kPerMillion) {
    const long = usage.longContext;
    const rest: TokenUsage = {
      inputTokens: Math.max(0, (usage.inputTokens || 0) - long.inputTokens),
      outputTokens: Math.max(0, (usage.outputTokens || 0) - long.outputTokens),
      cacheReadInputTokens: Math.max(0, (usage.cacheReadInputTokens || 0) - long.cacheReadInputTokens),
      cacheCreationInputTokens: Math.max(
        0,
        (usage.cacheCreationInputTokens || 0) - long.cacheCreationInputTokens,
      ),
    };
    return parseFloat(
      ((calculateTextCost(rest, pricing) ?? 0) +
        (calculateTextCost(long, longContextPricing(pricing)) ?? 0)).toFixed(8),
    );
  }

  let cost =
    ((usage.inputTokens || 0) / 1_000_000) * (pricing.inputPerMillion || 0) +
    ((usage.outputTokens || 0) / 1_000_000) * (pricing.outputPerMillion || 0);

  // Cache read tokens (Anthropic: 0.1x base rate)
  if (usage.cacheReadInputTokens && pricing.cachedInputPerMillion) {
    cost +=
      (usage.cacheReadInputTokens / 1_000_000) * pricing.cachedInputPerMillion;
  }

  // Cache write tokens (Anthropic: 1.25x base rate); the 1-hour part at its
  // own rate where the model has one (Kimi K3: 2x base).
  if (usage.cacheCreationInputTokens && pricing.cacheWriteInputPerMillion) {
    const oneHour = Math.min(
      usage.cacheCreation1hInputTokens || 0,
      usage.cacheCreationInputTokens,
    );
    cost +=
      ((usage.cacheCreationInputTokens - oneHour) / 1_000_000) *
        pricing.cacheWriteInputPerMillion +
      (oneHour / 1_000_000) *
        (pricing.cacheWrite1hInputPerMillion ?? pricing.cacheWriteInputPerMillion);
  }

  return parseFloat(cost.toFixed(8));
}

/**
 * The long-context rates. A bucket without its own long-context price moves
 * with the input price (OpenAI raises every input bucket by one multiplier).
 */
function longContextPricing(pricing: TextPricing): TextPricing {
  const inputRatio = pricing.inputPerMillion
    ? pricing.inputOver272kPerMillion! / pricing.inputPerMillion
    : 1;
  return {
    inputPerMillion: pricing.inputOver272kPerMillion,
    outputPerMillion: pricing.outputOver272kPerMillion ?? pricing.outputPerMillion,
    cachedInputPerMillion:
      pricing.cachedInputOver272kPerMillion ??
      (pricing.cachedInputPerMillion !== undefined ? pricing.cachedInputPerMillion * inputRatio : undefined),
    cacheWriteInputPerMillion:
      pricing.cacheWriteInputOver272kPerMillion ??
      (pricing.cacheWriteInputPerMillion !== undefined
        ? pricing.cacheWriteInputPerMillion * inputRatio
        : undefined),
  };
}

/**
 * One request's usage, marked long-context when its prompt passed the
 * threshold of a model priced that way. Call it per request, before usage
 * from several requests is summed.
 */
export function markLongContext(usage: TokenUsage, pricing: TextPricing | null | undefined): TokenUsage {
  if (!pricing?.inputOver272kPerMillion || getTotalInputTokens(usage) <= LONG_CONTEXT_THRESHOLD_TOKENS) {
    return usage;
  }
  return {
    ...usage,
    longContext: {
      inputTokens: usage.inputTokens || 0,
      outputTokens: usage.outputTokens || 0,
      cacheReadInputTokens: usage.cacheReadInputTokens || 0,
      cacheCreationInputTokens: usage.cacheCreationInputTokens || 0,
    },
  };
}

/**
 * Calculate the estimated cost for an audio-to-text request.
 * Supports two strategies — per-minute pricing takes priority.
 */
export function calculateAudioCost(
  usage: (TokenUsage & { durationSeconds?: number }) | null | undefined,
  pricing: AudioPricing | null | undefined,
): number | null {
  if (!pricing || !usage) return null;

  // Strategy 1: per-minute pricing
  if (pricing.perMinute && usage.durationSeconds != null) {
    const durationSeconds = Math.max(0, usage.durationSeconds);
    return parseFloat(((durationSeconds / 60) * pricing.perMinute).toFixed(8));
  }

  // Strategy 2: token-based pricing
  if (pricing.audioInputPerMillion && usage.inputTokens) {
    return parseFloat(
      (
        (usage.inputTokens / 1_000_000) * pricing.audioInputPerMillion +
        ((usage.outputTokens || 0) / 1_000_000) *
          (pricing.outputPerMillion || 0)
      ).toFixed(8),
    );
  }

  return null;
}

/**
 * Calculate the estimated cost for a Live API session turn.
 * The Live API streams audio in and out, so input tokens should
 * use audioInputPerMillion and output tokens should use
 * audioOutputPerMillion when available.
 */
export function calculateLiveCost(
  usage: TokenUsage | null | undefined,
  pricing: AudioPricing | null | undefined,
): number | null {
  if (!pricing || !usage) return null;

  const inputRate =
    pricing.audioInputPerMillion || pricing.inputPerMillion || 0;
  const outputRate =
    pricing.audioOutputPerMillion || pricing.outputPerMillion || 0;

  return parseFloat(
    (
      ((usage.inputTokens || 0) / 1_000_000) * inputRate +
      ((usage.outputTokens || 0) / 1_000_000) * outputRate
    ).toFixed(8),
  );
}

/**
 * Calculate the estimated cost for a text-to-image request.
 * Estimates input tokens from prompt length (~4 chars per token).
 * Output image tokens vary by provider and resolution:
 *   - Google 512px ≈ 747 tokens, 1024px ≈ 1120 tokens, 2048px ≈ 1680 tokens, 4096px ≈ 2520 tokens
 *   - OpenAI 1024×1024 high-quality ≈ 1056 tokens
 */
export function calculateImageCost(
  prompt: string | null | undefined,
  pricing: ImagePricing | null | undefined,
  inputImages = 0,
  outputImageTokens = 1120,
): number | null {
  if (!pricing || !prompt) return null;

  const estimatedInputTokens = estimateTokens(prompt);

  let cost = 0;

  // Input text cost
  if (pricing.inputPerMillion) {
    cost += (estimatedInputTokens / 1_000_000) * pricing.inputPerMillion;
  }

  // Input image cost (for edit requests)
  if (inputImages > 0 && pricing.imageInputPerMillion) {
    cost += ((inputImages * 258) / 1_000_000) * pricing.imageInputPerMillion;
  }

  // Output image cost
  if (pricing.imageOutputPerMillion) {
    cost += (outputImageTokens / 1_000_000) * pricing.imageOutputPerMillion;
  } else if (pricing.outputPerMillion) {
    cost += (outputImageTokens / 1_000_000) * pricing.outputPerMillion;
  }

  return cost > 0 ? parseFloat(cost.toFixed(8)) : null;
}
