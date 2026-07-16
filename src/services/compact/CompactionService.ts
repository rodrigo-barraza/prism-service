import crypto from "crypto";
import { getProvider } from "#src/providers/index";
import SettingsService from "#src/services/SettingsService";
import RequestLogger from "#src/services/RequestLogger";
import logger from "#src/utils/logger";
import { errorMessage } from "@rodrigo-barraza/utilities-library";
import { PROMPT_DELIMITERS, COMPACTION } from "#src/constants";
import {
  SERVER_SENT_EVENT_TYPES,
  STATUS_MESSAGES,
} from "@rodrigo-barraza/utilities-library/taxonomy";
import {
  estimateTokens,
  calculateTextCost,
} from "#src/utils/CostCalculator";
import { MODALITY_TYPES, getPricing } from "#src/config";
import {
  COMPACTION_SYSTEM_PROMPT,
  COMPACTION_USER_PROMPT,
  COMPACTION_JUDGE_SYSTEM_PROMPT,
  buildCompactionJudgeUserPrompt,
  extractSummaryFromResponse,
  stripImagesFromMessages,
} from "./CompactionPrompt.ts";
import type { ChatMessage as AdminChatMessage } from "#src/types/admin";
import type { ChatMessage, GenerateTextResult } from "#src/types/provider";
import type { EmitFunction } from "#src/services/harnesses/types";

// ────────────────────────────────────────────────────────────
// CompactionService — LLM-Powered Conversation Summarization
// ────────────────────────────────────────────────────────────
// Modeled after claude-code/src/services/compact/compact.ts
//
// Instead of mechanically truncating messages, this service calls
// an LLM to produce a structured summary of the conversation.
// The summary replaces all pre-boundary messages, preserving
// user intent, code context, error history, and pending tasks.
//
// Claude Code reference (compactConversation):
//   1. Strip images from messages
//   2. Build summarization request with COMPACTION_PROMPT
//   3. Call LLM (forked agent, maxTurns: 1)
//   4. Extract <summary> from response (strip <analysis> scratchpad)
//   5. Build compacted array: [boundary, summary, ...recentTail]
//
// Key constants from Claude Code:
//   COMPACT_MAX_OUTPUT_TOKENS = 16_384
//   MAX_COMPACT_STREAMING_RETRIES = 2
//   MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3
// ────────────────────────────────────────────────────────────

const COMPACT_MAX_OUTPUT_TOKENS = COMPACTION.COMPACT_MAX_OUTPUT_TOKENS;

/**
 * Circuit breaker: stop retrying after this many consecutive failures.
 *
 * From claude-code/src/services/compact/autoCompact.ts:
 *   "BQ 2026-03-10: 1,279 sessions had 50+ consecutive failures
 *    (up to 3,272) in a single session, wasting ~250K API calls/day globally."
 */
const MAX_CONSECUTIVE_COMPACT_FAILURES = COMPACTION.MAX_CONSECUTIVE_COMPACT_FAILURES;

export interface CompactionResult {
  compactedMessages: AdminChatMessage[];
  summaryText: string;
  preCompactTokenCount: number;
  postCompactTokenCount: number;
  compactionUsage: { inputTokens: number; outputTokens: number };
}

interface CompactionOptions {
  project: string;
  username: string;
  agentConversationId?: string;
  traceId?: string | null;
  agent?: string | null;
  emit?: EmitFunction | null;
  signal?: AbortSignal;
  /** Conversation's own provider — used when no compaction model is configured. */
  fallbackProvider?: string;
  /** Conversation's own model — used when no compaction model is configured. */
  fallbackModel?: string;
}

interface MemorySettingsSection {
  extractionProvider?: string;
  extractionModel?: string;
}

