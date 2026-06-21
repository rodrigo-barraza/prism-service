import type {
  SubAgentResult,
  SubAgentState,
  SubtreeMetrics,
  SubAgentChildSummary,
} from "../../types/orchestrator.ts";
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
    const text = (
      typeof message.content === "string" ? message.content : ""
    ).trim();
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
  const lastText =
    (subAgent.output || "").trim() ||
    getLastAssistantText(subAgent.messages || []);

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
    messages: (subAgent.messages || []).filter(
      (message) => message.role !== "system",
    ),
  };

  if (subAgent.diff?.hasChanges) {
    result.diff = {
      additions: subAgent.diff.additions || 0,
      deletions: subAgent.diff.deletions || 0,
      files: subAgent.diff.files || [],
    };
  }

  if (subAgent.error) result.error = subAgent.error;

  if (typeof subAgent.recursionDepth === "number") {
    result.recursionDepth = subAgent.recursionDepth;
  }

  const subtreeMetrics = extractSubtreeMetrics(subAgent.messages || []);
  if (subtreeMetrics) {
    result.subtreeMetrics = subtreeMetrics;
  }

  return result;
}

/**
 * Build a structured fallback summary from tool-call metadata when the
 * agent's result text is null. Used by PeerToPeerRouter and SequentialRouter
 * to inject at least some useful context into the Shared Discussion Board
 * instead of the useless boilerplate summary ("Agent X completed").
 */
export function buildToolCallFallbackSummary(
  agentResult: SubAgentResult,
): string | null {
  if (agentResult.toolUses === 0 && !agentResult.iterations) return null;

  const toolBreakdown = agentResult.toolNames
    ? Object.entries(agentResult.toolNames)
        .map(([toolName, callCount]) => `${toolName} (${callCount}×)`)
        .join(", ")
    : null;

  const iterationLabel =
    agentResult.iterations === 1
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

/**
 * Scan a sub-agent's conversation for create_team tool results that contain
 * SubAgentResult payloads. When a child agent spawned grandchildren, those
 * results appear as tool_result messages in the child's conversation. We
 * parse these to build aggregated subtree metrics for the parent.
 *
 * Paper alignment: THREAD (arXiv:2405.17402) — hierarchical result aggregation.
 */
export function extractSubtreeMetrics(
  messages: ConversationMessage[],
): SubtreeMetrics | null {
  const childSummaries: SubAgentChildSummary[] = [];

  for (const message of messages) {
    if (message.role !== "tool" && message.role !== "tool_result") continue;

    const content = typeof message.content === "string" ? message.content : "";
    if (!content.includes("agent_id")) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      continue;
    }

    const resultsArray: unknown[] = Array.isArray(parsed) ? parsed : [parsed];

    for (const entry of resultsArray) {
      if (
        typeof entry !== "object" ||
        entry === null ||
        !("agent_id" in entry) ||
        !("status" in entry)
      ) {
        continue;
      }

      const childResult = entry as Record<string, unknown>;
      const childSummary: SubAgentChildSummary = {
        agent_id: String(childResult.agent_id),
        description: String(childResult.description || ""),
        status: String(childResult.status || "unknown"),
        recursionDepth:
          typeof childResult.recursionDepth === "number"
            ? childResult.recursionDepth
            : 0,
        durationMs:
          typeof childResult.durationMs === "number"
            ? childResult.durationMs
            : 0,
        toolUses:
          typeof childResult.toolUses === "number" ? childResult.toolUses : 0,
        cost: 0,
      };

      if (
        childResult.subtreeMetrics &&
        typeof childResult.subtreeMetrics === "object"
      ) {
        childSummary.subtreeMetrics =
          childResult.subtreeMetrics as SubtreeMetrics;
      }

      childSummaries.push(childSummary);
    }
  }

  if (childSummaries.length === 0) return null;

  let totalDescendants = 0;
  let maxDepthReached = 0;
  let aggregatedCost = 0;
  let aggregatedDurationMs = 0;
  let aggregatedToolUses = 0;

  for (const child of childSummaries) {
    totalDescendants += 1;
    aggregatedDurationMs += child.durationMs;
    aggregatedToolUses += child.toolUses;
    aggregatedCost += child.cost;
    maxDepthReached = Math.max(maxDepthReached, child.recursionDepth);

    if (child.subtreeMetrics) {
      totalDescendants += child.subtreeMetrics.totalDescendants;
      maxDepthReached = Math.max(
        maxDepthReached,
        child.subtreeMetrics.maxDepthReached,
      );
      aggregatedCost += child.subtreeMetrics.aggregatedCost;
      aggregatedDurationMs += child.subtreeMetrics.aggregatedDurationMs;
      aggregatedToolUses += child.subtreeMetrics.aggregatedToolUses;
    }
  }

  return {
    totalDescendants,
    maxDepthReached,
    aggregatedCost,
    aggregatedDurationMs,
    aggregatedToolUses,
    childResults: childSummaries,
  };
}
