import { AGENT_IDS } from "@rodrigo-barraza/utilities-library/taxonomy";
import crypto from "crypto";
import { getProvider } from "../providers/index.ts";
import MemoryService, { CODING_MEMORY_TYPES } from "./MemoryService.ts";
import MemoryConsolidationService from "./MemoryConsolidationService.ts";
import RequestLogger from "./RequestLogger.ts";
import SettingsService from "./SettingsService.ts";
import logger from "../utils/logger.ts";
import { parseJsonFromLlmResponse } from "@rodrigo-barraza/utilities-library";
import { TOOL_NAMES, SSE_EVENT_TYPES, STATUS_MESSAGES } from "@rodrigo-barraza/utilities-library/taxonomy";
import {
  estimateTokens,
  calculateTextCost,
  getTotalInputTokens,
} from "../utils/CostCalculator.ts";
import { TYPES, getPricing } from "../config.ts";
import { errorMessage } from "@rodrigo-barraza/utilities-library";
import type { ConversationMessage, ToolCall, EmitFunction, AgenticContext } from "./harnesses/types.ts";
import type { GenerateTextResult } from "../types/provider.ts";
import type { MessagePayload } from "./RequestLogger.ts";

// ─── Constants ────────────────────────────────────────────────────────────────

const MIN_MESSAGES_FOR_EXTRACTION = 4;

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
const EXTRACTION_PROMPT = `You are a memory extraction agent. Analyze this coding session and extract durable memories that will be useful in future sessions.

## Memory Types

### user
The user's role, goals, expertise, communication preferences, and working style.
When to save: the user reveals something about themselves that isn't obvious from the code.
Examples:
- "User is a senior data scientist focused on observability infrastructure"
- "User prefers GPU-accelerated CSS animations using transform/opacity only"
- "User went to art university, has high CSS design standards"

### feedback
Corrections, confirmations, and learned lessons from this session.
When to save: the user corrects an approach, confirms a good pattern, or a non-obvious debugging lesson emerges.
Examples:
- "Don't mock databases in tests — mock/prod divergence masked a broken migration"
- "Bundled PR approach was confirmed as the right strategy for this repo"
- "When debugging WebSocket drops, always check AbortController signal chain first"

### project
Non-derivable project context — things you can't figure out by reading the code.
When to save: deadlines, incidents, architectural decisions, team agreements, deployment constraints.
Examples:
- "Merge freeze begins 2026-03-05 for mobile release"
- "The staging cluster uses a different Redis config than prod — don't assume parity"
- "Team decided to keep MemoryService as the single source of truth for all agent memories"

### reference
Pointers to external systems, dashboards, APIs, or documentation.
When to save: the user mentions a specific external resource that would be useful to recall later.
Examples:
- "Project Linear board: https://linear.app/team/project-xyz"
- "Grafana dashboard for API latency: https://grafana.internal/d/abc123"
- "The lights API runs on port 5558 at /api/lights"

## What NOT to Save
Do NOT save any of the following, even if the user explicitly asks:
- Code patterns, architecture, or file structure (derivable by reading the code)
- Git history or file changes (use git log / git blame)
- Debugging solutions (the fix is in the code itself)
- Anything already in project configuration files (package.json, .env, etc.)
- Ephemeral task details ("fix this bug", "add this feature")
- Current conversation context that won't matter in future sessions

If the user asks you to "remember" something that falls into the above categories, save what was SURPRISING or NON-OBVIOUS about the experience instead.

## Output Format
Respond ONLY with a JSON array of memory objects. Each object must have:
- "type": one of "user", "feedback", "project", "reference"
- "title": short descriptive name (used for relevance scanning)
- "content": the full memory text — write it as if explaining to a future agent who has no context

Example:
\`\`\`json
[
  { "type": "feedback", "title": "No database mocks in tests", "content": "Don't mock the database in integration tests. Mock/prod divergence masked a broken migration in the auth service. All tests in /tests/integration/ must use a real DB connection." },
  { "type": "user", "title": "CSS animation standards", "content": "User requires GPU-accelerated CSS animations. Only use transform and opacity for animations — no layout-triggering properties like width, height, top, left." }
]
\`\`\`

If nothing worth remembering happened, return an empty array: []`;

