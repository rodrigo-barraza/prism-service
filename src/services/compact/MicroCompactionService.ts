import logger from "#src/utils/logger";
import { estimateTokens } from "#src/utils/CostCalculator";
import { TOOL_NAMES } from "#src/services/ToolTaxonomyConstants";
import ToolResultOffloadService, {
  OFFLOAD_STUB_HEADER,
  type OffloadMetadata,
} from "#src/services/compact/ToolResultOffloadService";
import type { ChatMessage, ToolCallEntry } from "#src/types/admin";
import { COMPACTION } from "#src/constants";

// ────────────────────────────────────────────────────────────
// MicroCompactionService — In-Memory Tool Result Eviction
// ────────────────────────────────────────────────────────────
// Modeled after claude-code/src/services/compact/microCompact.ts
//
// Before sending messages to the LLM, this service evicts large
// tool results from COMPACTABLE tools in old (unprotected) turns.
// This is the lightest compaction layer — no LLM call required.
//
// Eviction is LOSSLESS: each result is offloaded verbatim through
// ToolResultOffloadService and replaced inline with a pointer stub
// (offload id + first-lines preview) the model can dereference via
// retrieve_offloaded_content. The legacy destructive marker remains
// only as a fallback when offloading fails.
//
// Research basis (harness_landscape_survey_2026-07.md, A2 + A3):
//  - Strands Agents ContextOffloader (threshold-gated offload with
//    preview + retrieval pointers)
//  - LangChain DeepAgents FilesystemMiddleware (pointer + preview
//    substitution for oversized tool results)
//  - LCM, arXiv 2605.04050 (lossless pointers to originals)
//  - VISTA, arXiv 2606.30005 (recoverable eviction beats deletion)
//
// Claude Code equivalent:
//   const COMPACTABLE_TOOLS = new Set([
//     FILE_READ_TOOL_NAME, ...SHELL_TOOL_NAMES,
//     GREP_TOOL_NAME, GLOB_TOOL_NAME,
//     WEB_SEARCH_TOOL_NAME, WEB_FETCH_TOOL_NAME,
//     FILE_EDIT_TOOL_NAME, FILE_WRITE_TOOL_NAME,
//   ]);
// ────────────────────────────────────────────────────────────

/** Legacy destructive marker — used only when offloading fails. */
const CLEARED_RESULT_MARKER = "[Old tool result content cleared]";

const MINIMUM_RESULT_TOKEN_THRESHOLD = COMPACTION.MINIMUM_RESULT_TOKEN_THRESHOLD;

/** Number of recent user turns to never micro-compact. */
const PROTECTED_RECENT_TURNS = COMPACTION.PROTECTED_RECENT_TURNS;

/**
 * Tools whose results are safe to clear during micro-compaction.
 * These produce large outputs (file contents, shell output, search results)
 * that the model no longer needs once it has acted on them.
 *
 * Matches Claude Code's COMPACTABLE_TOOLS set from microCompact.ts.
 */
const COMPACTABLE_TOOLS: Set<string> = new Set([
  TOOL_NAMES.READ_FILE,
  TOOL_NAMES.EXECUTE_CODE,
  TOOL_NAMES.WEB_CONTENT,
  TOOL_NAMES.WEB_SEARCH,
  TOOL_NAMES.SEARCH_FILES,
  TOOL_NAMES.LIST_DIRECTORY,
  TOOL_NAMES.READ_IMAGE,
  TOOL_NAMES.PYTHON_INTERPRETER,
  TOOL_NAMES.JAVASCRIPT_INTERPRETER,
  TOOL_NAMES.SHELL,
  TOOL_NAMES.GENERATE_AUDIO,
]);

export interface MicroCompactionResult {
  messages: ChatMessage[];
  freedTokens: number;
  clearedResultCount: number;
  /** How many of the cleared results were losslessly offloaded (vs destroyed). */
  offloadedResultCount: number;
}

/**
 * Estimate token count for a tool result value.
 */
function estimateToolResultTokens(
  result: string | number | boolean | object | null | undefined | symbol,
): number {
  if (!result) return 0;
  const resultText =
    typeof result === "string" ? result : JSON.stringify(result);
  return estimateTokens(resultText);
}

/**
 * Find the protection boundary index — messages at or after this index
 * are in the "recent" window and should never be micro-compacted.
 */
function findProtectionBoundary(
  messages: ChatMessage[],
  protectedTurnCount: number,
): number {
  let userTurnsSeen = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      userTurnsSeen++;
      if (userTurnsSeen >= protectedTurnCount) {
        return i;
      }
    }
  }
  return 0;
}

export default class MicroCompactionService {
  /**
   * Evict old compactable tool results in-memory, offloading each
   * verbatim payload so it stays retrievable.
   *
   * Returns the modified messages array and the number of tokens freed.
   * Does NOT mutate the original array — returns a new one.
   */
  static microcompactMessages(
    messages: ChatMessage[],
    protectedTurnCount: number = PROTECTED_RECENT_TURNS,
    offloadMetadata: OffloadMetadata = {},
  ): MicroCompactionResult {
    const protectionBoundary = findProtectionBoundary(
      messages,
      protectedTurnCount,
    );

    let freedTokens = 0;
    let clearedResultCount = 0;
    let offloadedResultCount = 0;

    const compactedMessages = messages.map((message, index) => {
      // Never touch protected (recent) messages
      if (index >= protectionBoundary) return message;

      // Only process assistant messages with tool calls
      if (message.role !== "assistant" || !message.toolCalls?.length)
        return message;

      let messageModified = false;
      const compactedToolCalls = message.toolCalls.map(
        (toolCall: ToolCallEntry) => {
          // Skip tools not in the compactable set
          if (!COMPACTABLE_TOOLS.has(toolCall.name)) return toolCall;

          // Skip tool calls with no result or small results
          if (!toolCall.result) return toolCall;

          // Skip results already evicted to a pointer stub
          if (
            typeof toolCall.result === "string" &&
            toolCall.result.startsWith(OFFLOAD_STUB_HEADER)
          )
            return toolCall;

          const resultTokens = estimateToolResultTokens(toolCall.result);
          if (resultTokens < MINIMUM_RESULT_TOKEN_THRESHOLD) return toolCall;

          // Evict: offload verbatim, replace inline with the pointer stub.
          // Fall back to the legacy destructive marker if offloading throws.
          let replacement: string;
          try {
            replacement = ToolResultOffloadService.offloadToolResult(
              toolCall,
              offloadMetadata,
            );
            offloadedResultCount++;
          } catch (error) {
            logger.error(
              `[MicroCompaction] Offload failed for ${toolCall.name} — falling back to destructive clear: ${error instanceof Error ? error.message : String(error)}`,
            );
            replacement = CLEARED_RESULT_MARKER;
          }

          messageModified = true;
          freedTokens += Math.max(
            0,
            resultTokens - estimateTokens(replacement),
          );
          clearedResultCount++;
          return {
            ...toolCall,
            result: replacement,
          };
        },
      );

      if (!messageModified) return message;

      return {
        ...message,
        toolCalls: compactedToolCalls,
      };
    });

    if (clearedResultCount > 0) {
      logger.info(
        `[MicroCompaction] Evicted ${clearedResultCount} old tool results ` +
          `(${offloadedResultCount} offloaded losslessly), freed ~${freedTokens} tokens`,
      );
    }

    return {
      messages: compactedMessages,
      freedTokens,
      clearedResultCount,
      offloadedResultCount,
    };
  }
}
