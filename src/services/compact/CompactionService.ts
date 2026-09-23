import crypto from "crypto";
import { getProvider } from "#src/providers/index";
import ModelRoleRouter, { MODEL_ROLES } from "#src/services/ModelRoleRouter";
import RequestLogger from "#src/services/RequestLogger";
import logger from "#src/utils/logger";
import { errorMessage } from "@rodrigo-barraza/utilities-library";
import { COMPACTION } from "#src/constants";
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
import ToolResultOffloadService, {
  OFFLOAD_STUB_HEADER,
  type OffloadMetadata,
} from "./ToolResultOffloadService.ts";
import { findRecencyBoundary } from "./RecencyProtection.ts";
import { markDerivedMessage } from "./MessageLineage.ts";
import {
  buildCompactionSummaryMessage,
  resolveBoundaryAnchorId,
  type CompactionBoundary,
} from "./CompactionBoundary.ts";
import { SYSTEM_MESSAGE_TAGS } from "#src/utils/SystemMessageTags";
import type { ChatMessage as AdminChatMessage } from "#src/types/admin";
import type { ChatMessage, GenerateTextResult } from "#src/types/provider";
import type { EmitFunction } from "#src/services/harnesses/types";
import {
  untrustedInputProvenance,
  type ProvenanceMessage,
} from "#src/services/memory/MemoryProvenance";

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
 * Circuit breaker: stop retrying after this many consecutive failures —
 * per conversation. Claude Code's breaker is per session; a process-wide
 * one (what this was until 2026-09) let three failures anywhere disable
 * compaction for every conversation until restart.
 *
 * From claude-code/src/services/compact/autoCompact.ts:
 *   "BQ 2026-03-10: 1,279 sessions had 50+ consecutive failures
 *    (up to 3,272) in a single session, wasting ~250K API calls/day globally."
 */
const MAX_CONSECUTIVE_COMPACT_FAILURES = COMPACTION.MAX_CONSECUTIVE_COMPACT_FAILURES;

/** Breaker key for calls that carry no conversation id (tests, one-off callers). */
const UNSCOPED_BREAKER_KEY = "__unscoped__";

interface BreakerEntry {
  /** Consecutive LLM failures (call error, no extractable summary). */
  failures: number;
  /** History size at the last shrink-guard bail-out — retried only once it grows. */
  noShrinkAtTokens: number | null;
  updatedAt: number;
}

export interface CompactionResult {
  compactedMessages: AdminChatMessage[];
  summaryText: string;
  preCompactTokenCount: number;
  postCompactTokenCount: number;
  compactionUsage: { inputTokens: number; outputTokens: number };
  /**
   * The boundary to persist, so the next turn loads summary + tail instead
   * of re-summarizing. Null when the covered span ends in a message that
   * cannot be addressed (persisted before message ids existed).
   */
  boundary: CompactionBoundary | null;
}

/** Why an attempt produced no compaction — the truncation fallback logs it. */
export type CompactionSkipReason =
  | "breaker_open"
  | "nothing_to_summarize"
  | "no_shrink_cooldown"
  | "no_model"
  | "failed"
  | "did_not_shrink";

