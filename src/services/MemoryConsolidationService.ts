import { AGENT_IDS } from "@rodrigo-barraza/utilities-library/taxonomy";
import { daysSinceIso } from "@rodrigo-barraza/utilities-library";
import { SERVER_SENT_EVENT_TYPES } from "@rodrigo-barraza/utilities-library/taxonomy";
import crypto from "crypto";
import { getProvider } from "#src/providers/index";
import type { ChatMessage } from "#src/types/provider";
import type { MessagePayload } from "./conversation/types.ts";
import MemoryService, { CURRENT_MEMORY_FILTER } from "./MemoryService.ts";
import RequestLogger from "./RequestLogger.ts";
import MongoWrapper from "#src/wrappers/MongoWrapper";
import { MONGO_DB_NAME } from "#config";
import logger from "#src/utils/logger";
import { parseJsonFromLargeLanguageModelResponse } from "@rodrigo-barraza/utilities-library";
import { COLLECTIONS, MEMORY, LOG_PREVIEW } from "#src/constants";
import AgentPersonaRegistry from "./AgentPersonaRegistry.ts";
import SettingsService from "./SettingsService.ts";
import {
  estimateTokens,
  calculateTextCost,
  getTotalInputTokens,
} from "#src/utils/CostCalculator";
import { MODALITY_TYPES, getPricing } from "#src/config";

// ── Extracted sub-modules ───────────────────────────────────
import {
  findClusters,
  CONVERSATIONAL_CLUSTER_THRESHOLD,
} from "./memory/ClusterDetection.ts";
import {
  CONSOLIDATION_PROMPT,
  CONVERSATIONAL_CONSOLIDATION_PROMPT,
  buildBatchInput,
  buildConversationalBatchInput,
} from "./memory/ConsolidationPrompts.ts";
import { buildBatches } from "./memory/BatchBuilder.ts";
import {
  SESSIONS_BETWEEN_RUNS,
  getRunCount,
  incrementRunCount,
  resetRunCount,
  recordHistory,
  canRunToday,
  getHistory,
  getHistoryRun,
  markRunRolledBack,
  acquireConsolidationLock,
  releaseConsolidationLock,
} from "./memory/ConsolidationTracker.ts";
import {
  partitionConversationalMemories,
  findStaleConversationalMemories,
} from "./memory/ConversationalMemoryPartitioner.ts";

import { getErrorMessage } from "@rodrigo-barraza/utilities-library";
import { DEFAULT_PROFILE_ID, profileFilter } from "#src/utils/ProfileScope";
import { getRequestContext } from "#src/utils/RequestContext";
import type {
  MemoryDoc,
  ConsolidationAction,
  ConsolidationBatch,
  PartitionMeta,
  ProcessBatchOptions,
  ApplyActionsOptions,
  ConsolidateOptions,
  CheckAndRunOptions,
} from "./memory/types.ts";

/**
 * Profile-aware widenings of the shared consolidation option shapes.
 * Consolidation must never merge memories across profiles, so every run is
 * pinned to exactly one profile. Background/daemon callers that pass no
 * profileId (and run outside a request's ALS) consolidate the DEFAULT
 * profile only.
 */
export type ProfiledConsolidateOptions = ConsolidateOptions & {
  profileId?: string;
};
export type ProfiledCheckAndRunOptions = CheckAndRunOptions & {
  profileId?: string;
};

/** Explicit param wins, then the request's ALS context, then the default. */
function resolveProfileId(profileId?: string | null): string {
  return profileId || getRequestContext().profileId || DEFAULT_PROFILE_ID;
}

// ─── Constants ────────────────────────────────────────────────────────────────
/** Resolve the current consolidation provider + model from settings. */
async function getConsolidationConfig() {
  return SettingsService.getMemoryModelConfig("consolidation");
}
/** Memories older than this (days) with ephemeral types get flagged for staleness review */
const STALENESS_DAYS = MEMORY.STALENESS_DAYS;
/** Output token limit per LLM call — 2000 was too low for complex merges */
const LLM_MAX_OUTPUT_TOKENS = MEMORY.LLM_MAX_OUTPUT_TOKENS;

