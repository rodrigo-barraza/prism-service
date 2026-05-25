import logger from "./logger.ts";
import { estimateTokens } from "./CostCalculator.ts";
import type { ChatMessage, ToolCallEntry } from "../types/admin.ts";

// ────────────────────────────────────────────────────────────
// ContextWindowManager — Token-Budget Truncation
// ────────────────────────────────────────────────────────────
// Prevents context window overflow by estimating token usage
// and compressing or dropping low-value messages when the
// conversation approaches the model's input limit.
//
// Strategy (in priority order):
//   1. Truncate tool results further (aggressive cap)
//   2. Summarize old assistant messages (keep first + last N)
//   3. Drop middle conversation turns (sliding window)
//
// Token estimation uses the ~4 chars/token heuristic, which is
// accurate enough for budget enforcement without requiring a
// real tokenizer (which would add latency and a dependency).
// ────────────────────────────────────────────────────────────

/** Default overhead for tool schemas, internal formatting, etc. */
const TOOL_SCHEMA_OVERHEAD_TOKENS = 2000;

/** Fraction of context window to target (leave headroom for output + safety) */
const TARGET_UTILIZATION = 0.8;

/** Minimum tokens to reserve for the model's output */
const MIN_OUTPUT_RESERVE = 8192;

/** When truncating tool results aggressively, cap at this many chars */
const AGGRESSIVE_TOOL_RESULT_CAP = 3000;

/** Number of recent turns to always preserve (never compress) */
const PROTECTED_RECENT_TURNS = 4;

interface EnforceOptions {
  maxInputTokens?: number;
  maxOutputTokens?: number;
  toolCount?: number;
}

interface EnforceResult {
  messages: ChatMessage[];
  truncated: boolean;
  strategy: string | null;
  estimatedTokens: number;
}

/**
 * Estimate token count for a single message.
 * Accounts for content, tool calls, tool results, thinking blocks, and images.
 */
function estimateMessageTokens(message: ChatMessage): number {
  let tokens = 4; // Per-message overhead (role, formatting)

  // Text content
  if (message.content) {
    tokens += estimateTokens(
      typeof message.content === "string"
        ? message.content
        : JSON.stringify(message.content),
    );
  }

  // Thinking blocks
  if (message.thinking) {
    tokens += estimateTokens(message.thinking);
  }

  // Tool calls (function name + args + results)
  if (message.toolCalls && Array.isArray(message.toolCalls)) {
    for (const toolCall of message.toolCalls) {
      tokens += estimateTokens(toolCall.name || "");
      tokens += estimateTokens(toolCall.args ? JSON.stringify(toolCall.args) : "");
      if (toolCall.result) {
        tokens += estimateTokens(
          typeof toolCall.result === "string" ? toolCall.result : JSON.stringify(toolCall.result),
        );
      }
    }
  }

  // Tool response content (standalone tool messages)
  if (message.role === "tool" && message.content) {
    tokens += estimateTokens(
      typeof message.content === "string"
        ? message.content
        : JSON.stringify(message.content),
    );
  }

  // Images (rough: ~1000 tokens per image reference)
  if (message.images && Array.isArray(message.images)) {
    tokens += message.images.length * 1000;
  }

  return tokens;
}

function estimateTotalTokens(messages: ChatMessage[]): number {
  return messages.reduce(
    (sum, message) => sum + estimateMessageTokens(message),
    0,
  );
}

// ────────────────────────────────────────────────────────────
// Truncation Strategies
// ────────────────────────────────────────────────────────────

/**
 * Strategy 1: Aggressively truncate OLD tool call results.
 * Tool results are the largest context consumers — a single `read_file`
 * can dump 10k+ chars. This caps results that exceed the aggressive limit,
 * but only for messages OUTSIDE the protected recent window.
 *
 * Recent tool results (within the last `protectedTurns` user turns) are
 * preserved in full — the LLM is actively reasoning about them.
 */