function estimateTotalTokens(messages: AdminChatMessage[]): number {
  return messages.reduce((sum, message) => {
    let tokens = 4;
    if (message.content) {
      tokens += estimateTokens(
        typeof message.content === "string"
          ? message.content
          : JSON.stringify(message.content),
      );
    }
    if (message.thinking) tokens += estimateTokens(message.thinking);
    if (message.toolCalls) {
      for (const toolCall of message.toolCalls) {
        tokens += estimateTokens(toolCall.name || "");
        tokens += estimateTokens(
          toolCall.args ? JSON.stringify(toolCall.args) : "",
        );
        if (toolCall.result) {
          tokens += estimateTokens(
            typeof toolCall.result === "string"
              ? toolCall.result
              : JSON.stringify(toolCall.result),
          );
        }
      }
    }
    return sum + tokens;
  }, 0);
}

export default class CompactionService {
  private static consecutiveFailures = 0;

  /**
   * Summarize a conversation using an LLM call.
   *
   * Returns the compacted message array: [system, summary, ...recentTail]
   * or null if compaction was skipped or failed.
   *
   * Modeled after claude-code compactConversation() which:
   *   1. Strips images (saves tokens)
   *   2. Sends full conversation + summarization prompt to a forked agent
   *   3. Extracts <summary> from the response
   *   4. Builds: [CompactBoundary, SummaryUserMessage, ...recentTail]
   */
  static async compactConversation(
    messages: AdminChatMessage[],
    options: CompactionOptions,
  ): Promise<CompactionResult | null> {
    // ── Circuit breaker ────────────────────────────────────────
    if (this.consecutiveFailures >= MAX_CONSECUTIVE_COMPACT_FAILURES) {
      logger.warn(
        `[CompactionService] Circuit breaker open: ${this.consecutiveFailures} consecutive failures. Skipping compaction.`,
      );
      return null;
    }

    // ── Resolve compaction model from settings ─────────────────
    // Uses the same provider/model config path as MemoryExtractor
    let compactionProvider: string | undefined;
    let compactionModel: string | undefined;
    try {
      const memorySettings = (await SettingsService.getSection(
        "memory",
      )) as MemorySettingsSection;
      compactionProvider = memorySettings?.extractionProvider;
      compactionModel = memorySettings?.extractionModel;
    } catch {
      /* Settings not configured — fall through to the fallback below */
    }

    // Silently skipping compaction means silent context blowups (the loop
    // keeps growing until the provider rejects the request). When no cheap
    // compaction model is configured, fall back to the conversation's own
    // provider/model rather than not compacting at all.
    if (!compactionProvider || !compactionModel) {
      if (options.fallbackProvider && options.fallbackModel) {
        compactionProvider = options.fallbackProvider;
        compactionModel = options.fallbackModel;
        logger.warn(
          `[CompactionService] No compaction model configured in Settings → Memory Models — ` +
            `falling back to the conversation model (${compactionProvider}/${compactionModel}). ` +
            `Configure a cheap utility model to reduce compaction cost.`,
        );
      } else {
        logger.warn(
          "[CompactionService] No compaction model configured and no fallback available. Skipping.",
        );
        return null;
      }
    }

    const preCompactTokenCount = estimateTotalTokens(messages);

    // ── Strip images before summarizing ────────────────────────
    // Claude Code equivalent: stripImagesFromMessages() in compact.ts
    const strippedMessages = stripImagesFromMessages(messages);

    // ── Build the conversation text for summarization ──────────
    // Build a compact text representation of the conversation
    // (same approach as MemoryExtractor — compact format saves tokens)
    const conversationText = strippedMessages
      .map((message) => {
        const role = message.role;
        const content =
          typeof message.content === "string" ? message.content : "";

        // Include tool call summaries for context
        const toolSummary = message.toolCalls?.length
          ? `\n[Tools used: ${message.toolCalls
              .map((toolCall) => {
                const resultPreview = toolCall.result
                  ? typeof toolCall.result === "string"
                    ? toolCall.result.slice(0, 300)
                    : JSON.stringify(toolCall.result).slice(0, 300)
                  : "";
                return `${toolCall.name}(${resultPreview ? `→ ${resultPreview}...` : ""})`;
              })
              .join(", ")}]`
          : "";

        return `${role}: ${content}${toolSummary}`;
      })
      .join("\n\n");

    // ── Build summarization messages ───────────────────────────
    const summarizationMessages: ChatMessage[] = [
      { role: "system", content: COMPACTION_SYSTEM_PROMPT },
      {
        role: "user",
        content: `Here is the conversation to summarize:\n\n${conversationText}\n\n${COMPACTION_USER_PROMPT}`,
      },
    ];

    // ── Call the LLM ──────────────────────────────────────────
    options.emit?.({
      type: SERVER_SENT_EVENT_TYPES.STATUS,
      message: STATUS_MESSAGES.COMPACTION_STARTED,
    });

    const requestId = crypto.randomUUID();
    const requestStart = performance.now();
    let result: GenerateTextResult | undefined;
    let success = true;
    let compactionError: string | null = null;

    try {
      const provider = getProvider(compactionProvider);
      result = await provider.generateText(
        summarizationMessages,
        compactionModel,
        {
          maxTokens: COMPACT_MAX_OUTPUT_TOKENS,
          temperature: 0.1,
          // Utility call — never burn extended thinking on summarization.
          thinkingEnabled: false,
          reasoningEffort: "none",
        },
      );
    } catch (error: unknown) {
      success = false;
      compactionError = errorMessage(error);
      this.consecutiveFailures++;
      logger.error(
        `[CompactionService] LLM call failed (failure ${this.consecutiveFailures}/${MAX_CONSECUTIVE_COMPACT_FAILURES}): ${compactionError}`,
      );
      options.emit?.({
        type: SERVER_SENT_EVENT_TYPES.STATUS,
        message: STATUS_MESSAGES.COMPACTION_FAILED,
      });
      return null;
    } finally {
      // Log the compaction LLM call for cost tracking
      const realUsage = result?.usage || null;
      RequestLogger.logBackgroundLlmCall({
        requestId,
        endpoint: "/agent",
        operation: "compact:summarize",
        project: options.project,
        username: options.username,
        agent: options.agent || null,
        provider: compactionProvider,
        model: compactionModel,
        traceId: options.traceId || null,
        agentConversationId: options.agentConversationId || null,
        aiMessages: summarizationMessages as Parameters<
          typeof RequestLogger.logBackgroundLlmCall
        >[0]["aiMessages"],
        resultText: result?.text || "",
        usage: realUsage,
        success,
        errorMessage: compactionError,
        requestStartMilliseconds: requestStart,
        extraRequestPayload: {
          operation: "compact:summarize",
          preCompactTokenCount,
          messageCount: messages.length,
        },
      });
    }

    // ── Extract summary from response ─────────────────────────
    let summaryText = extractSummaryFromResponse(result!.text);
    if (!summaryText) {
      this.consecutiveFailures++;
      logger.warn(
        `[CompactionService] LLM returned no extractable summary. Failure ${this.consecutiveFailures}/${MAX_CONSECUTIVE_COMPACT_FAILURES}`,
      );
      options.emit?.({
        type: SERVER_SENT_EVENT_TYPES.STATUS,
        message: STATUS_MESSAGES.COMPACTION_FAILED,
      });
      return null;
    }

    // ── Judge pass: validate the summary before adopting it ───
    // One cheap synchronous call that checks the candidate summary
    // against the verbatim tail the agent will continue from, and
    // patches critical omissions (Slipstream's trajectory-grounded
    // judge, arXiv 2605.08580 — synchronous slice only; the async
    // compactor half is deliberately skipped). Fail-open: any judge
    // error keeps the original summary.
    summaryText = await validateSummaryAgainstTail(
      summaryText,
      extractRecentTail(messages),
      { compactionProvider, compactionModel, options, preCompactTokenCount },
    );

    // ── Build compacted message array ─────────────────────────
    // Structure: [system prompt, summary as user message, ...recent tail]
    const systemMessage = messages.find((message) => message.role === "system");
    const compactedMessages: AdminChatMessage[] = [];

    if (systemMessage) {
      compactedMessages.push(systemMessage);
    }

    // Insert the summary as a user message with a marker
    compactedMessages.push({
      role: "user",
      content: `${PROMPT_DELIMITERS.CONVERSATION_SUMMARY_PREFIX} — auto-generated by compaction]\n\n${summaryText}`,
      isCompactSummary: true,
    });

    // Append recent tail (last few turns the model is actively reasoning about)
    const recentTail = extractRecentTail(messages);
    compactedMessages.push(...recentTail);

    const postCompactTokenCount = estimateTotalTokens(compactedMessages);

    // ── Shrink guard ───────────────────────────────────────────
    // If the "compacted" conversation is not actually smaller (a tail-heavy
    // history can produce summary-of-summary growth), keep the original
    // messages — repeated compaction of a non-shrinking history only burns
    // LLM calls and can loop.
    if (postCompactTokenCount >= preCompactTokenCount) {
      this.consecutiveFailures++;
      logger.warn(
        `[CompactionService] Compaction did not shrink the conversation ` +
          `(${preCompactTokenCount} → ${postCompactTokenCount} tokens). Discarding result.`,
      );
      options.emit?.({
        type: SERVER_SENT_EVENT_TYPES.STATUS,
        message: STATUS_MESSAGES.COMPACTION_FAILED,
      });
      return null;
    }

    // ── Reset circuit breaker on success ──────────────────────
    this.consecutiveFailures = 0;

    logger.info(
      `[CompactionService] Compaction complete: ${preCompactTokenCount} → ${postCompactTokenCount} tokens ` +
        `(${Math.round((1 - postCompactTokenCount / preCompactTokenCount) * 100)}% reduction, ` +
        `${messages.length} → ${compactedMessages.length} messages)`,
    );

    options.emit?.({
      type: SERVER_SENT_EVENT_TYPES.STATUS,
      message: STATUS_MESSAGES.COMPACTION_COMPLETE,
      preCompactTokens: preCompactTokenCount,
      postCompactTokens: postCompactTokenCount,
    });

    // Emit usage for the compaction call so the UI token badge updates
    if (options.emit && result?.usage) {
      try {
        const compactPricing = getPricing(MODALITY_TYPES.TEXT, MODALITY_TYPES.TEXT)[
          compactionModel
        ];
        const compactCost = compactPricing
          ? calculateTextCost(
              {
                inputTokens: result.usage.inputTokens || 0,
                outputTokens: result.usage.outputTokens || 0,
              },
              compactPricing,
            )
          : null;
        options.emit({
          type: SERVER_SENT_EVENT_TYPES.USAGE_UPDATE,
          operation: "compact:summarize",
          usage: {
            requests: 1,
            inputTokens: result.usage.inputTokens || 0,
            outputTokens: result.usage.outputTokens || 0,
            estimatedCost: compactCost,
          },
        });
      } catch {
        /* SSE channel may be closed */
      }
    }

    return {
      compactedMessages,
      summaryText,
      preCompactTokenCount,
      postCompactTokenCount,
      compactionUsage: result!.usage || { inputTokens: 0, outputTokens: 0 },
    };
  }

