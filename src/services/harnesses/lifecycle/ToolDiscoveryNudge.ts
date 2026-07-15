import logger from "#src/utils/logger";
import PromptLocaleService from "#src/services/PromptLocaleService";
import {
  SYSTEM_MESSAGE_TAGS,
  wrapSystemMessage,
} from "#src/utils/SystemMessageTags";
import { TOOL_NAMES } from "@rodrigo-barraza/utilities-library/taxonomy";

import ToolContext from "#src/services/ToolContext";
import ToolOrchestratorService from "#src/services/tool-orchestrator/ToolOrchestratorService";
import AgentPersonaRegistry from "#src/services/AgentPersonaRegistry";
import {
  partitionByDiscoverableUniverse,
  isScopedPersona,
} from "#src/services/ToolDiscoveryScope";

import type {
  ToolCall,
  ToolResult,
  ConversationMessage,
  AgenticContext,
} from "#src/services/harnesses/types";

/**
 * ToolDiscoveryNudge — post-search_tools processing for tool discovery chains.
 *
 * When `search_tools` returns results that include disabled tools, the model
 * needs guidance on how to proceed. Without this nudge, weaker models stall
 * after the search step because they don't know to call `enable_tools`.
 *
 * Behavior varies by model tier:
 *   - **Lower-tier** (nano/mini/flash/haiku/lite): auto-enables the discovered
 *     tools via ToolContext and injects a "they're available now" message.
 *     Sets `toolSetDirty` so the harness's `checkAndApplyToolSetChanges()`
 *     picks up the mutation.
 *   - **Higher-tier**: injects an explicit "call enable_tools" system message
 *     so the model can decide whether to enable them.
 *
 * Extracted from ReActHarness (lines 608–678) for cross-harness reuse.
 */

/**
 * Inspect tool call results for search_tools responses containing disabled
 * tools, and inject appropriate nudge messages into the conversation.
 */
export function injectToolDiscoveryNudge(
  toolCalls: ToolCall[],
  results: ToolResult[],
  currentMessages: ConversationMessage[],
  context: AgenticContext,
): void {
  for (const toolCall of toolCalls) {
    if (toolCall.name !== TOOL_NAMES.SEARCH_TOOLS) continue;

    const matchingResult = results.find((result) => result.id === toolCall.id);
    const toolResultData = matchingResult?.result as
      | Record<string, unknown>
      | undefined;
    const searchMatches = toolResultData?.matches as
      | Array<{ name?: string; isEnabled?: boolean }>
      | undefined;
    if (!Array.isArray(searchMatches)) continue;

    let disabledToolNames = searchMatches
      .filter((matchEntry) => matchEntry.isEnabled === false)
      .map((matchEntry) => matchEntry.name)
      .filter(Boolean) as string[];

    // Never nudge toward (or auto-enable) tools outside the persona's
    // reachable universe — the resolver would strip them anyway.
    if (disabledToolNames.length > 0 && context.agent) {
      const persona = AgentPersonaRegistry.get(context.agent);
      if (isScopedPersona(persona)) {
        const { allowed } = partitionByDiscoverableUniverse(
          persona,
          ToolOrchestratorService.getClientToolSchemas(),
          disabledToolNames,
        );
        disabledToolNames = allowed;
      }
    }

    if (disabledToolNames.length === 0) continue;

    // Heuristic: models with nano/mini/flash/haiku/lite in the name
    // are lower-tier and benefit from auto-enable (skip the enable_tools step)
    const modelNameLower = (context.resolvedModel || "").toLowerCase();
    const isLowerTierModel = /\b(nano|mini|flash|haiku|lite)\b/.test(
      modelNameLower,
    );

    if (isLowerTierModel) {
      const agentConversationId = context.agentConversationId || "";
      const toolContextStore = ToolContext.getStore(agentConversationId);
      const currentDynamic =
        (toolContextStore.get("dynamicEnabledTools") as string[]) || [];
      const mergedSet = new Set(currentDynamic);
      for (const name of disabledToolNames) mergedSet.add(name);
      toolContextStore.set("dynamicEnabledTools", [...mergedSet]);
      toolContextStore.set("toolSetDirty", true);

      currentMessages.push({
        role: "system",
        content: wrapSystemMessage(
          SYSTEM_MESSAGE_TAGS.TOOL_UPDATE,
          PromptLocaleService.get(
            (context.options?.locale as string | undefined) ||
              PromptLocaleService.getDefaultLocale(),
            "harness.toolDiscoveryNudge.autoEnabled",
            {
              count: String(disabledToolNames.length),
              toolNames: disabledToolNames.join(", "),
            },
          ),
        ),
      });
      logger.info(
        `[ToolDiscoveryNudge] Auto-enabled ${disabledToolNames.length} tools for lower-tier model "${context.resolvedModel}": [${disabledToolNames.join(", ")}]`,
      );
    } else {
      currentMessages.push({
        role: "system",
        content: wrapSystemMessage(
          SYSTEM_MESSAGE_TAGS.TOOL_UPDATE,
          PromptLocaleService.get(
            (context.options?.locale as string | undefined) ||
              PromptLocaleService.getDefaultLocale(),
            "harness.toolDiscoveryNudge.enableRequired",
            {
              count: String(disabledToolNames.length),
              toolNames: disabledToolNames.join(", "),
            },
          ),
        ),
      });
      logger.info(
        `[ToolDiscoveryNudge] Injected post-search nudge for ${disabledToolNames.length} disabled tools: [${disabledToolNames.join(", ")}]`,
      );
    }
  }
}