export interface CompactionAttempt {
  result: CompactionResult | null;
  skipReason: CompactionSkipReason | null;
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

const DEVIATION_REMINDER_TAG_OPEN = `<${SYSTEM_MESSAGE_TAGS.DEVIATION_REMINDER}>`;

/**
 * Mid-stream deviation-rule reminders (DeviationRuleEngine) are active
 * behavioral guards — dropping one during compaction re-opens the exact
 * loop it was injected to break. They are the one class of system message
 * that must survive compaction verbatim.
 */
function isDeviationReminderMessage(message: AdminChatMessage): boolean {
  return (
    message.role === "system" &&
    typeof message.content === "string" &&
    message.content.includes(DEVIATION_REMINDER_TAG_OPEN)
  );
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
  private static breakers = new Map<string, BreakerEntry>();

  private static breakerKey(conversationId?: string | null): string {
    return conversationId || UNSCOPED_BREAKER_KEY;
  }

  /** Drop entries idle past the TTL, then return this key's entry. */
  private static breakerEntry(key: string): BreakerEntry | undefined {
    const now = Date.now();
    for (const [entryKey, entry] of this.breakers) {
      if (now - entry.updatedAt > COMPACTION.CIRCUIT_BREAKER_TTL_MILLISECONDS) {
        this.breakers.delete(entryKey);
      }
    }
    return this.breakers.get(key);
  }

  private static touchBreaker(key: string): BreakerEntry {
    const entry = this.breakerEntry(key) || {
      failures: 0,
      noShrinkAtTokens: null,
      updatedAt: Date.now(),
    };
    entry.updatedAt = Date.now();
    this.breakers.set(key, entry);
    return entry;
  }

  private static recordFailure(key: string): number {
    const entry = this.touchBreaker(key);
    entry.failures++;
    return entry.failures;
  }

  /** Whether compaction is disabled for this conversation (null → unscoped callers). */
  static isCircuitBreakerOpen(conversationId?: string | null): boolean {
    const entry = this.breakerEntry(this.breakerKey(conversationId));
    return (entry?.failures ?? 0) >= MAX_CONSECUTIVE_COMPACT_FAILURES;
  }

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
    return (await this.attemptCompaction(messages, options)).result;
  }

  /** compactConversation, plus why nothing was compacted when it wasn't. */
  static async attemptCompaction(
    messages: AdminChatMessage[],
    options: CompactionOptions,
  ): Promise<CompactionAttempt> {
    const breakerKey = this.breakerKey(options.agentConversationId);
    const skip = (skipReason: CompactionSkipReason): CompactionAttempt => ({
      result: null,
      skipReason,
    });

    // ── Circuit breaker (this conversation only) ──────────────
    if (this.isCircuitBreakerOpen(options.agentConversationId)) {
      logger.warn(
        `[CompactionService] Circuit breaker open for ${breakerKey}: ` +
          `${MAX_CONSECUTIVE_COMPACT_FAILURES} consecutive failures. Skipping compaction.`,
      );
      return skip("breaker_open");
    }

    // ── Split: recent window stays verbatim, the rest is summarized ──
    const recentTail = extractRecentTail(messages);
    const systemMessage = messages.find((message) => message.role === "system");
    const recentTailSet = new Set<AdminChatMessage>(recentTail);
    const droppedSpan = messages.filter(
      (message) => message !== systemMessage && !recentTailSet.has(message),
    );
    if (!droppedSpan.some((message) => message.role !== "system")) {
      logger.info(
        `[CompactionService] Nothing older than the protected recent window — skipping compaction (${breakerKey}).`,
      );
      return skip("nothing_to_summarize");
    }

    const preCompactTokenCount = estimateTotalTokens(messages);

    // ── Shrink-guard cooldown ─────────────────────────────────
    // A history that already failed to shrink is not re-summarized until it
    // has grown — the same input would fail the same way, for the same price.
    const cooldownEntry = this.breakerEntry(breakerKey);
    if (
      cooldownEntry?.noShrinkAtTokens != null &&
      preCompactTokenCount <
        cooldownEntry.noShrinkAtTokens *
          (1 + COMPACTION.NO_SHRINK_RETRY_GROWTH_FRACTION)
    ) {
      logger.info(
        `[CompactionService] Skipping compaction for ${breakerKey}: the last summary did not shrink a ` +
          `${cooldownEntry.noShrinkAtTokens}-token history and it is only ${preCompactTokenCount} tokens now.`,
      );
      return skip("no_shrink_cooldown");
    }

    // ── Resolve the compaction model through its role ──
    // Silently skipping compaction means silent context blowups (the loop
    // keeps growing until the provider rejects the request), so the chain
    // is never empty while any model exists: the agent's compaction pin →
    // env/DB compaction config → env/DB utility config → the
    // conversation's own model → local-instance/cheap-cloud defaults.
    const roleChain = await ModelRoleRouter.resolveChain(MODEL_ROLES.COMPACTION, {
      agents: [options.agent],
      fallback:
        options.fallbackProvider && options.fallbackModel
          ? {
              provider: options.fallbackProvider,
              model: options.fallbackModel,
            }
          : null,
    });
    if (roleChain.length === 0) {
      logger.error(
        "[CompactionService] Utility role resolved to an empty model chain — cannot compact.",
      );
      return skip("no_model");
    }
    // Updated per attempt inside the chain runner so the request log
    // records whichever model actually served the call.
    let compactionProvider = roleChain[0].provider;
    let compactionModel = roleChain[0].model;

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
      ({ value: result } = await ModelRoleRouter.runWithChain(
        roleChain,
        async (entry) => {
          compactionProvider = entry.provider;
          compactionModel = entry.model;
          return getProvider(entry.provider).generateText(
            summarizationMessages,
            entry.model,
            {
              maxTokens: COMPACT_MAX_OUTPUT_TOKENS,
              temperature: 0.1,
              // Utility call — never burn extended thinking on summarization.
              thinkingEnabled: false,
              reasoningEffort: "none",
            },
          );
        },
        { role: MODEL_ROLES.COMPACTION, operation: "compact:summarize" },
      ));
    } catch (error: unknown) {
      success = false;
      compactionError = errorMessage(error);
      const failures = this.recordFailure(breakerKey);
      logger.error(
        `[CompactionService] LLM call failed for ${breakerKey} (failure ${failures}/${MAX_CONSECUTIVE_COMPACT_FAILURES}): ${compactionError}`,
      );
      options.emit?.({
        type: SERVER_SENT_EVENT_TYPES.STATUS,
        message: STATUS_MESSAGES.COMPACTION_FAILED,
      });
      return skip("failed");
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
      const failures = this.recordFailure(breakerKey);
      logger.warn(
        `[CompactionService] LLM returned no extractable summary for ${breakerKey}. Failure ${failures}/${MAX_CONSECUTIVE_COMPACT_FAILURES}`,
      );
      options.emit?.({
        type: SERVER_SENT_EVENT_TYPES.STATUS,
        message: STATUS_MESSAGES.COMPACTION_FAILED,
      });
      return skip("failed");
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
      recentTail,
      { compactionProvider, compactionModel, options, preCompactTokenCount },
    );

