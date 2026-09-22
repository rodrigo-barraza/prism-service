/**
 * Anthropic request knobs, read by src/providers/anthropic.ts from the
 * `anthropic` section of SettingsService (defaults below when unset).
 *
 *   serverSideFallbacks  — send `fallbacks: "default"` (beta) on the models
 *                          that support it, so a safety-classifier refusal
 *                          is re-run on Anthropic's recommended fallback.
 *   thinkingDisplay      — "summarized" returns readable reasoning;
 *                          "updates" (beta, Fable 5.x / Opus 5.5) returns
 *                          only the progress notes between tool calls;
 *                          "omitted" is the API default (empty text).
 *   thinkingBlockBinding — preserved-thinking mismatch handling on the
 *                          models that bind blocks to the conversation:
 *                          "drop_block" degrades an edited history to a
 *                          logged drop, "error" makes it a 400, "off" sends
 *                          neither the beta nor the field.
 */
export interface AnthropicSettings {
  serverSideFallbacks: boolean;
  thinkingDisplay: "summarized" | "updates" | "omitted";
  thinkingBlockBinding: "drop_block" | "error" | "off";
}

export const ANTHROPIC_SETTING_DEFAULTS: AnthropicSettings = {
  serverSideFallbacks: true,
  thinkingDisplay: "summarized",
  thinkingBlockBinding: "drop_block",
};
