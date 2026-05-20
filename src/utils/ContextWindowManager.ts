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
    if ((message as any).content) {
    tokens += estimateTokens(
            typeof (message as any).content === "string"
                ? (message as any).content
                : JSON.stringify((message as any).content),
    );
  }

  // Thinking blocks
    if ((message as any).thinking) {
        tokens += estimateTokens((message as any).thinking);
  }

  // Tool calls (function name + args + results)
    if ((message as any).toolCalls && Array.isArray((message as any).toolCalls)) {
        for ( const tc of (message as any).toolCalls) {
      tokens += estimateTokens(tc.name || "");
            tokens += estimateTokens((tc.args ? JSON.stringify(tc.args) : "" as any));
      if (tc.result) {
        tokens += estimateTokens(
          typeof tc.result === "string" ? tc.result : JSON.stringify(tc.result),
        );
      }
    }
  }

  // Tool response content (standalone tool messages)
    if ((message as any).role === "tool" && (message as any).content) {
    tokens += estimateTokens(
            typeof (message as any).content === "string"
                ? (message as any).content
                : JSON.stringify((message as any).content),
    );
  }

  // Images (rough: ~1000 tokens per image reference)
    if ((message as any).images && Array.isArray((message as any).images)) {
        tokens += (message as any).images.length * 1000;
  }

  return tokens;
}

/**
 * Estimate total tokens across all messages.
 *


 */
function estimateTotalTokens(messages: any) {
    return (messages as any).reduce(
        (sum: any, message: string) => sum + estimateMessageTokens(message),
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
  messages: any,
    protectedTurns: any = PROTECTED_RECENT_TURNS,
) {
  // Find the protection boundary (same logic as compressOldAssistantMessages)
  let userTurnsSeen = 0;
  let protectionIndex = messages.length;

    for (let i = (messages as any).length - 1; i >= 0; i--) {
        if ((messages as any)[i].role === "user") {
      userTurnsSeen++;
            if (userTurnsSeen >= protectedTurns) {
        protectionIndex = i;
        break;
      }
    }
  }

    return (messages as any).map((message: string, i: any) => {
    // Never truncate tool results in recent (protected) messages
        if (i >= (protectionIndex as any)) return message;
        if ((message as any).role !== "assistant" || !(message as any).toolCalls?.length) return message;

        const truncated = { ...message };
        truncated.toolCalls = (message as any).toolCalls.map((tc: any) => {
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
  messages: any,
    protectedCount: any = PROTECTED_RECENT_TURNS,
) {
  // Count user turns from the end to determine protection boundary
  let userTurnsSeen = 0;
  let protectionIndex = messages.length;

    for (let i = (messages as any).length - 1; i >= 0; i--) {
        if ((messages as any)[i].role === "user") {
      userTurnsSeen++;
            if (userTurnsSeen >= protectedCount) {
        protectionIndex = i;
        break;
      }
    }
  }

    return (messages as any).map((message: string, i: any) => {
    // Never compress system messages, user messages, or protected recent messages
        if ((message as any).role === "system" || (message as any).role === "user" || i >= (protectionIndex as any)) {
      return message;
    }

    // Compress assistant messages
        if ((message as any).role === "assistant") {
            const compressed = { ...message };

      // Keep a short summary of what the assistant did
      const toolNames =
                (message as any).toolCalls?.map((tc: any) => tc.name).join(", ") || "";
            const contentPreview = (message as any).content?.slice(0, 200) || "";

      compressed.content = `[Earlier response${toolNames ? ` — used: ${toolNames}` : ""}]${contentPreview ? `\n${contentPreview}...` : ""}`;
      compressed.thinking = undefined;

      if (compressed.toolCalls) {
        compressed.toolCalls = compressed.toolCalls.map((tc: any) => ({
          ...tc,
          result: tc.result
            ? "[result truncated for context budget]"
            : undefined,
        }));
      }

      return compressed;
    }

    // Compress standalone tool messages
        if ((message as any).role === "tool") {
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
 *


 */
function slidingWindowTruncation(messages: any, maxTokens: any) {
    if ((messages as any).length <= 3) return messages;

  // Always keep: system message, first user message
  const head: any[] = [];
  let headEnd = 0;

    for (let i = 0; i < (messages as any).length; i++) {
        head.push((messages[i] as any));
    headEnd = i + 1;
        if ((messages as any)[i].role === "user") break; // Stop after first user message
  }

  // Build tail from the end until we approach budget
  const tail: any[] = [];
  let tailTokens = 0;
    const headTokens = estimateTotalTokens((head as any));
    const availableForTail = maxTokens - headTokens - 200; // 200 token buffer for marker

    for (let i = (messages as any).length - 1; i >= headEnd; i--) {
        const msgTokens = estimateMessageTokens((messages[i] as any));
    if (tailTokens + msgTokens > availableForTail) break;
        tail.unshift((messages[i] as any));
    tailTokens += msgTokens;
  }

    const droppedCount = (messages as any).length - head.length - tail.length;

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
  static enforce(messages: any, options: any = {}) {
    const {
            maxInputTokens = 128_000,
            maxOutputTokens = MIN_OUTPUT_RESERVE,
            toolCount = 0,
    } = options;

    // Calculate the effective token budget
        const schemaOverhead = TOOL_SCHEMA_OVERHEAD_TOKENS + (toolCount as any) * 150;
        const outputReserve = Math.max((maxOutputTokens as any), MIN_OUTPUT_RESERVE);
    const budget = Math.floor(
            ((maxInputTokens as any) - outputReserve - schemaOverhead) * TARGET_UTILIZATION,
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
        result = slidingWindowTruncation(result, (budget as any));
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
  static estimateTokens(messages: any) {
    return estimateTotalTokens(messages);
  }

  /**
   * Estimate tokens for a single message (exposed for diagnostics).


   */
  static estimateMessageTokens(message: string) {
    return estimateMessageTokens(message);
  }
}
