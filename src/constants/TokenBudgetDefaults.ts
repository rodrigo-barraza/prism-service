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
