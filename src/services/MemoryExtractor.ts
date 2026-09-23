import { AGENT_IDS } from "@rodrigo-barraza/utilities-library/taxonomy";
import crypto from "crypto";
import { isMemoryExtractionChannelWatermarkEnabled } from "#config";
import { getProvider } from "#src/providers/index";
import ModelRoleRouter, { MODEL_ROLES } from "./ModelRoleRouter.ts";
import MemoryService, { CODING_MEMORY_TYPES } from "./MemoryService.ts";
import MemoryConsolidationService from "./MemoryConsolidationService.ts";
import PromptLocaleService from "./PromptLocaleService.ts";
import RequestLogger from "./RequestLogger.ts";
import SettingsService from "./SettingsService.ts";
import {
  ExtractionWatermarkStore,
  buildExtractionTranscript,
  resolveWatermarkScope,
  selectExtractionSpan,
  spanAuthoredCharacters,
  watermarkThroughEnd,
  type ExtractionSpan,
  type TranscriptEntry,
} from "./memory/ExtractionWatermark.ts";
import {
  combineProvenance,
  quotesUncitedText,
  untrustedInputProvenance,
  type MemoryProvenance,
} from "./memory/MemoryProvenance.ts";
import { DEFAULT_PROFILE_ID } from "#src/utils/ProfileScope";
import { getRequestContext } from "#src/utils/RequestContext";
import logger from "#src/utils/logger";
import { parseJsonFromLargeLanguageModelResponse } from "@rodrigo-barraza/utilities-library";
import {
  TOOL_NAMES,
  SERVER_SENT_EVENT_TYPES,
  STATUS_MESSAGES,
} from "@rodrigo-barraza/utilities-library/taxonomy";
import {
  estimateTokens,
  calculateTextCost,
  getTotalInputTokens,
} from "#src/utils/CostCalculator";
import { MODALITY_TYPES, getPricing } from "#src/config";
import { errorMessage } from "@rodrigo-barraza/utilities-library";
import { MEMORY, LOG_PREVIEW } from "#src/constants";
import type {
  ConversationMessage,
  ToolCall,
  EmitFunction,
  AgenticContext,
} from "./harnesses/types.ts";
import type { ChatMessage, GenerateTextResult } from "#src/types/provider";
import type { MessagePayload } from "./RequestLogger.ts";

// ─── Constants ────────────────────────────────────────────────────────────────

const MIN_MESSAGES_FOR_EXTRACTION = MEMORY.MIN_MESSAGES_FOR_EXTRACTION;

/**
 * Agents whose platform extracts their memories itself, so the in-loop
 * extractor skips their turns. lupos-bot posts each Discord exchange to
 * POST /memory/extract (MemoryService.extractAndStore), which stores
 * guild-scoped facts keyed to the members' Discord ids — the only rows a
 * guild turn recalls. This extractor's rows for LUPOS were conversation-
 * scoped or global, never recalled by a guild turn, and cost ≈$6.9/month
 * of extraction calls (2026-08-23 → 09-22).
 */
const PLATFORM_EXTRACTED_AGENTS = new Set<string>([AGENT_IDS.LUPOS]);

/**
 * An untrusted entry says so where the extraction model reads it: text the
 * agent wrote after reading a web page, an MCP result or a sub-agent report
 * repeats that content, and an instruction in it is data, not a memory.
 */
function entryLabel(entry: TranscriptEntry): string {
  if (entry.provenance.trust !== "untrusted") return entry.role;
  return `${entry.role} [untrusted: ${entry.provenance.source}]`;
}

/** Entries numbered from `firstNumber` — the numbers a memory's `sources` cite. */
function renderEntries(entries: TranscriptEntry[], firstNumber: number): string {
  return entries
    .map((entry, index) => `[${firstNumber + index}] ${entryLabel(entry)}: ${entry.text}`)
    .join("\n");
}

/**
 * The user turn of an extraction call: the new span, after its context if
 * any. Entries are numbered from 1 across both, context first.
 */