  /** Reset the circuit breaker (for testing or session boundaries). */
  static resetCircuitBreaker(): void {
    this.consecutiveFailures = 0;
  }
}

// ── Helper: Extract recent conversation tail ──────────────────

/**
 * Extract the most recent user turns and their assistant responses.
 * These are appended after the summary so the model has immediate
 * context to continue from.
 *
 * Claude Code equivalent: the "messagesToKeep" logic in compact.ts
 * which preserves the last N turns after compaction.
 */
const RECENT_TAIL_TURN_COUNT = COMPACTION.RECENT_TAIL_TURN_COUNT;

function extractRecentTail(messages: AdminChatMessage[]): AdminChatMessage[] {
  // Walk backwards counting user turns
  let userTurnsSeen = 0;
  // Default to 0 so that if the conversation has fewer user turns than
  // RECENT_TAIL_TURN_COUNT, we preserve all messages (except system)
  // in the tail instead of discarding the entire history.
  let tailStartIndex = 0;

  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      userTurnsSeen++;
      if (userTurnsSeen >= RECENT_TAIL_TURN_COUNT) {
        tailStartIndex = i;
        break;
      }
    }
  }

  // Extract the tail, skipping system messages (already in compactedMessages)
  return messages
    .slice(tailStartIndex)
    .filter((message) => message.role !== "system");
}

