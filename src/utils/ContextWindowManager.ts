import logger from "./logger.ts";
import { estimateTokens } from "./CostCalculator.ts";

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

/**
 * Estimate token count for a single message.
 * Accounts for content, tool calls, tool results, thinking blocks, and images.
 *


 */
function estimateMessageTokens(message: string) {
  let tokens = 4; // Per-message overhead (role, formatting)

  // Text content
  // @ts-ignore - TODO: strict typing
  if (message.content) {
    tokens += estimateTokens(
      // @ts-ignore - TODO: strict typing
      typeof message.content === "string"
        // @ts-ignore - TODO: strict typing
        ? message.content
        // @ts-ignore - TODO: strict typing
        : JSON.stringify(message.content),
    );
  }

  // Thinking blocks
  // @ts-ignore - TODO: strict typing
  if (message.thinking) {
    // @ts-ignore - TODO: strict typing
    tokens += estimateTokens(message.thinking);
  }

  // Tool calls (function name + args + results)
  // @ts-ignore - TODO: strict typing
  if (message.toolCalls && Array.isArray(message.toolCalls)) {
    // @ts-ignore
    for ( const tc of message.toolCalls) {
      tokens += estimateTokens(tc.name || "");
      // @ts-ignore - TODO: strict typing
      tokens += estimateTokens(tc.args ? JSON.stringify(tc.args) : "");
      if (tc.result) {
        tokens += estimateTokens(
          typeof tc.result === "string" ? tc.result : JSON.stringify(tc.result),
        );
      }
    }
  }

  // Tool response content (standalone tool messages)
  // @ts-ignore - TODO: strict typing
  if (message.role === "tool" && message.content) {
    tokens += estimateTokens(
      // @ts-ignore - TODO: strict typing
      typeof message.content === "string"
        // @ts-ignore - TODO: strict typing
        ? message.content
        // @ts-ignore - TODO: strict typing
        : JSON.stringify(message.content),
    );
  }

  // Images (rough: ~1000 tokens per image reference)
  // @ts-ignore - TODO: strict typing
  if (message.images && Array.isArray(message.images)) {
    // @ts-ignore - TODO: strict typing
    tokens += message.images.length * 1000;
  }

  return tokens;
}

/**
 * Estimate total tokens across all messages.
 *


 */
