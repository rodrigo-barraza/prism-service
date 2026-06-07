import type { SubAgentResult, SubAgentState } from "../../types/orchestrator.ts";
import type { ConversationMessage } from "../harnesses/types.ts";

/*
 * Extract the text content from the last assistant message in a conversation.
 * Mirrors Claude Code's finalizeAgentTool pattern — only the final report is
 * returned to the orchestrator, keeping the parent context clean.
 *
 * If the last assistant message has no text (e.g. it was a pure tool_use),
 * walks backward to find the most recent assistant message with text.
 */
export function getLastAssistantText(messages: ConversationMessage[]): string {
  if (!messages?.length) return "";
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role !== "assistant") continue;
    const text = (typeof message.content === "string" ? message.content : "").trim();
    if (text) return text;
  }
  return "";
}

/*
 * Helper to estimate tokens from accumulated characters.
 * Falls back to chars/4 estimation from accumulated characters.
 */
export function estimateTokens(characterCount: number): number {
  return Math.ceil(characterCount / 4);
}

export function buildSubAgentResult(subAgent: SubAgentState): SubAgentResult {
  const status = subAgent.status === "complete" ? "completed" : subAgent.status;
  const summary =
    status === "completed"
      ? `Agent "${subAgent.description}" completed`
      : status === "failed"
        ? `Agent "${subAgent.description}" failed: ${subAgent.error || "Unknown error"}`
        : `Agent "${subAgent.description}" was stopped`;

  // subAgent.output is set during _runSubAgentLoop from getLastAssistantText()
  // on the live messages array, then falls back to telemetry.output (streamed
  // chunks). subAgent.messages is nulled after the loop to release memory, so
  // we use subAgent.output directly as the primary text source.
  const lastText = (subAgent.output || "").trim() || getLastAssistantText(subAgent.messages || []);

  // Aggregate tool call names into { name: count } for frontend badge display
  const toolNames: Record<string, number> = {};
  if (subAgent.toolCalls?.length) {
    for (const toolCall of subAgent.toolCalls) {
      const name = toolCall.name || "unknown";
      toolNames[name] = (toolNames[name] || 0) + 1;
    }
  }

  const result: SubAgentResult = {
    agent_id: subAgent.agentId,
    description: subAgent.description,
    status,
    summary,
    result: lastText || null,
    toolUses: subAgent.toolCalls?.length || 0,
    toolNames: Object.keys(toolNames).length > 0 ? toolNames : undefined,
    iterations: subAgent.iterations || 0,
    durationMs: subAgent.durationMs || 0,
    // Include full conversation for frontend MessageList rendering.
    // Strip system messages — they're large and not useful for display.
    messages: (subAgent.messages || []).filter((message) => message.role !== "system"),
  };

  if (subAgent.diff?.hasChanges) {
    result.diff = {
      additions: subAgent.diff.additions || 0,
      deletions: subAgent.diff.deletions || 0,
      files: subAgent.diff.files || [],
    };
  }

  if (subAgent.error) result.error = subAgent.error;

  return result;
}

/**
 * Build a structured fallback summary from tool-call metadata when the
 * agent's result text is null. Used by PeerToPeerRouter and SequentialRouter
 * to inject at least some useful context into the Shared Discussion Board
 * instead of the useless boilerplate summary ("Agent X completed").
 */
export function buildToolCallFallbackSummary(agentResult: SubAgentResult): string | null {
  if (agentResult.toolUses === 0 && !agentResult.iterations) return null;

  const toolBreakdown = agentResult.toolNames
    ? Object.entries(agentResult.toolNames)
        .map(([toolName, callCount]) => `${toolName} (${callCount}×)`)
        .join(", ")
    : null;

  const iterationLabel = agentResult.iterations === 1
    ? "1 iteration"
    : `${agentResult.iterations} iterations`;

  if (toolBreakdown) {
    return (
      `Agent completed ${iterationLabel} using ${toolBreakdown} ` +
      `but did not produce a final summary.`
    );
  }

  return `Agent completed ${iterationLabel} with ${agentResult.toolUses} tool call(s) but did not produce a final summary.`;
}
