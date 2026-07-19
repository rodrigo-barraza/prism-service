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
 * Fixed token headroom added ON TOP of the multiplicative margin when
 * clamping output tokens.
 *
 * The multiplicative margin scales with prompt size but leaves ZERO
 * absolute slack when the clamp grants all remaining window to output:
 * clamped = window − estimate×1.10, so any real input exceeding the
 * adjusted estimate fails hard. Verified in production (2026-07-19,
 * Gemma 4 12B on vLLM, 90K window): a 30KB inlined JSON pushed the
 * heuristic 9.1% under the real count — the request died at 90,001/90,000,
 * over by literally one token. Dense JSON/hex content tokenizes worse
 * than the ~4 chars/token prose heuristic, and vLLM also counts chat
 * template tokens the estimate cannot see.
 */
export const OUTPUT_TOKEN_CLAMP_FIXED_HEADROOM_TOKENS = 1_024;

/**
 * Minimum output tokens to allow after clamping. If the remaining budget
 * after input is below this threshold, the clamp still permits at least
 * this many tokens so the model can produce a meaningful error or
 * partial response rather than silently failing with 0 output.
 */
export const MINIMUM_CLAMPED_OUTPUT_TOKENS = 1_024;

/**
 * Minimum output budget below which a provider request is considered doomed.
 *
 * A tool call JSON typically needs 500–2K tokens, and the model needs
 * additional room for reasoning/thinking. Below this threshold, the risk
 * of mid-tool-call truncation is too high — the harness should skip the
 * provider call entirely and trigger exhaustion recovery instead.
 */
export const MINIMUM_VIABLE_OUTPUT_TOKENS = 4_096;
