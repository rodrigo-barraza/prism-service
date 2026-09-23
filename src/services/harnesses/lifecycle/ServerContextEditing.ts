import { supportsServerContextEditing } from "#src/providers/toolLoading";
import { resolveProviderBaseType } from "@rodrigo-barraza/utilities-library/taxonomy";
import {
  DEFAULT_MAX_INPUT_TOKENS,
  DEFAULT_MAX_OUTPUT_TOKENS,
} from "#src/constants/TokenBudgetDefaults";
import { HARNESS } from "#src/constants";

import type { AgenticContext } from "#src/services/harnesses/types";

/**
 * ServerContextEditing — Claude clears old tool results server-side.
 *
 * Client micro-compaction rewrites old tool results into offload stubs,
 * which changes what earlier requests sent. On Claude the request instead
 * carries a context-editing `clear_tool_uses` edit that triggers where
 * micro-compaction would (HARNESS.CONTEXT_PRESSURE_THRESHOLD of the input
 * budget), so the client transcript stays append-only and
 * ContextPressureManager skips micro-compaction.
 */

/** Server-side clearing keeps this many of the most recent tool uses. */
const SERVER_CLEARING_KEEP_TOOL_USES = 8;

/** Each server-side clearing frees at least this fraction of its trigger — worth the cache rewrite it causes. */
const SERVER_CLEARING_MINIMUM_FRACTION = 0.2;

/**
 * Claude clears old tool results itself (context editing): the request
 * carries a `clear_tool_uses` edit that triggers where client
 * micro-compaction would, and the client never rewrites a tool result into
 * an offload stub. Empty for every other provider.
 */
export function serverContextEditingFor(context: AgenticContext): {
  contextEditing?: {
    triggerInputTokens: number;
    keepToolUses: number;
    clearAtLeastInputTokens: number;
  };
} {
  if (
    !context.providerName ||
    resolveProviderBaseType(context.providerName) !== "anthropic" ||
    !supportsServerContextEditing(context.resolvedModel)
  ) {
    return {};
  }
  const contextWindowSize =
    context.modelDefinition?.maxInputTokens ||
    (context.options?._loadedContextLength as number | undefined) ||
    DEFAULT_MAX_INPUT_TOKENS;
  const maxOutputTokens =
    context.options?.maxTokens || DEFAULT_MAX_OUTPUT_TOKENS;
  const triggerInputTokens = Math.floor(
    Math.max(0, contextWindowSize - maxOutputTokens) *
      HARNESS.CONTEXT_PRESSURE_THRESHOLD,
  );
  if (triggerInputTokens <= 0) return {};
  return {
    contextEditing: {
      triggerInputTokens,
      keepToolUses: SERVER_CLEARING_KEEP_TOOL_USES,
      clearAtLeastInputTokens: Math.floor(
        triggerInputTokens * SERVER_CLEARING_MINIMUM_FRACTION,
      ),
    },
  };
}