interface ExtractedMemory {
  type: string;
  title: string;
  content: string;
}

interface StoredMemory {
  type: string;
  id: string;
  title: string;
}

interface MemoryExtractionContext {
  project: string;
  username: string;
  messages: ConversationMessage[];
  traceId?: string | null;
  agentSessionId?: string | null;
  conversationId?: string | null;
  endpoint?: string | null;
  agent?: string | null;
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
 * - Configurable extraction model via Settings → Memory Models
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
    agentSessionId,
    conversationId,
    endpoint,
    agent,
    toolCalls,
    emit,
  }: MemoryExtractionContext): Promise<StoredMemory[]> {
    if (!messages || messages.length < MIN_MESSAGES_FOR_EXTRACTION) {
      logger.info(
        `[MemoryExtractor] Skipping — only ${messages?.length || 0} messages (min: ${MIN_MESSAGES_FOR_EXTRACTION})`,
      );
      return [];
    }

    // ── Mutual Exclusion ──────────────────────────────────────────
    // If the main agent already wrote memories this turn via save_memory,
    // skip extraction — the agent's explicit memory writes take precedence.
    // This prevents duplicate or conflicting memories from the extraction
    // pipeline when the agent has already decided what to remember.
    if (toolCalls?.some((toolCall) => toolCall.name === TOOL_NAMES.SAVE_MEMORY)) {
      logger.info(
        `[MemoryExtractor] Skipping — main agent used save_memory this turn (mutual exclusion)`,
      );
      return [];
    }

    try {
      // ── Resolve extraction model from settings ────────────────
      let extractionProvider: string | undefined;
      let extractionModel: string | undefined;
      try {
        const memorySettings = await SettingsService.getSection("memory") as MemorySettingsSection;
        extractionProvider = memorySettings.extractionProvider;
        extractionModel = memorySettings.extractionModel;
      } catch {
        // Settings not configured — skip extraction silently
        logger.info(
          "[MemoryExtractor] Extraction model not configured in Settings → Memory Models. Skipping.",
        );
        return [];
      }

      if (!extractionProvider || !extractionModel) {
        logger.info(
          "[MemoryExtractor] Extraction provider/model not set. Skipping.",
        );
        return [];
      }

      const provider = getProvider(extractionProvider);

      // Build conversation text (compact format to save tokens)
      const conversationText = messages
        .filter((message) => message.role === "user" || message.role === "assistant")
        .map((message) => {
          const content = message.content || "";
          // Truncate very long messages to save tokens
          const truncated =
            content.length > 500 ? content.slice(0, 500) + "..." : content;
          return `${message.role}: ${truncated}`;
        })
        .join("\n");

      const aiMessages: MessagePayload[] = [
        { role: "system", content: EXTRACTION_PROMPT },
        {
          role: "user",
          content: `Extract memories from this coding session:\n\n${conversationText}`,
        },
      ];

      const requestId = crypto.randomUUID();
      const requestStart = performance.now();
      let result: GenerateTextResult | undefined;
      let success = true;
      let extractionError: string | null = null;

      try {
        result = await provider.generateText(aiMessages, extractionModel, {
          maxTokens: 1000,
          temperature: 0.1,
        });
      } catch (error: unknown) {
        success = false;
        extractionError = errorMessage(error);
        throw error;
      } finally {
        // Use real API-reported usage when available; fall back to heuristic
        const realUsage = result?.usage || null;
        const inputText = aiMessages.map((message) => typeof message.content === "string" ? message.content : "").join("\n");
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
          agentSessionId: agentSessionId || null,
          aiMessages,
          resultText: result?.text || "",
          usage: realUsage,
          success,
          errorMessage: extractionError,
          requestStartMs: requestStart,
          extraRequestPayload: {
            messageCount: messages.length,
            conversationId: conversationId || null,
          },
        });

        // Emit incremental usage so the UI token badge updates in real-time
        // instead of jumping when fetchSessionStats runs 2-8s later.
        // Include estimatedCost so the session cost badge is accurate
        // before the backend aggregation (fetchSessionStats) completes.
        if (emit && success) {
          try {
            const extractPricing = getPricing(TYPES.TEXT, TYPES.TEXT)[
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
              type: SSE_EVENT_TYPES.USAGE_UPDATE,
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

      let memories: unknown = parseJsonFromLlmResponse(result!.text);
      if (memories && typeof memories === "object" && !Array.isArray(memories)) {
        const memoriesRecord = memories as Record<string, unknown>;
        if (Array.isArray(memoriesRecord.memories)) {
          memories = memoriesRecord.memories;
        } else if (Array.isArray(memoriesRecord.extractedMemories)) {
          memories = memoriesRecord.extractedMemories;
        } else if (memoriesRecord.type && memoriesRecord.title && memoriesRecord.content) {
          memories = [memoriesRecord];
        } else {
          const arrayKey = Object.keys(memoriesRecord).find((key) => Array.isArray(memoriesRecord[key]));
          if (arrayKey) {
            memories = memoriesRecord[arrayKey];
          }
        }
      }

      if (!Array.isArray(memories)) {
        logger.warn(
          `[MemoryExtractor] Response was not an array or a recognized memory structure. Text: ${result!.text ? result!.text.substring(0, 200) : "empty"}`
        );
        return [];
      }

      const extractedMemories = memories as ExtractedMemory[];

      // ── Store each memory via MemoryService ─────────────────────
      const agentId = agent || AGENT_IDS.CODING;
      const stored: StoredMemory[] = [];

      for (const memoryObject of extractedMemories) {
        if (!memoryObject.content || !memoryObject.title) continue;

        // Validate type — default to "project" if unknown
        const type = CODING_MEMORY_TYPES.includes(memoryObject.type)
          ? memoryObject.type
          : "project";

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
            agentSessionId: agentSessionId || undefined,
            endpoint: endpoint || "/agent",
          });

          if (storeResult) {
            stored.push({ type, id: storeResult.id, title: memoryObject.title });
            logger.info(
              `[MemoryExtractor] Stored [${type}] "${memoryObject.title.substring(0, 60)}"`,
            );
          } else {
            logger.info(
              `[MemoryExtractor] Skipped duplicate [${type}] "${memoryObject.title.substring(0, 60)}"`,
            );
          }
        } catch (error: unknown) {
          logger.error(`[MemoryExtractor] Storage failed: ${errorMessage(error)}`);
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
          const embedPricing = getPricing(TYPES.TEXT, TYPES.EMBEDDING);
          const embedModel = (await SettingsService.getSection("memory") as MemorySettingsSection)
            ?.embeddingModel;
          const embedModelPricing = embedModel
            ? embedPricing[embedModel]
            : null;
          const embedCost = embedModelPricing?.inputPerMillion
            ? (embedTokens / 1_000_000) * embedModelPricing.inputPerMillion
            : null;
          emit({
            type: "usage_update",
            operation: "embed:memory",
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
    return async (context: AgenticContext, { _text, messages, toolCalls }: AfterResponseOutput) => {
      // Fire-and-forget — don't block the response
      MemoryExtractor.extractAndStore({
        project: context.project,
        username: context.username,
        messages: messages || context.messages,
        traceId: context.traceId,
        agentSessionId: context.agentSessionId,
        conversationId: context.conversationId as string | null,
        endpoint: (context as Record<string, unknown>).endpoint as string | null || "/agent",
        agent: context.agent || null,
        toolCalls: toolCalls || [],
        emit: context.emit || null,
      })
        .then((stored) => {
          if (stored?.length > 0 && context.emit) {
            context.emit({
              type: SSE_EVENT_TYPES.STATUS,
              message: STATUS_MESSAGES.MEMORIES_UPDATED,
              count: stored.length,
            });
          }

          // Build a broadcast callback from ctx.emit for consolidation notifications
          const broadcast = context.emit
            ? (payload: Record<string, unknown>) => context.emit(payload as { type: string; [key: string]: unknown })
            : undefined;

          // Check if consolidation should run (tracks session count)
          MemoryConsolidationService.checkAndRun({
            project: context.project,
            username: context.username,
            broadcast,
            endpoint: (context as Record<string, unknown>).endpoint as string | null || "/agent",
            agent: context.agent || null,
            traceId: context.traceId || null,
            agentSessionId: context.agentSessionId || null,
          });
        })
        .catch((error: unknown) =>
          logger.error(
            `[MemoryExtractor] Background extraction failed: ${errorMessage(error)}`,
          ),
        );
    };
  }
}