// ─── Summary Judge (Slipstream, arXiv 2605.08580) ───────────
/**
 * Validate a candidate compaction summary against the verbatim tail the
 * agent will continue from, and patch critical omissions by appending
 * them. This is Slipstream's trajectory-grounded judge reduced to its
 * synchronous slice — one cheap utility call at a moment we are already
 * paying for a compaction. The judge sees the summary + tail (not the
 * full pre-compaction conversation — re-reading that would double the
 * compaction's input cost), so it catches reference gaps: facts the
 * continuation visibly depends on that the summary dropped.
 *
 * Fail-open: any error, timeout, or malformed reply keeps the original
 * summary — the judge can only ever add, never block a compaction.
 * https://arxiv.org/abs/2605.08580
 */
async function validateSummaryAgainstTail(
  summaryText: string,
  recentTail: AdminChatMessage[],
  {
    compactionProvider,
    compactionModel,
    options,
    preCompactTokenCount,
  }: {
    compactionProvider: string;
    compactionModel: string;
    options: CompactionOptions;
    preCompactTokenCount: number;
  },
): Promise<string> {
  const tailText = recentTail
    .map((message) => {
      const content =
        typeof message.content === "string" ? message.content : "";
      const tools = message.toolCalls?.length
        ? ` [tools: ${message.toolCalls.map((toolCall) => toolCall.name).join(", ")}]`
        : "";
      return `${message.role}: ${content}${tools}`;
    })
    .join("\n\n");
  if (!tailText.trim()) return summaryText;

  const judgeMessages: ChatMessage[] = [
    { role: "system", content: COMPACTION_JUDGE_SYSTEM_PROMPT },
    {
      role: "user",
      content: buildCompactionJudgeUserPrompt(summaryText, tailText),
    },
  ];

  const requestId = crypto.randomUUID();
  const requestStart = performance.now();
  let judgeResult: GenerateTextResult | undefined;
  let success = true;
  let judgeError: string | null = null;

  try {
    const provider = getProvider(compactionProvider);
    judgeResult = await provider.generateText(judgeMessages, compactionModel, {
      maxTokens: COMPACTION.JUDGE_MAX_OUTPUT_TOKENS,
      temperature: 0,
      thinkingEnabled: false,
      reasoningEffort: "none",
    });
  } catch (error: unknown) {
    success = false;
    judgeError = errorMessage(error);
    logger.warn(
      `[CompactionService] Summary judge failed (keeping original summary): ${judgeError}`,
    );
    return summaryText;
  } finally {
    RequestLogger.logBackgroundLlmCall({
      requestId,
      endpoint: "/agent",
      operation: "compact:judge",
      project: options.project,
      username: options.username,
      agent: options.agent || null,
      provider: compactionProvider,
      model: compactionModel,
      traceId: options.traceId || null,
      agentConversationId: options.agentConversationId || null,
      aiMessages: judgeMessages as Parameters<
        typeof RequestLogger.logBackgroundLlmCall
      >[0]["aiMessages"],
      resultText: judgeResult?.text || "",
      usage: judgeResult?.usage || null,
      success,
      errorMessage: judgeError,
      requestStartMilliseconds: requestStart,
      extraRequestPayload: {
        operation: "compact:judge",
        preCompactTokenCount,
      },
    });
  }

  const responseText = judgeResult?.text || "";
  const additionsMatch = responseText.match(
    /<additions>([\s\S]*?)<\/additions>/i,
  );
  if (!additionsMatch?.[1]?.trim()) {
    return summaryText;
  }
  const additions = additionsMatch[1].trim();
  logger.info(
    `[CompactionService] Summary judge patched ${additions.split("\n").length} omission(s) into the summary`,
  );
  return `${summaryText}\n\n## Validation additions (facts the continuation depends on)\n${additions}`;
}