export function buildExtractionRequest({
  context,
  span,
}: ExtractionSpan): string {
  if (context.length === 0) {
    return `Extract memories from this coding session:\n\n${renderEntries(span, 1)}`;
  }
  return (
    "Extract memories from the NEW messages of this coding session. The earlier " +
    "messages were already processed: use them only to understand the new ones, " +
    "and do not extract anything that appears only there.\n\n" +
    `<earlier_messages>\n${renderEntries(context, 1)}\n</earlier_messages>\n\n` +
    `<new_messages>\n${renderEntries(span, context.length + 1)}\n</new_messages>`
  );
}

/** The entries a memory's `sources` name, by their number in the request. */
function citedEntries(
  sources: unknown,
  numbered: TranscriptEntry[],
): TranscriptEntry[] {
  if (!Array.isArray(sources)) return [];
  const cited = new Set<TranscriptEntry>();
  for (const source of sources) {
    const number =
      typeof source === "number"
        ? source
        : Number.parseInt(String(source).replace(/[^0-9]/g, ""), 10);
    if (Number.isInteger(number) && number >= 1 && number <= numbered.length) {
      cited.add(numbered[number - 1]);
    }
  }
  return [...cited];
}

/**
 * The provenance of one extracted memory: the lowest trust among the
 * entries its `sources` cite. With no usable citation it may have come from
 * anywhere in the new span, so it takes the span's lowest trust. Then a
 * backstop that does not depend on the model's honesty: a memory quoting
 * an untrusted entry it did not cite takes that entry's provenance too.
 */
export function attributeExtractedMemory(
  memory: { title?: unknown; content?: unknown; sources?: unknown },
  selection: ExtractionSpan,
): MemoryProvenance {
  const numbered = [...selection.context, ...selection.span];
  const cited = citedEntries(memory.sources, numbered);
  const drawnOn = cited.length > 0 ? cited : selection.span;
  const parts = drawnOn.map((entry) => entry.provenance);
  const memoryText = `${String(memory.title ?? "")}\n${String(memory.content ?? "")}`;
  const citedTexts = drawnOn.map((entry) => entry.text);
  for (const entry of numbered) {
    if (entry.provenance.trust !== "untrusted" || drawnOn.includes(entry)) continue;
    if (quotesUncitedText(memoryText, entry.text, citedTexts)) {
      parts.push(entry.provenance);
    }
  }
  return combineProvenance(parts);
}

/**
 * Extraction prompt — CC-style 4-type taxonomy with explicit negative constraints.
 *
 * Types:
 *   user      — user's role, goals, expertise, preferences
 *   feedback  — corrections + confirmations ("don't mock DB", "yes, bundled PR was right")
 *   project   — non-derivable project context (deadlines, incidents, decisions)
 *   reference — pointers to external systems (Linear projects, Grafana boards, API endpoints)
 *
 * Negative constraints prevent saving information that is derivable from the
 * codebase itself (via grep, git, file reads). This is Claude Code's most
 * impactful memory quality insight — eval-validated.
 */
const EXTRACTION_PROMPT = PromptLocaleService.get(
  "en",
  "memory.extractionPrompt",
);

interface ExtractedMemory {
  type: string;
  title: string;
  content: string;
  /** Numbers of the transcript entries it draws on (buildExtractionRequest). */
  sources?: unknown;
}

interface StoredMemory {
  type: string;
  id: string;
  title: string;
  /** Held for review — never injected until accepted or corroborated. */
  quarantined?: boolean;
  /** An earlier quarantined memory this user-sourced one confirmed. */
  corroborated?: boolean;
}

interface MemoryExtractionContext {
  project: string;
  username: string;
  messages: ConversationMessage[];
  traceId?: string | null;
  agentConversationId?: string | null;
  conversationId?: string | null;
  endpoint?: string | null;
  agent?: string | null;
  profileId?: string | null;
  /** Platform runtime context (Discord guild/channel) — scopes the watermark. */
  agentContext?: unknown;
  toolCalls?: ToolCall[];
  emit?: EmitFunction | null;
}

