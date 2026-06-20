import ToolContext from "../../ToolContext.ts";

const TOOL_CONTEXT_KEY_DYNAMIC_ENABLED = "dynamicEnabledTools";
const TOOL_CONTEXT_KEY_DIRTY_FLAG = "toolSetDirty";

export function getCurrentDynamicTools(agentConversationId: string): string[] {
  const stored = ToolContext.get<string[]>(
    agentConversationId,
    TOOL_CONTEXT_KEY_DYNAMIC_ENABLED,
  );
  return Array.isArray(stored) ? stored : [];
}

export function persistDynamicTools(
  agentConversationId: string,
  toolNames: string[],
): void {
  ToolContext.set(agentConversationId, TOOL_CONTEXT_KEY_DYNAMIC_ENABLED, toolNames);
  ToolContext.set(agentConversationId, TOOL_CONTEXT_KEY_DIRTY_FLAG, true);
}