    // ── Build compacted message array ─────────────────────────
    // Structure: [system prompt, summary as user message, ...recent tail]
    const compactedMessages: AdminChatMessage[] = [];

    if (systemMessage) {
      compactedMessages.push(systemMessage);
    }

    // ── Lossless dropped-span offload ─────────────────────────
    // The summary replaces every message before the recent tail — normally
    // a lossy operation. Before discarding them, offload the large tool
    // results in that dropped span verbatim (same store micro-compaction
    // uses) and append a recovery index to the summary, so the model can
    // still pull back an exact value the summary glossed over. Mirrors A2's
    // offload for LLM compaction (survey follow-up).
    const offloadIndex = offloadDroppedSpanResults(
      messages,
      recentTail,
      systemMessage,
      {
        conversationId: options.agentConversationId || null,
        project: options.project || null,
        username: options.username || null,
      },
    );
    const summaryWithRecovery = offloadIndex
      ? `${summaryText}\n\n## Recoverable offloaded tool results\nThese detailed results were removed from context but preserved verbatim — recover any with retrieve_offloaded_content:\n${offloadIndex}`
      : summaryText;

    // Insert the summary as a user message with a marker. It names the last
    // message it covers — the boundary the next turn loads through.
    const throughMessageId = resolveBoundaryAnchorId(droppedSpan);
    // Memory provenance: a summary of untrusted input is untrusted input.
    const taint = untrustedInputProvenance(
      droppedSpan as unknown as ProvenanceMessage[],
    );
    const inputProvenance = taint
      ? { source: taint.source, trust: taint.trust }
      : null;
    compactedMessages.push(
      buildCompactionSummaryMessage(
        summaryWithRecovery,
        throughMessageId,
        inputProvenance,
      ),
    );