interface MemorySettingsSection {
  extractionProvider?: string;
  extractionModel?: string;
  embeddingModel?: string;
}

interface AfterResponseOutput {
  _text?: string;
  messages?: ConversationMessage[];
  toolCalls?: ToolCall[];
}

// ─── MemoryExtractor ─────────────────────────────────────────────────────────

/**
 * MemoryExtractor — extracts and stores memories from agentic conversations.
 *
 * Architecture: Single-store, CC-style.
 * - 4-type taxonomy: user, feedback, project, reference
 * - All memories stored in the unified `memories` collection via MemoryService
 * - Mutual exclusion: skips extraction when the main agent used save_memory
 *   (unless the loop read untrusted input — that save is quarantined, and a
 *   fact the user stated can only corroborate it if extraction runs)
 * - Provenance: each memory takes the lowest trust of the messages it drew
 *   on; untrusted ones are quarantined (memory/MemoryProvenance)
 * - Reads only what the last extraction did not (memory/ExtractionWatermark)
 * - Configurable extraction model: the `memory` role (MODEL_ROLE_MEMORY, then
 *   Settings → Memory Models, then the utility chain)
 *
 * Registered as an `afterResponse` hook in AgentHooks.
 * Runs in the background (fire-and-forget) after the final response.
 */
