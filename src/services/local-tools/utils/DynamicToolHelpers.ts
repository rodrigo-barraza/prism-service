import ToolContext from "../../ToolContext.ts";

const TOOL_CONTEXT_KEY_DYNAMIC_ENABLED = "dynamicEnabledTools";
const TOOL_CONTEXT_KEY_DIRTY_FLAG = "toolSetDirty";

export function getCurrentDynamicTools(sessionId: string): string[] {
  const stored = ToolContext.get<string[]>(
    sessionId,
    TOOL_CONTEXT_KEY_DYNAMIC_ENABLED,
  );
  return Array.isArray(stored) ? stored : [];
}

export function persistDynamicTools(
  sessionId: string,
  toolNames: string[],
): void {
  ToolContext.set(sessionId, TOOL_CONTEXT_KEY_DYNAMIC_ENABLED, toolNames);
  ToolContext.set(sessionId, TOOL_CONTEXT_KEY_DIRTY_FLAG, true);
}