    // Carry active deviation-rule reminders from the dropped span across
    // the boundary — losing one re-opens the loop it was injected to break.
    compactedMessages.push(
      ...collectDroppedDeviationReminders(messages, recentTail),
    );

    // Append recent tail (last few turns the model is actively reasoning about).
    // Its Anthropic thinking blocks stay behind: each one's signature binds
    // it to the full history it was produced under, which the summary just
    // replaced — replayed after the swap, the API drops it (or 400s when
    // binding mismatches are errors). Text and tool calls stay verbatim.
    compactedMessages.push(...recentTail.map(withoutBoundThinking));

    const postCompactTokenCount = estimateTotalTokens(compactedMessages);

    // ── Shrink guard ───────────────────────────────────────────
    // If the "compacted" conversation is not actually smaller (a tail-heavy
    // history can produce summary-of-summary growth), keep the original
    // messages. Not a breaker failure — the model worked; instead the
    // conversation cools down until its history has grown (see above).
    if (postCompactTokenCount >= preCompactTokenCount) {
      const entry = this.touchBreaker(breakerKey);
      entry.noShrinkAtTokens = preCompactTokenCount;
      logger.warn(
        `[CompactionService] Compaction did not shrink ${breakerKey} ` +
          `(${preCompactTokenCount} → ${postCompactTokenCount} tokens). Discarding result; ` +
          `shrink-guard bail-out (not a breaker failure) — next attempt once the history grows ` +
          `${Math.round(COMPACTION.NO_SHRINK_RETRY_GROWTH_FRACTION * 100)}%.`,
      );
      options.emit?.({
        type: SERVER_SENT_EVENT_TYPES.STATUS,
        message: STATUS_MESSAGES.COMPACTION_FAILED,
      });
      return skip("did_not_shrink");
    }

    // ── Reset circuit breaker on success ──────────────────────
    this.breakers.delete(breakerKey);

    const boundary: CompactionBoundary | null = throughMessageId
      ? {
          summary: summaryWithRecovery,
          throughMessageId,
          createdAt: new Date().toISOString(),
          provider: compactionProvider,
          model: compactionModel,
          tokensBefore: preCompactTokenCount,
          tokensAfter: postCompactTokenCount,
          ...(inputProvenance && { inputProvenance }),
        }
      : null;
    if (!boundary) {
      logger.info(
        `[CompactionService] The summarized span of ${breakerKey} ends in a message persisted before ` +
          `message ids — the boundary is not persisted; the next turn re-summarizes.`,
      );
    }

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
      // The boundary the turn persists — the client's compaction marker
      // (null when the covered span cannot be addressed yet).
      boundary,
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
      result: {
        compactedMessages,
        summaryText,
        preCompactTokenCount,
        postCompactTokenCount,
        compactionUsage: result!.usage || { inputTokens: 0, outputTokens: 0 },
        boundary,
      },
      skipReason: null,
    };
  }

  /** Reset one conversation's breaker, or every breaker (tests, session boundaries). */
  static resetCircuitBreaker(conversationId?: string | null): void {
    if (conversationId === undefined) {
      this.breakers.clear();
    } else {
      this.breakers.delete(this.breakerKey(conversationId));
    }
  }
}

// ── Helper: Extract recent conversation tail ──────────────────

/**
 * Extract the recency-protected window (RecencyProtection.ts): the last
 * few model calls and everything after the first of them. Appended after
 * the summary so the model has immediate context to continue from — and
 * everything older, including earlier iterations of the CURRENT run, is
 * what the summary replaces.
 *
 * Claude Code equivalent: the "messagesToKeep" logic in compact.ts.
 */