function truncateToolResults(
  messages: ChatMessage[],
  protectedTurns = PROTECTED_RECENT_TURNS,
): ChatMessage[] {
  // Find the protection boundary (same logic as compressOldAssistantMessages)
  let userTurnsSeen = 0;
  let protectionIndex = 0;

  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      userTurnsSeen++;
      if (userTurnsSeen >= protectedTurns) {
        protectionIndex = i;
        break;
      }
    }
  }

  return messages.map((message, i) => {
    // Never truncate tool results in recent (protected) messages
    if (i >= protectionIndex) return message;
    if (message.role !== "assistant" || !message.toolCalls?.length) return message;

    const truncated = { ...message };
    truncated.toolCalls = message.toolCalls.map((toolCall: ToolCallEntry) => {
      if (!toolCall.result) return toolCall;

      const resultStr =
        typeof toolCall.result === "string" ? toolCall.result : JSON.stringify(toolCall.result);
      if (resultStr.length <= AGGRESSIVE_TOOL_RESULT_CAP) return toolCall;

      return {
        ...toolCall,
        result:
          resultStr.slice(0, AGGRESSIVE_TOOL_RESULT_CAP) +
          `\n...[truncated ${resultStr.length - AGGRESSIVE_TOOL_RESULT_CAP} chars]`,
      };
    });
    return truncated;
  });
}

/**
 * Strategy 2: Compress old assistant messages — keep only a summary marker.
 * Replaces assistant content with a "[Earlier response summarized]" marker.
 * Preserves tool call names but drops results.
 */
function compressOldAssistantMessages(
  messages: ChatMessage[],
  protectedCount = PROTECTED_RECENT_TURNS,
): ChatMessage[] {
  // Count user turns from the end to determine protection boundary
  let userTurnsSeen = 0;
  let protectionIndex = 0;

  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      userTurnsSeen++;
      if (userTurnsSeen >= protectedCount) {
        protectionIndex = i;
        break;
      }
    }
  }

  return messages.map((message, i) => {
    // Never compress system messages, user messages, or protected recent messages
    if (message.role === "system" || message.role === "user" || i >= protectionIndex) {
      return message;
    }

    // Compress assistant messages
    if (message.role === "assistant") {
      const compressed = { ...message };

      // Keep a short summary of what the assistant did
      const toolNames =
        message.toolCalls?.map((toolCall: ToolCallEntry) => toolCall.name).join(", ") || "";
      const contentStr = typeof message.content === "string" ? message.content : "";
      const contentPreview = contentStr.slice(0, 200);

      compressed.content = `[Earlier response${toolNames ? ` — used: ${toolNames}` : ""}]${contentPreview ? `\n${contentPreview}...` : ""}`;
      compressed.thinking = undefined;

      if (compressed.toolCalls) {
        compressed.toolCalls = compressed.toolCalls.map((toolCall: ToolCallEntry) => ({
          ...toolCall,
          result: toolCall.result
            ? "[result truncated for context budget]"
            : undefined,
        }));
      }

      return compressed;
    }

    // Compress standalone tool messages
    if (message.role === "tool") {
      return {
        ...message,
        content: "[tool result truncated for context budget]",
      };
    }

    return message;
  });
}

/**
 * Strategy 3: Drop middle turns entirely (sliding window).
 * Keeps the system prompt, first user message (for task context),
 * and the most recent N turns.
 */