function daysSince(isoDate: string) {
  return daysSinceIso(isoDate);
}

// ─── Action Execution ────────────────────────────────────────────────────────
/**
 * Apply consolidation actions. For conversational agent merges, memoryLookup
 * is used to preserve source attribution metadata on the merged document.
 *
 * NON-DESTRUCTIVE (Graphiti-style edge invalidation,
 * https://github.com/getzep/graphiti): merge and delete/
 * invalidate soft-close the affected memories (validTo + supersededBy +
 * closedReason) instead of hard-deleting, so a bad LLM decision is
 * recoverable via rollbackRun(). closedIds/createdIds are returned for the
 * history record that powers that rollback.
 */
async function applyActions(
  actions: ConsolidationAction[],
  agent: string,
  agentType: string,
  project: string | null,
  username: string,
  {
    traceId,
    endpoint,
    memoryLookup,
    profileId,
  }: ApplyActionsOptions & { profileId?: string } = {},
) {
  const results = {
    merged: 0,
    deleted: 0,
    errors: 0,
    closedIds: [] as string[],
    createdIds: [] as string[],
  };
  const isConversational = agentType === "conversational";

  for (const action of actions) {
    try {
      if (
        action.type === "merge" &&
        action.sourceIds?.length &&
        action.sourceIds.length >= 2 &&
        action.merged
      ) {
        // Collect conversational agent metadata from source memories before deletion
        let attributionMetadata: Record<string, unknown> = {};
        if (isConversational && memoryLookup) {
          const sources = action.sourceIds
            .map((id: string) => memoryLookup.get(id))
            .filter(Boolean) as MemoryDoc[];

          if (sources.length > 0) {
            // All memories in a merge share the same about/source (partitioned)
            const primary = sources[0];
            // Collect all unique sources for the mergedSources attribution chain
            const uniqueSources = new Map<
              string,
              { sourceUserId: string; sourceUsername: string }
            >();
            for (const source of sources) {
              if (
                source.sourceUserId &&
                !uniqueSources.has(source.sourceUserId)
              ) {
                uniqueSources.set(source.sourceUserId, {
                  sourceUserId: source.sourceUserId,
                  sourceUsername: source.sourceUsername || "",
                });
              }
            }
            attributionMetadata = {
              metadata: {
                aboutUserId: primary.aboutUserId,
                aboutUsername: primary.aboutUsername,
                sourceUserId: primary.sourceUserId,
                sourceUsername: primary.sourceUsername,
                guildId: primary.guildId,
                mergedSources: [...uniqueSources.values()],
              },
            };
          }
        }

        // Store the consolidated memory FIRST (dedupe off — it is
        // intentionally similar to its still-current sources), then
        // soft-close each source pointing at it.
        const merged = await MemoryService.store({
          agent,
          project,
          username: username || "system",
          profileId,
          type: action.merged.type || (isConversational ? "other" : "project"),
          title: action.merged.title || null,
          content: action.merged.content,
          conversationId: null,
          traceId: traceId || undefined,
          endpoint: endpoint || undefined,
          dedupe: false,
          ...attributionMetadata,
        });
        if (!merged) {
          throw new Error("merge target store returned null");
        }
        results.createdIds.push(merged.id as string);
        for (const id of action.sourceIds) {
          const closed = await MemoryService.invalidate(id, {
            supersededBy: merged.id as string,
            reason: action.reason || "merged",
          });
          if (closed) results.closedIds.push(id);
        }
        results.merged += action.sourceIds.length;
        logger.info(
          `[MemoryConsolidation] Merged ${action.sourceIds.length} → "${action.merged.title || action.merged.content?.substring(0, LOG_PREVIEW.SHORT)}" (${action.reason || ""})`,
        );
      } else if (
        (action.type === "delete" || action.type === "invalidate") &&
        action.id
      ) {
        const closed = await MemoryService.invalidate(action.id, {
          supersededBy: action.supersededById || null,
          reason: action.reason || "invalidated",
        });
        if (closed) results.closedIds.push(action.id);
        results.deleted++;
        logger.info(
          `[MemoryConsolidation] Invalidated "${action.id}" (${action.reason || ""})`,
        );
      }
    } catch (error: unknown) {
      results.errors++;
      logger.error(
        `[MemoryConsolidation] Failed to apply action: ${getErrorMessage(error)}`,
      );
    }
  }
  return results;
}