export default class MemoryExtractor {
  static async extractAndStore({
    project,
    username,
    messages,
    traceId,
    agentConversationId,
    conversationId,
    endpoint,
    agent,
    profileId,
    agentContext,
    toolCalls,
    emit,
  }: MemoryExtractionContext): Promise<StoredMemory[]> {
    if (!messages || messages.length < MIN_MESSAGES_FOR_EXTRACTION) {
      logger.info(
        `[MemoryExtractor] Skipping — only ${messages?.length || 0} messages (min: ${MIN_MESSAGES_FOR_EXTRACTION})`,
      );
      return [];
    }

    const agentId = agent || AGENT_IDS.CODING;
    const watermarkScope = resolveWatermarkScope({
      project,
      agent: agentId,
      profileId:
        profileId || getRequestContext().profileId || DEFAULT_PROFILE_ID,
      conversationId,
      agentContext,
      channelScope: isMemoryExtractionChannelWatermarkEnabled(),
    });
    const watermark = watermarkScope
      ? await ExtractionWatermarkStore.read(watermarkScope)
      : null;
    // Built after an await on purpose: finalize() pushes the turn's final
    // assistant reply into this same array right after firing afterResponse,
    // and an extraction must see it — as the pre-diet code did.
    const transcript = buildExtractionTranscript(messages, {
      conversationId: conversationId || null,
    });
    const advanceWatermark = async () => {
      const next = watermarkThroughEnd(transcript);
      if (watermarkScope && next) {
        await ExtractionWatermarkStore.write(watermarkScope, next);
      }
    };

    // ── Mutual Exclusion ──────────────────────────────────────────
    // If the main agent already wrote memories this turn via save_memory,
    // skip extraction — the agent's explicit memory writes take precedence.
    // This prevents duplicate or conflicting memories from the extraction
    // pipeline when the agent has already decided what to remember. The
    // watermark moves past the span: the agent has already decided about it.
    //
    // Not when the loop read untrusted input: that save_memory was stored
    // quarantined (AgentMemoriesRoutes), and the one way a quarantined
    // memory goes live without a click is a user-sourced extraction of the
    // same fact (MemoryService.store corroboration).
    if (
      toolCalls?.some((toolCall) => toolCall.name === TOOL_NAMES.SAVE_MEMORY)
    ) {
      const taint = untrustedInputProvenance(messages, {
        conversationId: conversationId || null,
      });
      if (!taint) {
        logger.info(
          `[MemoryExtractor] Skipping — main agent used save_memory this turn (mutual exclusion)`,
        );
        await advanceWatermark();
        return [];
      }
      logger.info(
        `[MemoryExtractor] save_memory ran after untrusted input (${taint.source}) — extracting anyway so the user's own words can corroborate it`,
      );
    }

    // ── The span: only what no extraction has read yet ────────────
    const selection = selectExtractionSpan(transcript, watermark);
    const authoredCharacters = spanAuthoredCharacters(selection.span);
    const spanLabel =
      `${selection.span.length}/${transcript.entries.length} messages ` +
      `(${selection.reason}, ${authoredCharacters} user-written chars) ` +
      `in ${watermarkScope?.scope || "unscoped"}`;
    if (selection.reason === "watermark-lost") {
      logger.warn(
        `[MemoryExtractor] Watermark not found in the transcript — re-reading all ${spanLabel}`,
      );
    }
    // Trivial span: no call, and the watermark stays where it is so these
    // messages ride along with the next span instead of being dropped.
    if (authoredCharacters < MEMORY.EXTRACTION_MIN_AUTHORED_CHARACTERS) {
      logger.info(`[MemoryExtractor] Skipping trivial span — ${spanLabel}`);
      return [];
    }

    try {
      // ── Resolve the extraction model through the memory role ──
      // Never silently disabled: MODEL_ROLE_MEMORY → Settings → Memory
      // Models → the utility chain (local-instance or cheap-cloud defaults).
      const roleChain = await ModelRoleRouter.resolveChain(MODEL_ROLES.MEMORY);
      if (roleChain.length === 0) {
        logger.error(
          "[MemoryExtractor] Memory role resolved to an empty model chain — cannot extract memories.",
        );
        return [];
      }
      let extractionProvider = roleChain[0].provider;
      let extractionModel = roleChain[0].model;

      logger.info(`[MemoryExtractor] Extracting ${spanLabel}`);
      const aiMessages: ChatMessage[] = [
        { role: "system", content: EXTRACTION_PROMPT },
        { role: "user", content: buildExtractionRequest(selection) },
      ];

      const requestId = crypto.randomUUID();
      const requestStart = performance.now();
      let result: GenerateTextResult | undefined;
      let success = true;
      let extractionError: string | null = null;

      try {
        ({ value: result } = await ModelRoleRouter.runWithChain(
          roleChain,
          async (entry) => {
            extractionProvider = entry.provider;
            extractionModel = entry.model;
            return getProvider(entry.provider).generateText(
              aiMessages,
              entry.model,
              {
                maxTokens: 1000,
                temperature: 0.1,
                // Utility call — never burn extended thinking on memory extraction.
                thinkingEnabled: false,
                reasoningEffort: "none",
              },
            );
          },
          { role: MODEL_ROLES.MEMORY, operation: "memory:extract" },
        ));
      } catch (error: unknown) {
        success = false;
        extractionError = errorMessage(error);
        throw error;
      } finally {
        // Use real API-reported usage when available; fall back to heuristic
        const realUsage = result?.usage || null;
        const inputText = aiMessages
          .map((message) =>
            typeof message.content === "string" ? message.content : "",
          )
          .join("\n");
        const approxInputTokens = realUsage
          ? getTotalInputTokens(realUsage)
          : estimateTokens(inputText);
        const approxOutputTokens = realUsage
          ? realUsage.outputTokens || 0
          : result?.text
            ? estimateTokens(result.text)
            : 0;

        RequestLogger.logBackgroundLlmCall({
          requestId,
          endpoint: endpoint || "/agent",
          operation: "memory:extract",
          project,
          username: username || "system",
          agent: agent || null,
          provider: extractionProvider,
          model: extractionModel,
          traceId: traceId || null,
          conversationId: conversationId || null,
          agentConversationId: agentConversationId || null,
          aiMessages: aiMessages as MessagePayload[],
          resultText: result?.text || "",
          usage: realUsage,
          success,
          errorMessage: extractionError,
          requestStartMilliseconds: requestStart,
          extraRequestPayload: {
            messageCount: messages.length,
            spanMessageCount: selection.span.length,
            contextMessageCount: selection.context.length,
            watermark: selection.reason,
          },
        });

        // Emit incremental usage so the UI token badge updates in real-time
        // instead of jumping when fetchConversationStats runs 2-8s later.
        // Include estimatedCost so the conversation cost badge is accurate
        // before the backend aggregation (fetchConversationStats) completes.
        if (emit && success) {
          try {
            const extractPricing = getPricing(MODALITY_TYPES.TEXT, MODALITY_TYPES.TEXT)[
              extractionModel
            ];
            const extractCost = extractPricing
              ? calculateTextCost(
                  {
                    inputTokens: approxInputTokens,
                    outputTokens: approxOutputTokens,
                  },
                  extractPricing,
                )
              : null;
            emit({
              type: SERVER_SENT_EVENT_TYPES.USAGE_UPDATE,
              operation: "memory:extract",
              usage: {
                requests: 1,
                inputTokens: approxInputTokens,
                outputTokens: approxOutputTokens,
                estimatedCost: extractCost,
              },
            });
          } catch {
            /* SSE channel may be closed */
          }
        }
      }

      let memories: unknown = parseJsonFromLargeLanguageModelResponse(
        result!.text,
      );
      if (
        memories &&
        typeof memories === "object" &&
        !Array.isArray(memories)
      ) {
        const memoriesRecord = memories as Record<string, unknown>;
        if (Array.isArray(memoriesRecord.memories)) {
          memories = memoriesRecord.memories;
        } else if (Array.isArray(memoriesRecord.extractedMemories)) {
          memories = memoriesRecord.extractedMemories;
        } else if (
          memoriesRecord.type &&
          memoriesRecord.title &&
          memoriesRecord.content
        ) {
          memories = [memoriesRecord];
        } else {
          const arrayKey = Object.keys(memoriesRecord).find((key) =>
            Array.isArray(memoriesRecord[key]),
          );
          if (arrayKey) {
            memories = memoriesRecord[arrayKey];
          }
        }
      }

      if (!Array.isArray(memories)) {
        logger.warn(
          `[MemoryExtractor] Response was not an array or a recognized memory structure. Text: ${result!.text ? result!.text.substring(0, 200) : "empty"}`,
        );
        return [];
      }

      // The span has been read — the next extraction starts after it, even
      // when it held nothing worth keeping.
      await advanceWatermark();

      const extractedMemories = memories as ExtractedMemory[];

      // ── Store each memory via MemoryService ─────────────────────
      const stored: StoredMemory[] = [];

      for (const memoryObject of extractedMemories) {
        if (!memoryObject.content || !memoryObject.title) continue;

        // Validate type — default to "project" if unknown
        const type = CODING_MEMORY_TYPES.includes(memoryObject.type)
          ? memoryObject.type
          : "project";

        const provenance = attributeExtractedMemory(memoryObject, selection);
        try {
          const storeResult = await MemoryService.store({
            agent: agentId,
            project,
            username,
            type,
            title: memoryObject.title,
            content: memoryObject.content,
            conversationId: conversationId || undefined,
            traceId: traceId || undefined,
            agentConversationId: agentConversationId || undefined,
            endpoint: endpoint || "/agent",
            provenance,
          });

          if (storeResult) {
            stored.push({
              type,
              id: storeResult.id,
              title: memoryObject.title,
              quarantined: storeResult.quarantined === true,
              corroborated: storeResult.corroborated === true,
            });
            const outcome = storeResult.corroborated
              ? "Corroborated a quarantined memory with"
              : storeResult.quarantined
                ? "Quarantined"
                : "Stored";
            logger.info(
              `[MemoryExtractor] ${outcome} [${type}] "${memoryObject.title.substring(0, LOG_PREVIEW.SHORT)}" (source: ${provenance.source}, trust: ${provenance.trust})`,
            );
          } else {
            logger.info(
              `[MemoryExtractor] Skipped duplicate [${type}] "${memoryObject.title.substring(0, LOG_PREVIEW.SHORT)}"`,
            );
          }
        } catch (error: unknown) {
          logger.error(
            `[MemoryExtractor] Storage failed: ${errorMessage(error)}`,
          );
        }
      }

      logger.info(
        `[MemoryExtractor] Stored ${stored.length}/${extractedMemories.length} memories from conversation ${conversationId || "unknown"}`,
      );

      // Emit usage for the embedding calls that happened during storage.
      // Each MemoryService.store() generates one embedding — report the
      // aggregate so the UI request count grows incrementally.
      if (emit && stored.length > 0) {
        try {
          const embedTokens = stored.length * 50; // ~50 tokens per memory title+content
          // Embedding cost: input tokens only (no output tokens)
          const embedPricing = getPricing(MODALITY_TYPES.TEXT, MODALITY_TYPES.EMBEDDING);
          const embedModel = (
            (await SettingsService.getSection(
              "memory",
            )) as MemorySettingsSection
          )?.embeddingModel;
          const embedModelPricing = embedModel
            ? embedPricing[embedModel]
            : null;
          const embedCost = embedModelPricing?.inputPerMillion
            ? (embedTokens / 1_000_000) * embedModelPricing.inputPerMillion
            : null;
          emit({
            type: "usage_update",
            operation: "memory:embed",
            usage: {
              requests: stored.length,
              inputTokens: embedTokens,
              outputTokens: 0,
              estimatedCost: embedCost,
            },
          });
        } catch {
          /* SSE channel may be closed */
        }
      }

      return stored;
    } catch (error: unknown) {
      logger.error(`[MemoryExtractor] Failed: ${errorMessage(error)}`);
      return [];
    }
  }