function extractRecentTail(messages: AdminChatMessage[]): AdminChatMessage[] {
  const tailStartIndex = findRecencyBoundary(messages);

  // Extract the tail, skipping system messages (already in
  // compactedMessages) — EXCEPT deviation-rule reminders, which must
  // survive compaction to keep suppressing the loop they broke.
  return messages
    .slice(tailStartIndex)
    .filter(
      (message) =>
        message.role !== "system" || isDeviationReminderMessage(message),
    );
}

/**
 * Deviation-rule reminders from the span the summary replaces, de-duplicated
 * by content and excluding any reminder the tail already carries. Appended
 * right after the summary message so active behavioral guards persist
 * through compaction.
 */
function collectDroppedDeviationReminders(
  messages: AdminChatMessage[],
  recentTail: AdminChatMessage[],
): AdminChatMessage[] {
  const tailSet = new Set<AdminChatMessage>(recentTail);
  const tailContents = new Set(
    recentTail
      .filter((message) => isDeviationReminderMessage(message))
      .map((message) => message.content as string),
  );
  const carried: AdminChatMessage[] = [];
  const seenContents = new Set<string>();
  for (const message of messages) {
    if (tailSet.has(message)) continue;
    if (!isDeviationReminderMessage(message)) continue;
    const content = message.content as string;
    if (tailContents.has(content) || seenContents.has(content)) continue;
    seenContents.add(content);
    carried.push(message);
  }
  return carried;
}

// ─── Lossless dropped-span offload ──────────────────────────
/**
 * Offload the large tool results in the span the summary is about to
 * replace (everything before the recent tail), so LLM compaction becomes
 * lossless the same way micro-compaction is: the verbatim payloads survive
 * in the offload store and the model can recover any of them via
 * retrieve_offloaded_content. Returns a compact markdown index of the
 * offloaded results (or empty string when there is nothing worth
 * offloading). Best-effort — a store failure never blocks compaction.
 */
function offloadDroppedSpanResults(
  messages: AdminChatMessage[],
  recentTail: AdminChatMessage[],
  systemMessage: AdminChatMessage | undefined,
  metadata: OffloadMetadata,
): string {
  const preserved = new Set<AdminChatMessage>(recentTail);
  if (systemMessage) preserved.add(systemMessage);

  const indexLines: string[] = [];
  for (const message of messages) {
    if (preserved.has(message)) continue;
    if (message.role !== "assistant" || !message.toolCalls?.length) continue;
    for (const toolCall of message.toolCalls) {
      if (toolCall.result == null) continue;
      const resultText =
        typeof toolCall.result === "string"
          ? toolCall.result
          : JSON.stringify(toolCall.result);
      // Skip small results and already-offloaded stubs
      if (resultText.startsWith(OFFLOAD_STUB_HEADER)) continue;
      if (estimateTokens(resultText) < COMPACTION.MINIMUM_RESULT_TOKEN_THRESHOLD)
        continue;
      try {
        const stub = ToolResultOffloadService.offloadToolResult(
          toolCall,
          metadata,
        );
        const idMatch = stub.match(/offload_id:\s*(\S+)/);
        if (idMatch) {
          indexLines.push(`- ${toolCall.name} → offload_id: ${idMatch[1]}`);
        }
      } catch (error: unknown) {
        logger.warn(
          `[CompactionService] Dropped-span offload failed for ${toolCall.name}: ${errorMessage(error)}`,
        );
      }
    }
  }
  return indexLines.join("\n");
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

/**
 * A retained message without the thinking that binds to the pre-compaction
 * history: `thinkingBlocks` and the legacy signature go (the Anthropic
 * adapter only replays a thinking block that has one); the thinking text
 * stays for display. Persistence still writes the original (MessageLineage).
 */
function withoutBoundThinking(message: AdminChatMessage): AdminChatMessage {
  if (!message.thinkingBlocks?.length && !message.thinkingSignature) return message;
  const { thinkingBlocks: _thinkingBlocks, thinkingSignature: _thinkingSignature, ...rest } =
    message;
  return markDerivedMessage(rest as AdminChatMessage, message);
}