function slidingWindowTruncation(messages: ChatMessage[], maxTokens: number): ChatMessage[] {
  if (messages.length <= 3) return messages;

  // Always keep: system message, first user message
  const head: ChatMessage[] = [];
  let headEnd = 0;

  for (let i = 0; i < messages.length; i++) {
    head.push(messages[i]);
    headEnd = i + 1;
    if (messages[i].role === "user") break; // Stop after first user message
  }

  // Build tail from the end until we approach budget
  const tail: ChatMessage[] = [];
  let tailTokens = 0;
  const headTokens = estimateTotalTokens(head);
  const availableForTail = maxTokens - headTokens - 200; // 200 token buffer for marker

  for (let i = messages.length - 1; i >= headEnd; i--) {
    const msgTokens = estimateMessageTokens(messages[i]);
    if (tailTokens + msgTokens > availableForTail) break;
    tail.unshift(messages[i]);
    tailTokens += msgTokens;
  }

  const droppedCount = messages.length - head.length - tail.length;

  if (droppedCount > 0) {
    // Insert a context marker so the model knows history was dropped
    head.push({
      role: "user",
      content: `[CONTEXT NOTE: ${droppedCount} earlier messages were removed to fit the context window. The conversation continues below.]`,
    });
  }

  return [...head, ...tail];
}

// ────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────

export default class ContextWindowManager {
  /**
   * Enforce context window limits on a messages array.
   *
   * Applies truncation strategies in order of aggressiveness until
   * the estimated token count fits within the model's context window.
   */
  static enforce(messages: ChatMessage[], options: EnforceOptions = {}): EnforceResult {
    const {
      maxInputTokens = 128_000,
      maxOutputTokens = MIN_OUTPUT_RESERVE,
      toolCount = 0,
    } = options;

    // Calculate the effective token budget
    const schemaOverhead = TOOL_SCHEMA_OVERHEAD_TOKENS + toolCount * 150;
    const outputReserve = Math.max(maxOutputTokens, MIN_OUTPUT_RESERVE);
    const budget = Math.floor(
      (maxInputTokens - outputReserve - schemaOverhead) * TARGET_UTILIZATION,
    );

    if (budget <= 0) {
      logger.warn(
        `[ContextWindowManager] Negative budget: maxInput=${maxInputTokens}, outputReserve=${outputReserve}, schemaOverhead=${schemaOverhead}`,
      );
      return {
        messages,
        truncated: false,
        strategy: null,
        estimatedTokens: estimateTotalTokens(messages),
      };
    }

    let currentTokens = estimateTotalTokens(messages);

    // Fast path: fits within budget
    if (currentTokens <= budget) {
      return {
        messages,
        truncated: false,
        strategy: null,
        estimatedTokens: currentTokens,
      };
    }

    logger.info(
      `[ContextWindowManager] Context overflow: ${currentTokens} tokens > ${budget} budget (${maxInputTokens} window, ${outputReserve} output reserve)`,
    );

    // Strategy 1: Truncate tool results aggressively
    let result = truncateToolResults(messages);
    currentTokens = estimateTotalTokens(result);

    if (currentTokens <= budget) {
      logger.info(
        `[ContextWindowManager] Fixed with tool result truncation: ${currentTokens} tokens`,
      );
      return {
        messages: result,
        truncated: true,
        strategy: "tool_truncation",
        estimatedTokens: currentTokens,
      };
    }

    // Strategy 2: Compress old assistant messages
    result = compressOldAssistantMessages(result);
    currentTokens = estimateTotalTokens(result);

    if (currentTokens <= budget) {
      logger.info(
        `[ContextWindowManager] Fixed with assistant compression: ${currentTokens} tokens`,
      );
      return {
        messages: result,
        truncated: true,
        strategy: "assistant_compression",
        estimatedTokens: currentTokens,
      };
    }

    // Strategy 3: Sliding window — drop middle turns
    result = slidingWindowTruncation(result, budget);
    currentTokens = estimateTotalTokens(result);

    logger.info(
      `[ContextWindowManager] Applied sliding window: ${currentTokens} tokens (budget: ${budget})`,
    );
    return {
      messages: result,
      truncated: true,
      strategy: "sliding_window",
      estimatedTokens: currentTokens,
    };
  }

  static estimateTokens(messages: ChatMessage[]): number {
    return estimateTotalTokens(messages);
  }

  static estimateMessageTokens(message: ChatMessage): number {
    return estimateMessageTokens(message);
  }
}
