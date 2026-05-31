import type { WorkerResult, WorkerState } from "../../types/coordinator.ts";
import type { ConversationMessage } from "../harnesses/types.ts";

/**
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

/**
 * Helper to estimate tokens from accumulated characters.
 * Falls back to chars/4 estimation from accumulated characters.
 */
export function estimateTokens(characterCount: number): number {
  return Math.ceil(characterCount / 4);
}

export function buildWorkerResult(worker: WorkerState): WorkerResult {
  const status = worker.status === "complete" ? "completed" : worker.status;
  const summary =
    status === "completed"
      ? `Agent "${worker.description}" completed`
      : status === "failed"
        ? `Agent "${worker.description}" failed: ${worker.error || "Unknown error"}`
        : `Agent "${worker.description}" was stopped`;

  // Return the full last assistant message text (no truncation).
  // Like Claude Code, we trust the model to produce a concise final report.
  const lastText = getLastAssistantText(worker.messages || []);

  // Aggregate tool call names into { name: count } for frontend badge display
  const toolNames: Record<string, number> = {};
  if (worker.toolCalls?.length) {
    for (const toolCall of worker.toolCalls) {
      const name = toolCall.name || "unknown";
      toolNames[name] = (toolNames[name] || 0) + 1;
    }
  }

  const result: WorkerResult = {
    agent_id: worker.agentId,
    description: worker.description,
    status,
    summary,
    result: lastText || (worker.output || "").trim() || null,
    toolUses: worker.toolCalls?.length || 0,
    toolNames: Object.keys(toolNames).length > 0 ? toolNames : undefined,
    iterations: worker.iterations || 0,
    durationMs: worker.durationMs || 0,
    // Include full conversation for frontend MessageList rendering.
    // Strip system messages — they're large and not useful for display.
    messages: (worker.messages || []).filter((message) => message.role !== "system"),
  };

  if (worker.diff?.hasChanges) {
    result.diff = {
      additions: worker.diff.additions || 0,
      deletions: worker.diff.deletions || 0,
      files: worker.diff.files || [],
    };
  }

  if (worker.error) result.error = worker.error;

  return result;
}
