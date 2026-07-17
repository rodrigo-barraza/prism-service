import ToolContext from "#src/services/ToolContext";

const TOOL_CONTEXT_KEY_DYNAMIC_ENABLED = "dynamicEnabledTools";
const TOOL_CONTEXT_KEY_DYNAMIC_SEED = "dynamicSeedTools";
const TOOL_CONTEXT_KEY_DIRTY_FLAG = "toolSetDirty";

export function getCurrentDynamicTools(agentConversationId: string): string[] {
  const stored = ToolContext.get<string[]>(
    agentConversationId,
    TOOL_CONTEXT_KEY_DYNAMIC_ENABLED,
  );
  return Array.isArray(stored) ? stored : [];
}

/**
 * The tool names the conversation was seeded with (client/persona baseline),
 * recorded once at first resolve. Discovery caps count growth beyond this
 * set, never the baseline itself.
 */
export function getDynamicSeedTools(agentConversationId: string): string[] {
  const stored = ToolContext.get<string[]>(
    agentConversationId,
    TOOL_CONTEXT_KEY_DYNAMIC_SEED,
  );
  return Array.isArray(stored) ? stored : [];
}

/** No dirty flag — the seed is bookkeeping, not a tool-set change. */
export function persistDynamicSeedTools(
  agentConversationId: string,
  toolNames: string[],
): void {
  ToolContext.set(
    agentConversationId,
    TOOL_CONTEXT_KEY_DYNAMIC_SEED,
    toolNames,
  );
}

export function persistDynamicTools(
  agentConversationId: string,
  toolNames: string[],
): void {
  ToolContext.set(
    agentConversationId,
    TOOL_CONTEXT_KEY_DYNAMIC_ENABLED,
    toolNames,
  );
  ToolContext.set(agentConversationId, TOOL_CONTEXT_KEY_DIRTY_FLAG, true);
}