function estimateTotalTokens(messages: Record<string, unknown>) {
  // @ts-ignore - TODO: strict typing
  return messages.reduce(
    // @ts-ignore - TODO: strict typing
    (sum: Record<string, unknown>, message: string) => sum + estimateMessageTokens(message),
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
 *


 * @returns {Array} Messages with truncated tool results
 */
function truncateToolResults(
  messages: Record<string, unknown>,
  // @ts-ignore - TODO: strict typing
  protectedTurns: Record<string, unknown> = PROTECTED_RECENT_TURNS,
) {
  // Find the protection boundary (same logic as compressOldAssistantMessages)
  let userTurnsSeen = 0;
  let protectionIndex = messages.length;

  // @ts-ignore - TODO: strict typing
  for (let i = messages.length - 1; i >= 0; i--) {
    // @ts-ignore - TODO: strict typing
    if (messages[i].role === "user") {
      userTurnsSeen++;
      // @ts-ignore - TODO: strict typing
      if (userTurnsSeen >= protectedTurns) {
        protectionIndex = i;
        break;
      }
    }
  }

  // @ts-ignore - TODO: strict typing
  return messages.map((message: string, i: Record<string, unknown>) => {
    // Never truncate tool results in recent (protected) messages
    // @ts-ignore - TODO: strict typing
    if (i >= protectionIndex) return message;
    // @ts-ignore - TODO: strict typing
    if (message.role !== "assistant" || !message.toolCalls?.length) return message;

    // @ts-ignore - TODO: strict typing
    const truncated = { ...message };
    // @ts-ignore - TODO: strict typing
    truncated.toolCalls = message.toolCalls.map((tc: Record<string, unknown>) => {
      if (!tc.result) return tc;

      const resultStr =
        typeof tc.result === "string" ? tc.result : JSON.stringify(tc.result);
      if (resultStr.length <= AGGRESSIVE_TOOL_RESULT_CAP) return tc;

      return {
        ...tc,
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
 *


 */
function compressOldAssistantMessages(
  messages: Record<string, unknown>,
  // @ts-ignore - TODO: strict typing
  protectedCount: Record<string, unknown> = PROTECTED_RECENT_TURNS,
) {
  // Count user turns from the end to determine protection boundary
  let userTurnsSeen = 0;
  let protectionIndex = messages.length;

  // @ts-ignore - TODO: strict typing
  for (let i = messages.length - 1; i >= 0; i--) {
    // @ts-ignore - TODO: strict typing
    if (messages[i].role === "user") {
      userTurnsSeen++;
      // @ts-ignore - TODO: strict typing
      if (userTurnsSeen >= protectedCount) {
        protectionIndex = i;
        break;
      }
    }
  }

  // @ts-ignore - TODO: strict typing
  return messages.map((message: string, i: Record<string, unknown>) => {
    // Never compress system messages, user messages, or protected recent messages
    // @ts-ignore - TODO: strict typing
    if (message.role === "system" || message.role === "user" || i >= protectionIndex) {
      return message;
    }

    // Compress assistant messages
    // @ts-ignore - TODO: strict typing
    if (message.role === "assistant") {
      // @ts-ignore - TODO: strict typing
      const compressed = { ...message };

      // Keep a short summary of what the assistant did
      const toolNames =
        // @ts-ignore - TODO: strict typing
        message.toolCalls?.map((tc: Record<string, unknown>) => tc.name).join(", ") || "";
      // @ts-ignore - TODO: strict typing
      const contentPreview = message.content?.slice(0, 200) || "";

      compressed.content = `[Earlier response${toolNames ? ` — used: ${toolNames}` : ""}]${contentPreview ? `\n${contentPreview}...` : ""}`;
      compressed.thinking = undefined;

      if (compressed.toolCalls) {
        compressed.toolCalls = compressed.toolCalls.map((tc: Record<string, unknown>) => ({
          ...tc,
          result: tc.result
            ? "[result truncated for context budget]"
            : undefined,
        }));
      }

      return compressed;
    }

    // Compress standalone tool messages
    // @ts-ignore - TODO: strict typing
    if (message.role === "tool") {
      return {
        // @ts-ignore - TODO: strict typing
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
 *


 */
function slidingWindowTruncation(messages: Record<string, unknown>, maxTokens: Record<string, unknown>) {
  // @ts-ignore - TODO: strict typing
  if (messages.length <= 3) return messages;

  // Always keep: system message, first user message
  const head: Record<string, unknown>[] = [];
  let headEnd = 0;

  // @ts-ignore - TODO: strict typing
  for (let i = 0; i < messages.length; i++) {
    // @ts-ignore - TODO: strict typing
    head.push(messages[i]);
    headEnd = i + 1;
    // @ts-ignore - TODO: strict typing
    if (messages[i].role === "user") break; // Stop after first user message
  }

  // Build tail from the end until we approach budget
  const tail: Record<string, unknown>[] = [];
  let tailTokens = 0;
  // @ts-ignore - TODO: strict typing
  const headTokens = estimateTotalTokens(head);
  // @ts-ignore - TODO: strict typing
  const availableForTail = maxTokens - headTokens - 200; // 200 token buffer for marker

  // @ts-ignore - TODO: strict typing
  for (let i = messages.length - 1; i >= headEnd; i--) {
    // @ts-ignore - TODO: strict typing
    const msgTokens = estimateMessageTokens(messages[i]);
    if (tailTokens + msgTokens > availableForTail) break;
    // @ts-ignore - TODO: strict typing
    tail.unshift(messages[i]);
    tailTokens += msgTokens;
  }

  // @ts-ignore - TODO: strict typing
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
   *


   * @returns {{ messages: Array, truncated: boolean, strategy: string|null, estimatedTokens: number }}
   */
  static enforce(messages: Record<string, unknown>, options: Record<string, unknown> = {}) {
    const {
      // @ts-ignore
      maxInputTokens = 128_000,
      // @ts-ignore
      maxOutputTokens = MIN_OUTPUT_RESERVE,
      // @ts-ignore
      toolCount = 0,
    } = options;

    // Calculate the effective token budget
    // @ts-ignore - TODO: strict typing
    const schemaOverhead = TOOL_SCHEMA_OVERHEAD_TOKENS + toolCount * 150;
    // @ts-ignore - TODO: strict typing
    const outputReserve = Math.max(maxOutputTokens, MIN_OUTPUT_RESERVE);
    const budget = Math.floor(
      // @ts-ignore - TODO: strict typing
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
    // @ts-ignore - TODO: strict typing
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

  /**
   * Estimate token count for messages (exposed for diagnostics).


   */
  static estimateTokens(messages: Record<string, unknown>) {
    return estimateTotalTokens(messages);
  }

  /**
   * Estimate tokens for a single message (exposed for diagnostics).


   */
  static estimateMessageTokens(message: string) {
    return estimateMessageTokens(message);
  }
}