  /**
   * Create an afterResponse hook handler for AgentHooks.
   * Runs as fire-and-forget (non-blocking).
   */
  static createHook() {
    return async (
      context: AgenticContext,
      { _text, messages, toolCalls }: AfterResponseOutput,
    ) => {
      if (context.agent && PLATFORM_EXTRACTED_AGENTS.has(context.agent)) return;
      // Fire-and-forget — don't block the response
      MemoryExtractor.extractAndStore({
        project: context.project,
        username: context.username,
        messages: messages || context.messages,
        traceId: context.traceId,
        agentConversationId: context.agentConversationId,
        conversationId: context.conversationId as string | null,
        endpoint:
          ((context as Record<string, unknown>).endpoint as string | null) ||
          "/agent",
        agent: context.agent || null,
        profileId: context.profileId || null,
        agentContext: context.options?.agentContext,
        toolCalls: toolCalls || [],
        emit: context.emit || null,
      })
        .then((stored) => {
          // Nothing stored, nothing new to consolidate — counting empty
          // extractions triggered a consolidation every 5 Discord replies.
          if (!stored?.length) return;

          if (context.emit) {
            context.emit({
              type: SERVER_SENT_EVENT_TYPES.STATUS,
              message: STATUS_MESSAGES.MEMORIES_UPDATED,
              count: stored.length,
            });
          }

          // Build a broadcast callback from ctx.emit for consolidation notifications
          const broadcast = context.emit
            ? (payload: Record<string, unknown>) =>
                context.emit(
                  payload as { type: string; [key: string]: unknown },
                )
            : undefined;

          // Check if consolidation should run (counts extractions that stored memories)
          MemoryConsolidationService.checkAndRun({
            project: context.project,
            username: context.username,
            broadcast,
            endpoint:
              ((context as Record<string, unknown>).endpoint as
                | string
                | null) || "/agent",
            agent: context.agent || null,
            traceId: context.traceId || null,
            agentConversationId: context.agentConversationId || null,
          });
        })
        .catch((error: Error) =>
          logger.error(
            `[MemoryExtractor] Background extraction failed: ${errorMessage(error)}`,
          ),
        );
    };
  }
}
