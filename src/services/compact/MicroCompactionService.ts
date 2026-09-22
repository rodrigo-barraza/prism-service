import logger from "#src/utils/logger";
import { estimateTokens } from "#src/utils/CostCalculator";
import { TOOL_NAMES } from "#src/services/ToolTaxonomyConstants";
import ToolResultOffloadService, {
  OFFLOAD_STUB_HEADER,
  type OffloadMetadata,
} from "#src/services/compact/ToolResultOffloadService";
import type { ChatMessage, ToolCallEntry } from "#src/types/admin";
import { COMPACTION } from "#src/constants";
import {
  findRecencyBoundary,
  type RecencyProtection,
} from "#src/services/compact/RecencyProtection";
import { markDerivedMessage } from "#src/services/compact/MessageLineage";

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

/**
 * Tools whose results are safe to clear during micro-compaction.
 * These produce large outputs (file contents, shell output, search results)
 * that the model no longer needs once it has acted on them.
 *
 * Matches Claude Code's COMPACTABLE_TOOLS set from microCompact.ts. Named
 * by the tools that actually run (tools-service `read_url`, `read_web_page`,
 * `search_web`, `read_files`, `search_file_contents`, `execute_shell`) — the
 * generic WEB_CONTENT / WEB_SEARCH names match no tool-service tool, so
 * until 2026-09 web and multi-file results were never offloaded.
 */
const COMPACTABLE_TOOLS: Set<string> = new Set([
  TOOL_NAMES.READ_FILE,
  TOOL_NAMES.MULTI_FILE_READ,
  TOOL_NAMES.GREP_SEARCH,
  TOOL_NAMES.EXECUTE_CODE,
  TOOL_NAMES.EXECUTE_SHELL,
  TOOL_NAMES.WEB_CONTENT,
  TOOL_NAMES.WEB_SEARCH,
  TOOL_NAMES.READ_URL,
  TOOL_NAMES.READ_WEB_PAGE,
  TOOL_NAMES.SEARCH_WEB,
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

export default class MicroCompactionService {
  /**
   * Evict old compactable tool results in-memory, offloading each
   * verbatim payload so it stays retrievable. "Old" is by recency of model
   * calls (RecencyProtection.ts), so earlier iterations of the current run
   * are eligible — a long single run no longer grows linearly.
   *
   * Returns the modified messages array and the number of tokens freed.
   * Does NOT mutate the original array — returns a new one; each copied
   * message is registered with MessageLineage so persistence still writes
   * the verbatim result.
   */
  static microcompactMessages(
    messages: ChatMessage[],
    protection: RecencyProtection = {},
    offloadMetadata: OffloadMetadata = {},
  ): MicroCompactionResult {
    const protectionBoundary = findRecencyBoundary(messages, protection);

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

      return markDerivedMessage(
        {
          ...message,
          toolCalls: compactedToolCalls,
        },
        message,
      );
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