// ─── Single Batch LLM Call ───────────────────────────────────────────────────
/**
 * Run a single LLM consolidation call for one batch.
 * Returns parsed actions array, or empty array on failure.
 */
async function processBatch(
  batch: ConsolidationBatch,
  batchIndex: number,
  totalBatches: number,
  {
    provider,
    consolidationProvider,
    consolidationModel,
    agent,
    project,
    username,
    trigger,
    endpoint,
    traceId,
    agentConversationId,
    broadcast,
    systemPrompt = CONSOLIDATION_PROMPT,
    inputBuilder,
  }: ProcessBatchOptions,
): Promise<ConsolidationAction[]> {
  const input = inputBuilder
    ? inputBuilder(batch.clusters, batch.stale, batch.partitionMeta)
    : buildBatchInput(batch.clusters, batch.stale);
  if (!input) return [];

  const batchLabel = `[batch ${batchIndex + 1}/${totalBatches}]`;
  const clusterCount = batch.clusters.length;
  const staleCount = batch.stale.length;
  logger.info(
    `[MemoryConsolidation] ${batchLabel} Processing ${clusterCount} clusters, ${staleCount} stale memories`,
  );

  const aiMessages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: input },
  ];

  const inputText = aiMessages.map((message) => message.content).join("\n");
  const approxInputTokens = estimateTokens(inputText);
  logger.info(
    `[MemoryConsolidation] ${batchLabel} Input: ~${approxInputTokens} tokens`,
  );

  const llmRequestId = crypto.randomUUID();
  const llmStart = performance.now();
  let llmSuccess = true;
  let llmError: string | null = null;
  let result: { text?: string; usage?: Record<string, number> } | null = null;

  try {
    result = (await provider.generateText(aiMessages, consolidationModel, {
      maxTokens: LLM_MAX_OUTPUT_TOKENS,
      temperature: 0.1,
    })) as unknown as { text?: string; usage?: Record<string, number> };
  } catch (error: unknown) {
    llmSuccess = false;
    llmError = getErrorMessage(error);
    logger.error(
      `[MemoryConsolidation] ${batchLabel} LLM call failed: ${getErrorMessage(error)}`,
    );
  }

  // Use real API-reported usage when available; fall back to heuristic
  const realUsage = result?.usage || null;
  const inputTokens = realUsage
    ? getTotalInputTokens(realUsage)
    : estimateTokens(inputText);
  const outputTokens = realUsage
    ? realUsage.outputTokens || 0
    : result?.text
      ? estimateTokens(result.text)
      : 0;
  RequestLogger.logBackgroundLlmCall({
    requestId: llmRequestId,
    endpoint: endpoint || null,
    operation: "memory:consolidate",
    project,
    username: username || "system",
    agent: agent || null,
    provider: consolidationProvider,
    model: consolidationModel,
    traceId: traceId || null,
    agentConversationId: agentConversationId || null,
    aiMessages: aiMessages as MessagePayload[],
    resultText: result?.text || "",
    usage: realUsage,
    success: llmSuccess,
    errorMessage: llmError,
    requestStartMilliseconds: llmStart,
    extraRequestPayload: {
      trigger,
      batchIndex,
      totalBatches,
      clusterCount,
      staleCount,
    },
  });

  // Broadcast incremental usage with cost
  if (typeof broadcast === "function" && llmSuccess) {
    try {
      const consolidatePricing = getPricing(MODALITY_TYPES.TEXT, MODALITY_TYPES.TEXT)[
        consolidationModel
      ];
      const consolidateCost = consolidatePricing
        ? calculateTextCost(
            realUsage || { inputTokens, outputTokens },
            consolidatePricing,
          )
        : null;
      broadcast({
        type: SERVER_SENT_EVENT_TYPES.USAGE_UPDATE,
        operation: "memory:consolidate",
        usage: {
          requests: 1,
          inputTokens,
          outputTokens,
          estimatedCost: consolidateCost,
        },
      });
    } catch {
      /* SSE channel may be closed */
    }
  }

  if (!llmSuccess || !result?.text) {
    return [];
  }

  // Parse response with enhanced diagnostics
  const parsed = parseJsonFromLargeLanguageModelResponse(result.text) as {
    actions?: ConsolidationAction[];
  } | null;
  if (!parsed) {
    const responseLength = result.text?.length || 0;
    const snippet = result.text?.substring(0, LOG_PREVIEW.LARGE) || "(empty)";
    const tail =
      responseLength > LOG_PREVIEW.LARGE ? result.text.substring(responseLength - LOG_PREVIEW.MEDIUM) : "";
    logger.warn(
      `[MemoryConsolidation] ${batchLabel} Failed to parse LLM response ` +
        `(${responseLength} chars, ~${outputTokens} tokens). ` +
        `Head: ${snippet}${tail ? `\n  Tail: ${tail}` : ""}`,
    );
    return [];
  }

  return parsed.actions || [];
}

