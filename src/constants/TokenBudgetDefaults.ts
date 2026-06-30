// ─── Token Budget Defaults ──────────────────────────────────
// Single source of truth for every token budget fallback in the
// harness, provider, and context window enforcement layers.
//
// Import from here instead of scattering magic numbers across files.

/** Default max output tokens when no user/model config specifies one. */
export const DEFAULT_MAX_OUTPUT_TOKENS = 16_384;

/** Default max input tokens (context window) when no model definition provides one. */
export const DEFAULT_MAX_INPUT_TOKENS = 128_000;

/** Minimum tokens always reserved for model output in context window calculations. */
export const MIN_OUTPUT_RESERVE = 8_192;

/** Token escalation multiplier applied per output truncation recovery attempt. */
export const TOKEN_ESCALATION_MULTIPLIER = 1.5;

/** Maximum number of auto-continuation attempts before giving up on truncation recovery. */
export const MAX_OUTPUT_TRUNCATION_RECOVERIES = 3;

/**
 * Safety margin MULTIPLIER applied when dynamically clamping max_tokens
 * to fit within the model's context window.
 *
 * The ~4 chars/token heuristic systematically underestimates real tokenizer
 * output by 5-6% (verified: estimated 24,624 vs provider-reported 26,001
 * on Gemma 4 12B = 94.7% accuracy). A fixed margin (the old 256) doesn't
 * scale with prompt size — a 14K system prompt + 9K messages + 2K tools
 * produces a ~1,400 token estimation error that 256 can't absorb.
 *
 * Using a 10% multiplicative margin on the estimated input guarantees
 * coverage regardless of total prompt size.
 */
export const OUTPUT_TOKEN_CLAMP_SAFETY_MULTIPLIER = 0.10;

/**
 * Minimum output tokens to allow after clamping. If the remaining budget
 * after input is below this threshold, the clamp still permits at least
 * this many tokens so the model can produce a meaningful error or
 * partial response rather than silently failing with 0 output.
 */
export const MINIMUM_CLAMPED_OUTPUT_TOKENS = 1_024;