// ─── Consolidation Run (lock-protected — see consolidate()) ─────────────────
/**
 * Run memory consolidation for a specific agent within a project.
 * Processes memories in batches to avoid context window overflow.
 */
async function runConsolidation({
  agent = AGENT_IDS.CODING,
  project,
  username,
  profileId,
  trigger = "manual",
  broadcast,
  endpoint,
  traceId,
  agentConversationId,
  guildId,
}: ProfiledConsolidateOptions) {
    const startTime = performance.now();
    const agentId = agent || AGENT_IDS.CODING;
    // One profile per run — consolidation never merges across profiles.
    const runProfileId = resolveProfileId(profileId);
    const persona = AgentPersonaRegistry.get(agentId);
    const agentType = persona?.type || "";
    const isConversational = agentType === "conversational";
    logger.info(
      `[MemoryConsolidation] Starting ${agentType || "general"} consolidation for agent "${agentId}", project "${project}" (trigger: ${trigger})`,
    );

    // Cost guard — check daily budget
    if (!(await canRunToday(project || guildId || "global"))) {
      return { skipped: true, reason: "daily_limit_reached", total: 0 };
    }

    // Load all memories with embeddings (LUPOS needs extra fields)
    const db = MongoWrapper.getDb(MONGO_DB_NAME);
    if (!db) throw new Error("Database not available");

    // Current rows only — soft-closed memories are history, not candidates.
    // Scoped to one profile so a run never clusters/merges across profiles.
    const query: Record<string, unknown> = {
      agent: agentId,
      profileId: profileFilter(runProfileId),
      ...CURRENT_MEMORY_FILTER,
    };
    if (project) query.project = project;
    if (isConversational && guildId) query.guildId = guildId;

    const projection = isConversational
      ? {
          embedding: 1,
          id: 1,
          type: 1,
          title: 1,
          content: 1,
          createdAt: 1,
          aboutUserId: 1,
          aboutUsername: 1,
          sourceUserId: 1,
          sourceUsername: 1,
          guildId: 1,
        }
      : { embedding: 1, id: 1, type: 1, title: 1, content: 1, createdAt: 1 };

    const allMemories = (await db
      .collection(COLLECTIONS.MEMORIES)
      .find(query)
      .project(projection)
      .toArray()) as MemoryDoc[];

    if (allMemories.length < 2) {
      logger.info(
        `[MemoryConsolidation] Only ${allMemories.length} memories — skipping`,
      );
      await resetRunCount(project || guildId || "global");
      return {
        skipped: true,
        reason: "insufficient memories",
        total: allMemories.length,
      };
    }

    logger.info(
      `[MemoryConsolidation] Loaded ${allMemories.length} memories for clustering`,
    );

    // Resolve the consolidation model
    const { provider: consolidationProvider, model: consolidationModel } =
      await getConsolidationConfig();
    const provider = getProvider(consolidationProvider);

    // Build a lookup map for metadata preservation during merges
    const memoryLookup = new Map<string, MemoryDoc>(
      allMemories.map((message) => [message.id, message]),
    );

    const allActions: ConsolidationAction[] = [];
    let batches: ConsolidationBatch[] = [];

    if (isConversational) {
      // ── Conversational Path: partition by (aboutUserId, sourceUserId) ────
      const partitions = partitionConversationalMemories(allMemories);
      logger.info(
        `[MemoryConsolidation] Conversational (${agentId}): ${partitions.size} partitions (unique observer→subject pairs)`,
      );

      for (const [key, memories] of partitions) {
        if (memories.length < 2) continue;

        // Cluster within this partition using the higher conversational threshold
        const partitionClusters = findClusters(
          memories,
          CONVERSATIONAL_CLUSTER_THRESHOLD,
        );
        const partitionStale = findStaleConversationalMemories(memories);

        // ── Release embeddings after clustering ──────────────────────
        // Embeddings (1536-dim float arrays, ~12KB each) are only needed
        // for cosine similarity in findClusters(). Strip them now so
        // GC can reclaim before the LLM batch loop.
        for (const message of memories) {
          message.embedding = null;
        }

        if (partitionClusters.length === 0 && partitionStale.length === 0)
          continue;

        // Extract metadata for the partition header
        const sample = memories[0];
        const partitionMeta: PartitionMeta = {
          aboutUserId: sample.aboutUserId || "",
          aboutUsername: sample.aboutUsername || "",
          sourceUserId: sample.sourceUserId || "",
          sourceUsername: sample.sourceUsername || "",
        };

        // Build batches for this partition
        const partitionBatches = buildBatches(
          partitionClusters,
          partitionStale,
        );
        for (const b of partitionBatches) {
          b.partitionMeta = partitionMeta;
        }
        batches.push(...partitionBatches);

        logger.info(
          `[MemoryConsolidation] Conversational partition ${key}: ${memories.length} memories → ${partitionClusters.length} clusters, ${partitionStale.length} stale`,
        );
      }

      if (batches.length === 0) {
        logger.info(
          `[MemoryConsolidation] Conversational (${agentId}): No consolidation candidates across partitions`,
        );
        await resetRunCount(project || guildId || "global");
        return {
          skipped: true,
          reason: "no candidates",
          total: allMemories.length,
        };
      }

      // Process conversational batches with the conversational-specific prompt
      for (let i = 0; i < batches.length; i++) {
        const batchActions = await processBatch(batches[i], i, batches.length, {
          provider,
          consolidationProvider,
          consolidationModel,
          agent: agentId,
          project: project || null,
          username: username || "system",
          trigger: trigger || "manual",
          endpoint,
          traceId,
          agentConversationId,
          broadcast,
          systemPrompt: CONVERSATIONAL_CONSOLIDATION_PROMPT,
          inputBuilder: buildConversationalBatchInput,
        });
        allActions.push(...batchActions);
      }
    } else {
      // ── Coding / Default Path: original flow ───────────────────────
      const clusters = findClusters(allMemories);

      // ── Release embeddings after clustering ──────────────────────
      // Embeddings (1536-dim float arrays, ~12KB each) are only needed
      // for cosine similarity in findClusters(). Strip them now so
      // GC can reclaim before the LLM batch loop.
      for (const message of allMemories) {
        message.embedding = null;
      }

      logger.info(
        `[MemoryConsolidation] Found ${clusters.length} clusters from ${allMemories.length} memories`,
      );

      const staleMemories = allMemories.filter((message) => {
        const age = daysSince(message.createdAt);
        return (
          age > STALENESS_DAYS &&
          (message.type === "project" || message.type === "reference")
        );
      });
      logger.info(
        `[MemoryConsolidation] Found ${staleMemories.length} stale memories (>${STALENESS_DAYS} days, ephemeral types)`,
      );

      if (clusters.length === 0 && staleMemories.length === 0) {
        logger.info(
          "[MemoryConsolidation] No clusters or stale memories — nothing to consolidate",
        );
        await resetRunCount(project || "global");
        return {
          skipped: true,
          reason: "no candidates",
          total: allMemories.length,
        };
      }

      batches = buildBatches(clusters, staleMemories);
      logger.info(
        `[MemoryConsolidation] Split into ${batches.length} batch(es) ` +
          `(${clusters.length} clusters, ${staleMemories.length} stale)`,
      );

      for (let i = 0; i < batches.length; i++) {
        const batchActions = await processBatch(batches[i], i, batches.length, {
          provider,
          consolidationProvider,
          consolidationModel,
          agent: agentId,
          project: project || null,
          username: username || "system",
          trigger: trigger || "manual",
          endpoint,
          traceId,
          agentConversationId,
          broadcast,
        });
        allActions.push(...batchActions);
      }
    }

    if (allActions.length === 0) {
      logger.info(
        "[MemoryConsolidation] LLM found no actions needed across all batches",
      );
      await resetRunCount(project || guildId || "global");
      return {
        actions: 0,
        summary: "No consolidation needed",
        total: allMemories.length,
      };
    }

    // Sanity cap — abort a runaway batch that would close most of the corpus
    // (a hallucinated merge-everything response must not hide the store).
    const affectedCount = allActions.reduce(
      (sum, action) =>
        sum + (action.type === "merge" ? action.sourceIds?.length || 0 : 1),
      0,
    );
    const maximumAffected = Math.max(
      5,
      Math.ceil(
        allMemories.length * MEMORY.CONSOLIDATION_MAX_AFFECTED_FRACTION,
      ),
    );
    if (affectedCount > maximumAffected) {
      logger.warn(
        `[MemoryConsolidation] Sanity cap: LLM proposed closing ${affectedCount}/${allMemories.length} memories ` +
          `(cap ${maximumAffected}) — aborting run without applying`,
      );
      await resetRunCount(project || guildId || "global");
      return {
        skipped: true,
        reason: "sanity_cap_exceeded",
        proposedActions: allActions.length,
        affectedCount,
        total: allMemories.length,
      };
    }

    // Apply all accumulated actions
    logger.info(
      `[MemoryConsolidation] Applying ${allActions.length} actions from ${batches.length} batch(es)`,
    );
    const results = await applyActions(
      allActions,
      agentId,
      agentType,
      project || null,
      username || "system",
      {
        traceId,
        endpoint,
        memoryLookup: isConversational ? memoryLookup : undefined,
        profileId: runProfileId,
      },
    );
    await resetRunCount(project || guildId || "global");
    const summary = `Merged ${results.merged}, invalidated ${results.deleted} (${batches.length} batches)`;
    const durationMilliseconds = Math.round(performance.now() - startTime);
    logger.info(`[MemoryConsolidation] Complete: ${summary} (${durationMilliseconds}ms)`);

    // Record history for audit trail — closedIds/createdIds power rollbackRun
    await recordHistory(
      project || guildId || "global",
      trigger || "manual",
      allMemories.length,
      allActions,
      summary,
      durationMilliseconds,
      { closedIds: results.closedIds, createdIds: results.createdIds },
    );
    const consolidationResult = {
      ...results,
      actionsApplied: allActions.length,
      batchCount: batches.length,
      summary,
      total: allMemories.length,
      trigger,
      durationMilliseconds,
    };
    // Broadcast to connected clients if callback provided
    if (typeof broadcast === "function") {
      try {
        broadcast({
          type: "memory_consolidation_complete",
          project: project || null,
          ...consolidationResult,
        });
      } catch (error: unknown) {
        logger.warn(
          `[MemoryConsolidation] Broadcast failed: ${getErrorMessage(error)}`,
        );
      }
    }
    return consolidationResult;
}

// ─── Public API ──────────────────────────────────────────────────────────────
const MemoryConsolidationService = {
  /**
   * Lock-protected consolidation entry point. The threshold trigger
   * (checkAndRun) and the 24h AutoDream sweep can race on the same scope —
   * the advisory Mongo lock makes runs single-writer per scope, and the
   * finally guarantees release on every exit path.
   */
  async consolidate(options: ProfiledConsolidateOptions) {
    const lockScope = options.project || options.guildId || "global";
    if (!(await acquireConsolidationLock(lockScope))) {
      return {
        skipped: true,
        reason: "concurrent_run_in_progress",
        total: 0,
      };
    }
    try {
      return await runConsolidation(options);
    } finally {
      await releaseConsolidationLock(lockScope);
    }
  },
  /**
   * Undo a consolidation run: reopen the memories it soft-closed and
   * invalidate the merged documents it created. Possible because
   * applyActions never hard-deletes.
   */
  async rollbackRun(runId: string) {
    const run = await getHistoryRun(runId);
    if (!run) return { rolledBack: false, reason: "run_not_found" };
    if (run.rolledBackAt)
      return { rolledBack: false, reason: "already_rolled_back" };

    const closedIds = (run.closedIds as string[]) || [];
    const createdIds = (run.createdIds as string[]) || [];
    if (closedIds.length === 0 && createdIds.length === 0) {
      return { rolledBack: false, reason: "run_predates_soft_close_history" };
    }

    let reopened = 0;
    for (const id of closedIds) {
      if (await MemoryService.reopen(id)) reopened++;
    }
    let closed = 0;
    for (const id of createdIds) {
      if (await MemoryService.invalidate(id, { reason: "rollback" })) closed++;
    }
    await markRunRolledBack(runId);
    logger.info(
      `[MemoryConsolidation] Rolled back run ${runId}: reopened ${reopened}/${closedIds.length}, ` +
        `closed ${closed}/${createdIds.length} merged docs`,
    );
    return { rolledBack: true, reopened, closedMergedDocs: closed };
  },
  /**
   * Check if consolidation should run and trigger if needed.
   * Called by MemoryExtractor after storing new memories.
   */
  async checkAndRun({
    project,
    username,
    profileId,
    broadcast,
    endpoint,
    agent,
    traceId,
    agentConversationId,
  }: ProfiledCheckAndRunOptions) {
    try {
      // Resolve now, while the request's ALS context is still live — the
      // fire-and-forget consolidate() below may outlive it.
      const runProfileId = resolveProfileId(profileId);
      await incrementRunCount(project || "global");
      const count = await getRunCount(project || "global");
      if (count >= SESSIONS_BETWEEN_RUNS) {
        logger.info(
          `[MemoryConsolidation] Threshold reached (${count}/${SESSIONS_BETWEEN_RUNS}) — triggering`,
        );
        // Fire-and-forget
        MemoryConsolidationService.consolidate({
          agent: agent || AGENT_IDS.CODING,
          project,
          username,
          profileId: runProfileId,
          trigger: "conversation_threshold",
          broadcast,
          endpoint: endpoint || "/agent",
          traceId: traceId || null,
          agentConversationId: agentConversationId || null,
        }).catch((error: Error) =>
          logger.error(
            `[MemoryConsolidation] Background consolidation failed: ${getErrorMessage(error)}`,
          ),
        );
      }
    } catch (error: unknown) {
      logger.error(
        `[MemoryConsolidation] checkAndRun failed: ${getErrorMessage(error)}`,
      );
    }
  },
  async getHistory(project: string, limit: number = 10) {
    return getHistory(project, limit);
  },
};
export default MemoryConsolidationService;
